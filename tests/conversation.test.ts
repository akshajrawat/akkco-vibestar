import { expect, it } from "vitest";
import { assessActivity, reviewPrompt } from "../backend/scheduled/action";
import type {
  DiscussionEntry,
  PullRequestState,
} from "../backend/scheduled/contracts";

const baseline: PullRequestState = {
  title: "Review monitor",
  body: "Context",
  authenticatedUser: "me",
  author: "me",
  state: "OPEN",
  mergeable: "MERGEABLE",
  reviewDecision: "",
  headRefOid: "sha",
  comments: [],
  reviews: [],
  checks: [],
  discussion: [],
};
const discussion = (
  author: string,
  body: string,
  sequence: number,
  extra: Partial<DiscussionEntry> = {},
): DiscussionEntry => ({
  id: `entry-${sequence}`,
  type: "issue_comment",
  author,
  body,
  createdAt: `2026-10-07T00:00:0${sequence}Z`,
  updatedAt: `2026-10-07T00:00:0${sequence}Z`,
  ...extra,
});
const decide = (
  entries: DiscussionEntry[],
  extra: Partial<PullRequestState> = {},
) =>
  assessActivity(baseline, { ...baseline, discussion: entries, ...extra }, [
    "Initial PR inspection",
  ]);
it.each([
  [
    "question",
    [discussion("reviewer", "Why is this needed?", 1)],
    true,
    "waiting_for_me",
  ],
  [
    "later reply",
    [
      discussion("reviewer", "Please rename this helper.", 1),
      discussion("me", "Done in latest commit.", 2),
    ],
    false,
    "waiting_for_reviewer",
  ],
  [
    "thanks after answer",
    [
      discussion("reviewer", "Why is this needed?", 1),
      discussion("me", "Because this preserves compatibility.", 2),
      discussion("reviewer", "Got it, thanks.", 3),
    ],
    false,
    "waiting_for_reviewer",
  ],
  [
    "second request",
    [
      discussion("reviewer", "Please rename this helper.", 1),
      discussion("me", "Done in latest commit.", 2),
      discussion("reviewer", "Can you also add a test?", 3),
    ],
    true,
    "waiting_for_me",
  ],
  ["LGTM", [discussion("reviewer", "LGTM", 1)], false, "neutral"],
  [
    "bot update",
    [discussion("deploy[bot]", "Preview deployment ready", 1, { bot: true })],
    false,
    "neutral",
  ],
  [
    "mobile tests",
    [discussion("reviewer", "Please run mobile tests and share results.", 1)],
    true,
    "waiting_for_me",
  ],
  [
    "possible breakage",
    [discussion("reviewer", "I think this could break X, can you check?", 1)],
    true,
    "waiting_for_me",
  ],
  [
    "unresolved request",
    [
      discussion("reviewer", "Please add a test.", 1, {
        type: "review_comment",
        threadId: "t",
        resolved: false,
      }),
    ],
    true,
    "waiting_for_me",
  ],
  [
    "resolved thread",
    [
      discussion("reviewer", "Please add a test.", 1, {
        type: "review_comment",
        threadId: "t",
        resolved: true,
      }),
    ],
    false,
    "neutral",
  ],
] as const)(
  "classifies %s chronologically without AI",
  (_name, entries, manualActionRequired, conversationState) => {
    expect(decide([...entries])).toMatchObject({
      analyze: false,
      action: { manualActionRequired, conversationState },
    });
  },
);
it("ignores resolved thread requests even when comment resolution was not copied", () => {
  expect(
    decide(
      [discussion("reviewer", "Please add a test", 1, { threadId: "t" })],
      {
        threads: [
          {
            id: "t",
            path: "file.ts",
            body: "Please add a test",
            resolved: true,
          },
        ],
      },
    ),
  ).toMatchObject({ analyze: false, action: { manualActionRequired: false } });
});
it("does not retain empty requested-change review summaries after all their threads resolve", () => {
  expect(
    decide(
      [
        discussion("reviewer", "", 1, {
          type: "review",
          reviewId: "r",
          reviewState: "CHANGES_REQUESTED",
        }),
        discussion("reviewer", "Please rename this helper", 2, {
          type: "review_comment",
          reviewId: "r",
          threadId: "t",
          resolved: true,
        }),
      ],
      {
        reviewDecision: "CHANGES_REQUESTED",
        threads: [
          {
            id: "t",
            resolved: true,
            path: "file.ts",
            body: "Please rename this helper",
          },
        ],
      },
    ),
  ).toMatchObject({ analyze: false, action: { manualActionRequired: false } });
});
it("treats approval prose without a later request as deterministic", () => {
  expect(
    decide([
      discussion("reviewer", "Great work implementing this", 1, {
        type: "review",
        reviewState: "APPROVED",
      }),
    ]),
  ).toMatchObject({
    analyze: false,
    action: { manualActionRequired: false, conversationState: "approved" },
  });
});
it("does not turn an empty review envelope into a separate request after an author answers its inline feedback", () => {
  expect(
    decide(
      [
        discussion("reviewer", "", 1, {
          type: "review",
          reviewId: "r",
          reviewState: "CHANGES_REQUESTED",
        }),
        discussion("reviewer", "Please rename this helper", 2, {
          type: "review_comment",
          reviewId: "r",
          threadId: "t",
        }),
        discussion("me", "Done in the latest commit", 3, {
          type: "review_comment",
          threadId: "t",
        }),
      ],
      {
        reviewDecision: "CHANGES_REQUESTED",
        threads: [
          {
            id: "t",
            path: "helper.ts",
            body: "Please rename this helper",
            resolved: false,
          },
        ],
      },
    ),
  ).toMatchObject({
    analyze: false,
    action: {
      manualActionRequired: false,
      conversationState: "waiting_for_reviewer",
    },
  });
});
it("asks utility reasoning about an incomplete author response", () => {
  expect(
    decide([
      discussion("reviewer", "Please run mobile tests", 1),
      discussion("me", "Done with desktop tests but could not run mobile", 2),
    ]),
  ).toMatchObject({ analyze: true });
});
it.each([
  "Can we simplify this?",
  "Does this need another test?",
  "Not sure this handles X.",
  "This looks good except...",
])("uses utility reasoning for ambiguous feedback: %s", (body) => {
  expect(decide([discussion("reviewer", body, 1)])).toMatchObject({
    analyze: true,
  });
});
it("an acknowledgment clears an ambiguous author reply", () => {
  expect(
    decide([
      discussion("reviewer", "Please add a test", 1),
      discussion("me", "The existing test covers this case.", 2),
      discussion("reviewer", "Thanks", 3),
    ]),
  ).toMatchObject({ analyze: false, action: { manualActionRequired: false } });
});
it("does not rerun semantic reasoning for only bot activity", () => {
  const previous = {
    ...baseline,
    discussion: [discussion("reviewer", "Can we simplify this?", 1)],
  };
  expect(
    assessActivity(
      previous,
      {
        ...previous,
        discussion: [
          ...previous.discussion,
          discussion("deploy[bot]", "Ready", 2),
        ],
      },
      ["Bot update"],
    ).analyze,
  ).toBe(false);
});
it("does not treat a reply to one thread as an answer in another", () => {
  expect(
    decide([
      discussion("a", "Please add a test", 1, { threadId: "a" }),
      discussion("b", "Please rename this helper", 2, { threadId: "b" }),
      discussion("me", "Done", 3, { threadId: "a" }),
    ]),
  ).toMatchObject({
    action: {
      manualActionRequired: true,
      outstandingRequests: [{ author: "b", sourceId: "entry-2" }],
    },
  });
});
it.each([
  [{ state: "MERGED" }, "merged", false],
  [{ state: "CLOSED" }, "closed", false],
  [{ reviewDecision: "APPROVED" }, "approved", false],
  [
    { checks: [{ name: "mobile", state: "IN_PROGRESS", url: "" }] },
    "waiting_for_ci",
    false,
  ],
  [
    { checks: [{ name: "mobile", state: "FAILURE", url: "" }] },
    "blocked",
    true,
  ],
] as const)(
  "handles deterministic GitHub state %j",
  (state, conversationState, manualActionRequired) => {
    expect(decide([], state as Partial<PullRequestState>)).toMatchObject({
      analyze: false,
      action: { conversationState, manualActionRequired },
    });
  },
);
it("includes authorship, chronology and decision context in the utility prompt", () => {
  const prompt = reviewPrompt(
    {
      ...baseline,
      discussion: [discussion("reviewer", "Can we simplify this?", 1)],
    },
    decide([]).action,
    ["New discussion"],
  );
  expect(prompt).toContain(
    "Does the PR author currently need to take any manual action?",
  );
  expect(prompt).toContain('"authenticatedGitHubUsername":"me"');
  expect(prompt).toContain('"author":"reviewer"');
  expect(prompt).toContain('"previousVibestarDecision"');
  expect(prompt).toContain("New discussion");
});

it("bounds large utility prompts while preserving full history and older unresolved context", () => {
  const entries = Array.from({ length: 1000 }, (_, i) =>
    discussion("reviewer", "Long discussion 🧪".repeat(200), i, {
      createdAt: new Date(i * 1000).toISOString(),
      updatedAt: new Date(i * 1000).toISOString(),
    }),
  );
  entries[0].threadId = "old-thread";
  entries[0].body = "Can we simplify the original helper?";
  entries.at(-1)!.author = "me";
  entries.at(-1)!.body = "Done in the latest commit.";
  const current = {
    ...baseline,
    discussion: entries,
    threads: [
      {
        id: "old-thread",
        resolved: false,
        path: "helper.ts",
        body: entries[0].body,
      },
    ],
    reviews: entries.map((e) => ({
      id: e.id,
      author: e.author,
      body: e.body,
      state: "COMMENTED",
      submitted_at: e.createdAt,
    })),
  };
  const prompt = reviewPrompt(
    current,
    decide([]).action,
    entries.map((e) => e.body),
  );
  expect(Buffer.byteLength(prompt)).toBeLessThan(66000);
  expect(prompt).toContain('"historyTruncated":true');
  expect(prompt).toContain("Can we simplify the original helper?");
  expect(prompt).toContain("Done in the latest commit.");
  expect(current.discussion).toHaveLength(1000);
  expect(current.discussion[500].body).toBe("Long discussion 🧪".repeat(200));
});
