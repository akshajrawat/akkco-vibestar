import { expect, it } from "vitest";

import { discussionEntries, isAcknowledgment } from "../../backend/scheduled/action";
import { prSnapshot } from "../helpers/pr-fixtures";
import type { PullRequestState } from "../../backend/scheduled/contracts";

it("preserves exact source wording, authorship, thread relationships and chronology for current PR analysis", () => {
  const snapshot = structuredClone(prSnapshot);

  snapshot.discussion!.push(
    {
      id: "author-reply",
      type: "review_comment",
      author: "contributor",
      body: "I changed the helper, but have not rerun the test.",
      createdAt: "2026-10-01T11:00:00Z",
      updatedAt: "2026-10-01T11:00:00Z",
      threadId: "thread-1",
      inReplyToId: "review-1",
      path: "spec.ts",
      line: 12,
      resolved: false,
    },
    {
      id: "later-request",
      type: "issue_comment",
      author: "reviewer",
      body: "Please also test the empty draft list.",
      createdAt: "2026-10-02T12:00:00Z",
      updatedAt: "2026-10-02T12:00:00Z",
    },
  );

  const before = structuredClone(snapshot);
  expect(discussionEntries(snapshot)).toEqual(before.discussion);
  expect(snapshot).toEqual(before);

  expect(discussionEntries(snapshot).map((entry) => entry.id)).toEqual([
    "review-1",
    "author-reply",
    "later-request",
  ]);
});

it("reads legacy comments, reviews and thread identities without inferring that resolution proves a code fix", () => {
  const snapshot: PullRequestState = {
    ...prSnapshot,
    discussion: undefined,
    comments: [
      {
        id: "comment",
        author: "contributor",
        body: "Updated the code.",
        updated_at: "later",
      },
    ],
    reviews: [
      {
        id: "review",
        author: "reviewer",
        body: "Please add coverage.",
        state: "CHANGES_REQUESTED",
        submitted_at: "earlier",
      },
    ],
    threads: [
      {
        id: "thread",
        resolved: true,
        path: "spec.ts",
        body: "Test the empty list.",
      },
    ],
  };

  expect(discussionEntries(snapshot)).toMatchObject([
    {
      id: "comment",
      author: "contributor",
      body: "Updated the code.",
      createdAt: "later",
    },
    {
      id: "review",
      reviewState: "CHANGES_REQUESTED",
      body: "Please add coverage.",
      createdAt: "earlier",
    },
    {
      id: "thread",
      threadId: "thread",
      resolved: true,
      path: "spec.ts",
      body: "Test the empty list.",
    },
  ]);
});

it.each([
  ["LGTM", true],
  ["Thanks for the explanation.", true],
  ["Looks good to me!", true],
  ["Looks good, but please add a test.", false],
  ["Why did you change this exploration?", false],
  ["Done in my latest commit.", false],
  ["Thanks, could you also check empty inputs?", false],
])("classifies only a standalone acknowledgment: %s", (body, expected) => {
  expect(isAcknowledgment(body)).toBe(expected);
});

it("retains older unresolved discussion and the complete source set beyond one utility context window", () => {
  const entries = Array.from({ length: 600 }, (_, index) => ({
    id: `source-${index}`,
    type: "issue_comment" as const,
    author: index % 2 ? "contributor" : "reviewer",
    body: `${index === 0 ? "Unresolved original request" : "Later discussion"} ${"context ".repeat(200)}`,
    createdAt: `timestamp-${index}`,
    updatedAt: `timestamp-${index}`,
  }));

  const result = discussionEntries({ ...prSnapshot, discussion: entries });
  expect(result).toHaveLength(600);
  expect(result[0].body).toContain("Unresolved original request");
  expect(result.at(-1)?.id).toBe("source-599");
  expect(result).toEqual(entries);
});
