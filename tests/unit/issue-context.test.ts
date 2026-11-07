import { it, expect, vi, afterEach } from "vitest";
import { parseIssue } from "../../backend/domain";
import { fetchIssue } from "../../backend/workspace/issue";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));

vi.mock("../../backend/github/client", () => ({
  GitHubClient: class {
    api = api;
  },
}));

afterEach(() => {
  api.mockReset();
  vi.unstubAllGlobals();
});

it("retrieves the complete issue and paginated comments plus linked PRs from text and timeline, including fork review context", async () => {
  api.mockImplementation(async (endpoint: string) => {
    if (endpoint === "repos/oppia/oppia/issues/26831")
      return {
        title: "Migration",
        body: "Full body https://github.com/oppia/oppia/pull/10",
        state: "open",
      };
    if (endpoint.includes("issues/26831/comments"))
      return endpoint.endsWith("page=1")
        ? Array.from({ length: 100 }, (_, i) => ({
            id: i,
            body: `Comment ${i}`,
          }))
        : [{ id: 101, body: "Last comment" }];
    if (endpoint.includes("issues/26831/timeline"))
      return [
        {
          source: {
            issue: { html_url: "https://github.com/fork/oppia/pull/11" },
          },
        },
      ];
    if (endpoint === "repos/oppia/oppia/pulls/10" || endpoint === "repos/fork/oppia/pulls/11")
      return {
        title: "Related implementation",
        body: "PR full requirements",
        html_url: `https://github.com/${endpoint.slice(6).replace("pulls", "pull")}`,
        user: { login: "reviewer" },
        base: { ref: "develop" },
        head: { ref: "migration" },
      };
    if (endpoint.includes("/reviews?"))
      return [{ body: "Review feedback", state: "CHANGES_REQUESTED" }];
    if (endpoint.includes("/files?"))
      return [{ filename: "spec.ts", status: "added", additions: 10, deletions: 0 }];
    return [{ body: "PR discussion", user: { login: "author" } }];
  });

  const context = await fetchIssue(
    parseIssue("https://github.com/oppia/oppia/issues/26831"),
    "/tmp",
  );

  expect(context.comments).toHaveLength(101);
  expect(context.comments.at(-1)?.body).toBe("Last comment");
  expect(context.linkedPullRequests).toHaveLength(2);

  expect(context.linkedPullRequests[1]).toMatchObject({
    title: "Related implementation",
    reviews: [{ body: "Review feedback", state: "CHANGES_REQUESTED" }],
    files: [{ filename: "spec.ts", status: "added", additions: 10, deletions: 0 }],
  });

  expect(context.contextWarnings).toEqual([]);
  expect(context.context_fetched_at).toBeTruthy();
});

it("makes unavailable linked context explicit and rejects incomplete issue comments", async () => {
  api.mockImplementation(async (endpoint: string) => {
    if (endpoint.endsWith("issues/1")) return { title: "Issue", body: "Requirements" };
    if (endpoint.includes("/timeline?")) throw new Error("Unavailable");
    return [];
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status: 403 })),
  );

  const context = await fetchIssue(parseIssue("https://github.com/a/b/issues/1"), "/tmp");
  expect(context.contextWarnings[0]).toContain("timeline unavailable");

  api.mockImplementation(async (endpoint: string) => {
    if (endpoint.endsWith("issues/1")) return { title: "Issue", body: "Requirements" };
    throw new Error("Unavailable");
  });

  await expect(fetchIssue(parseIssue("https://github.com/a/b/issues/1"), "/tmp")).rejects.toThrow(
    "403",
  );
});
