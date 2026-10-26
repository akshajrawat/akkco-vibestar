import { it, expect, vi, afterEach } from "vitest";
import { parseIssue } from "../../backend/domain";
import { fetchIssue } from "../../backend/workspace/issue";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFixtureEngine,
  fixtureRepository,
  FixtureProvider,
  finishFixtureTask,
} from "../helpers/fixtures";
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

it("refreshes legacy fetched issue context before every approved provider stage", async () => {
  api.mockImplementation(async (endpoint: string) => {
    if (endpoint === "repos/fixture/fixture/issues/1")
      return { title: "Updated issue", body: "Complete current requirements" };
    if (endpoint.includes("/comments?")) return [{ body: "Latest author comment" }];
    return [];
  });
  const dir = await mkdtemp(join(tmpdir(), "vibestar-context-refresh-"));
  const engine = await createFixtureEngine(join(dir, "data"), () => new FixtureProvider());
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const task = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/1"),
      "Task A",
      "",
      { title: "Old fetched issue", number: 1, comments: [] },
    );
    await finishFixtureTask(engine, task.id, (s) => s === "ready_for_review" || s === "failed");
    expect(engine.db.task(task.id).status).toBe("ready_for_review");
    expect(engine.db.detail(task.id).runs).toHaveLength(4);
    for (const run of engine.db.detail(task.id).runs)
      expect(run.prompt).toContain("Latest author comment");
    expect(
      api.mock.calls.filter(([endpoint]) => endpoint === "repos/fixture/fixture/issues/1"),
    ).toHaveLength(4);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

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
