import { it, expect, vi, afterEach } from "vitest";

import { GitHubClient } from "../../backend/github/client";
import { GitHubMonitor } from "../../backend/scheduled/github";
import { PullRequestStateSchema } from "../../backend/scheduled/contracts";
import { reviewBody } from "../helpers/pr-fixtures";

afterEach(() => vi.restoreAllMocks());

it("rejects a nonadvancing nested reply cursor instead of claiming complete discussion", async () => {
  const { client } = responses({ brokenReplyCursor: true });

  await expect(
    new GitHubMonitor("/tmp", client).inspect(
      "https://github.com/upstream/project/pull/1",
      new AbortController().signal,
    ),
  ).rejects.toThrow("Thread comment pagination did not advance");
});

const sha = "a".repeat(40);

const metadata = {
  node_id: "PR_1",
  title: "PR",
  body: "Original requirements",
  state: "open",
  updated_at: "2026-10-01T10:00:00Z",
  changed_files: 1,
  commits: 1,
  head: {
    ref: "feature",
    sha,
    repo: { full_name: "author/project", node_id: "R_fork" },
  },
  base: {
    ref: "develop",
    sha: "b".repeat(40),
    repo: { full_name: "upstream/project", node_id: "R_upstream" },
  },
};

const inline = (index: number) => ({
  id: index + 1,
  node_id: `C_${index}`,
  body: `Full inline comment ${index}`,
  user: { login: index === 100 ? "author" : "reviewer", node_id: "U_1" },
  created_at: index === 100 ? "2026-10-02T10:00:00Z" : "2026-10-01T10:00:00Z",
  updated_at: "2026-10-02T10:00:00Z",
  html_url: `https://github.com/upstream/project/pull/1#discussion_r${index + 1}`,
  path: "spec.ts",
  line: 20,
  start_line: 18,
  original_line: 10,
  original_start_line: 8,
  side: "RIGHT",
  diff_hunk: "@@ -8,3 +18,3 @@",
  commit_id: sha,
  original_commit_id: "b".repeat(40),
  pull_request_review_id: 5,
  ...(index === 100 ? { in_reply_to_id: 1 } : {}),
});

const responses = (
  options: {
    missingChecks?: boolean;
    missingThreadComment?: boolean;
    stale?: boolean;
    filesCount?: number;
    brokenCursor?: boolean;
    brokenReplyCursor?: boolean;
  } = {},
) => {
  let identityReads = 0;
  const client = new GitHubClient("/tmp");

  const gh = vi.spyOn(client, "gh").mockImplementation(async (args) => {
    if (args[0] === "pr")
      return JSON.stringify({
        title: "PR",
        body: "Original requirements",
        state: "OPEN",
        mergeable: "MERGEABLE",
        reviewDecision: "CHANGES_REQUESTED",
        headRefOid: sha,
        author: { login: "author" },
        statusCheckRollup: [],
      });
    if (args.includes("graphql")) {
      const query = args.find((arg) => arg.startsWith("query=")) || "";
      if (query.includes("node(id:$id)"))
        return JSON.stringify({
          data: {
            node: {
              comments: {
                nodes: [
                  {
                    id: "C_100",
                    body: "Full inline comment 100",
                    author: { login: "author" },
                    createdAt: "2026-10-02T10:00:00Z",
                    updatedAt: "2026-10-02T10:00:00Z",
                    url: "https://github.com/upstream/project/pull/1#discussion_r101",
                  },
                ],
                pageInfo: {
                  hasNextPage: !!options.brokenReplyCursor,
                  endCursor: options.brokenReplyCursor ? "reply-cursor" : null,
                },
              },
            },
          },
        });
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              baseRefOid: "b".repeat(40),
              closingIssuesReferences: {
                nodes: [{ url: "https://github.com/upstream/project/issues/7" }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
              reviewThreads: {
                nodes: [
                  {
                    id: "T_1",
                    isResolved: true,
                    isOutdated: true,
                    path: "spec.ts",
                    line: null,
                    startLine: null,
                    comments: {
                      nodes: Array.from({ length: 100 }, (_, index) => ({
                        id: `C_${index}`,
                        body: `Full inline comment ${index}`,
                      })),
                      pageInfo: {
                        hasNextPage: true,
                        endCursor: "reply-cursor",
                      },
                    },
                  },
                ],
                pageInfo: {
                  hasNextPage: !!options.brokenCursor,
                  endCursor: null,
                },
              },
            },
          },
        },
      });
    }

    const endpoint = args.at(-1)!;

    const page = Number(
      new URL(`https://api.github.com/${endpoint}`).searchParams.get("page") || 1,
    );

    if (endpoint === "user") return JSON.stringify({ login: "author" });
    if (endpoint === "repos/upstream/project/pulls/1") {
      identityReads++;
      return JSON.stringify({
        ...metadata,
        changed_files: options.filesCount || 1,
        ...(options.stale && identityReads === 2
          ? { head: { ...metadata.head, sha: "c".repeat(40) } }
          : {}),
      });
    }

    if (endpoint.includes("/issues/1/comments"))
      return JSON.stringify(
        page === 1
          ? Array.from({ length: 100 }, (_, index) => ({
              id: index,
              node_id: `I_${index}`,
              body: `Multiline issue comment ${index}\nSecond line`,
              user: { login: "reviewer" },
              created_at: "2026-09-30T10:00:00Z",
              updated_at: "2026-10-01T10:00:00Z",
            }))
          : [],
      );
    if (endpoint.includes("/pulls/1/reviews"))
      return JSON.stringify([
        {
          id: 5,
          node_id: "R_5",
          body: reviewBody,
          state: "CHANGES_REQUESTED",
          user: { login: "reviewer" },
          submitted_at: "2026-10-01T10:00:00Z",
          html_url: "https://github.com/upstream/project/pull/1#pullrequestreview-5",
        },
      ]);
    if (endpoint.includes("/pulls/1/comments"))
      return JSON.stringify(
        page === 1
          ? [...Array.from({ length: 100 }, (_, index) => inline(index))]
          : options.missingThreadComment
            ? []
            : [inline(100), inline(100)],
      );
    if (endpoint.includes("/pulls/1/files"))
      return JSON.stringify([
        {
          filename: "spec.ts",
          status: "modified",
          patch: "@@ -1 +1 @@\n-old\n+new",
        },
      ]);
    if (endpoint.includes("/pulls/1/commits"))
      return JSON.stringify([
        {
          sha,
          author: { login: "author" },
          commit: {
            message: "Follow-up",
            author: { date: "2026-10-01T10:00:00Z" },
          },
          html_url: `https://github.com/author/project/commit/${sha}`,
        },
      ]);
    if (endpoint.includes("/check-runs")) {
      if (options.missingChecks) throw new Error("Check pagination unavailable");
      return JSON.stringify({
        check_runs: [
          {
            id: 1,
            name: "tests",
            app: { id: 1 },
            conclusion: "success",
            started_at: "2026-10-01T10:00:00Z",
          },
          {
            id: 2,
            name: "tests",
            app: { id: 2 },
            conclusion: "failure",
            started_at: "2026-10-01T10:00:00Z",
          },
        ],
      });
    }

    if (endpoint.includes("/statuses"))
      return JSON.stringify([
        {
          id: 3,
          context: "external-ci",
          state: "failure",
          created_at: "2026-10-01T10:00:00Z",
        },
      ]);
    if (endpoint === "repos/upstream/project/issues/7")
      return JSON.stringify({
        number: 7,
        title: "Original issue",
        body: "Full original issue requirements",
      });
    if (endpoint.includes("/issues/7/comments"))
      return JSON.stringify([{ id: 1, body: "Complete issue comment" }]);
    throw new Error(`Unexpected endpoint ${endpoint}`);
  });

  return { gh, client };
};

it("retrieves complete reviews/replies, canonical thread identities, original diff coordinates, patches, checks and issue context", async () => {
  const { gh, client } = responses();
  const progress = vi.fn();

  const snapshot = await new GitHubMonitor("/tmp", client).inspect(
    "https://github.com/upstream/project/pull/1",
    new AbortController().signal,
    progress,
  );

  expect(PullRequestStateSchema.safeParse(snapshot).success).toBe(true);
  expect(progress).toHaveBeenCalledWith("Rechecking PR identity");

  expect(progress.mock.calls.some(([phase]) => phase.includes("Reading review threads"))).toBe(
    true,
  );

  expect(snapshot.coverage).toMatchObject({ complete: true, missing: [] });

  expect(snapshot.identity).toMatchObject({
    headRepository: "author/project",
    headBranch: "feature",
    baseBranch: "develop",
  });

  expect(snapshot.discussion?.filter((source) => source.id === "C_100")).toHaveLength(1);

  expect(snapshot.discussion?.find((source) => source.id === "C_100")).toMatchObject({
    inReplyToId: "C_0",
    reviewId: "R_5",
    threadId: "T_1",
    resolved: true,
    outdated: true,
    startLine: 18,
    originalLine: 10,
    originalStartLine: 8,
    diffHunk: "@@ -8,3 +18,3 @@",
  });

  expect(snapshot.reviews[0].body).toBe(reviewBody);
  expect(snapshot.threads?.[0].comments).toHaveLength(101);
  expect(snapshot.files?.[0].patch).toContain("+new");

  expect(snapshot.linkedIssues?.[0]).toMatchObject({
    body: "Full original issue requirements",
    comments: [{ body: "Complete issue comment" }],
  });

  expect(snapshot.checks.filter((check) => check.name === "tests")).toHaveLength(2);
  expect(snapshot.checks.some((check) => check.state === "FAILURE")).toBe(true);

  expect(
    gh.mock.calls.some(([args]) => args.at(-1)?.includes("issues/1/comments?per_page=100&page=2")),
  ).toBe(true);

  expect(gh.mock.calls.some(([args]) => args.includes("cursor=reply-cursor"))).toBe(true);

  expect(
    gh.mock.calls.every(
      ([args]) =>
        args[0] === "pr" ||
        args.includes("GET") ||
        args.some((arg) => arg.startsWith("query=query(")),
    ),
  ).toBe(true);
});

it.each([
  { missingChecks: true },
  { stale: true },
  { filesCount: 3001 },
  { missingThreadComment: true },
])("marks incomplete or unstable context explicitly: %j", async (options) => {
  const { client } = responses(options);

  const snapshot = await new GitHubMonitor("/tmp", client).inspect(
    "https://github.com/upstream/project/pull/1",
    new AbortController().signal,
  );

  expect(snapshot.coverage?.complete).toBe(false);
  expect(snapshot.coverage?.warnings.length).toBeGreaterThan(0);
  expect(snapshot.reviews[0].body).toBe(reviewBody);
  if (options.missingThreadComment)
    expect(snapshot.discussion?.find((source) => source.id === "C_100")?.body).toBe(
      "Full inline comment 100",
    );
});

it("rejects non-advancing review pagination instead of claiming every request was retrieved", async () => {
  const { client } = responses({ brokenCursor: true });

  await expect(
    new GitHubMonitor("/tmp", client).inspect(
      "https://github.com/upstream/project/pull/1",
      new AbortController().signal,
    ),
  ).rejects.toThrow("pagination did not advance");
});

it("reports an exhausted REST pagination limit instead of accepting a truncated collection", async () => {
  const client = new GitHubClient("/tmp");
  vi.spyOn(client, "api").mockResolvedValue(Array.from({ length: 100 }, (_, id) => ({ id })));

  await expect(client.pages("repos/a/b/pulls/1/comments", undefined, 2)).rejects.toThrow(
    "pagination limit reached",
  );
});
