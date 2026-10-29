import { it, expect, vi } from "vitest";

import { Database } from "../../backend/storage/database";
import { GitHubClient } from "../../backend/github/client";
import { GitHubService } from "../../backend/github/service";
import { Scheduler } from "../../backend/scheduled/scheduler";
import { GitHubMonitor } from "../../backend/scheduled/github";
import type { GitHubRepository, GitHubPullRequest } from "../../backend/github/contracts";
import type { Engine } from "../../backend/execution/engine";

const repository = (full_name: string, parent?: string): GitHubRepository => ({
  id: full_name.includes("viewer") ? 2 : 1,
  full_name,
  owner: { login: full_name.split("/")[0], type: "User" },
  name: "repo",
  description: null,
  default_branch: "develop",
  private: false,
  fork: !!parent,
  clone_url: `https://github.com/${full_name}.git`,
  updated_at: "now",
  ...(parent
    ? {
        parent: {
          full_name: parent,
          clone_url: `https://github.com/${parent}.git`,
          default_branch: "develop",
        },
      }
    : {}),
});

const contribution = (number: number, state = "OPEN"): GitHubPullRequest => ({
  url: `https://github.com/upstream/repo/pull/${number}`,
  repository: "upstream/repo",
  number,
  title: `Contribution ${number}`,
  state,
  draft: false,
  head_sha: "a".repeat(40),
  head_branch: "feature",
  head_repository: "viewer/repo",
  updated_at: "2026-10-25T00:00:00Z",
  task_id: null,
});

it("refreshes all PR lifecycles in bulk without repository reads or inference, and confirms missing identities", async () => {
  const db = new Database(":memory:");

  const engine = {
    root: "/tmp",
    db,
    assertAvailable: vi.fn(),
    changed: vi.fn(),
    publish: vi.fn(),
    trackActivity: vi.fn(() => vi.fn()),
    isExecuting: () => false,
    isActive: () => false,
    cancel: vi.fn(),
  } as unknown as Engine;

  const scheduler = new Scheduler(engine, new GitHubMonitor("/tmp"));
  const service = new GitHubService(engine, scheduler);

  vi.spyOn(service.client, "detect").mockResolvedValue({
    installed: true,
    connected: true,
    username: "viewer",
    version: "gh",
    error: null,
  });

  const pages = vi.spyOn(service.client, "pages").mockResolvedValue([repository("viewer/repo")]);

  const api = vi
    .spyOn(service.client, "api")
    .mockRejectedValue(new Error("Unexpected per-PR REST call"));

  const found = Array.from({ length: 24 }, (_, index) =>
    contribution(index + 1, ["OPEN", "MERGED", "CLOSED"][index % 3]),
  );

  const authored = vi.spyOn(service.client, "authored").mockResolvedValue(found);
  const known = vi.spyOn(service.client, "pullRequests").mockResolvedValue([]);
  try {
    await service.refreshPullRequests();
    expect(service.prs()).toHaveLength(24);
    expect(service.prs().filter((pr) => pr.state === "OPEN")).toHaveLength(8);
    expect(service.prs().filter((pr) => pr.state === "MERGED")).toHaveLength(8);
    expect(service.prs().filter((pr) => pr.state === "CLOSED")).toHaveLength(8);
    expect(authored).toHaveBeenCalledTimes(1);
    expect(pages).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
    expect(known).not.toHaveBeenCalled();
    expect(db.repositories()).toEqual([]);
    expect(service.prs()[0].refreshed_at).toBeTruthy();
    expect(scheduler.jobs()).toHaveLength(24);
    expect(scheduler.jobs().every((job) => !job.enabled)).toBe(true);
    await service.sync();
    expect(service.catalog()).toHaveLength(1);
    authored.mockResolvedValue(found.slice(1));
    known.mockResolvedValue([contribution(1, "MERGED")]);
    await service.refreshPullRequests();
    expect(known).toHaveBeenCalledWith([found[0].url], expect.any(AbortSignal));
    expect(service.prs().find((pr) => pr.number === 1)?.state).toBe("MERGED");
    expect(scheduler.jobs().find((job) => job.url === found[0].url)?.archived).toBe(true);
    authored.mockResolvedValue(found);
    await service.refreshPullRequests();
    expect(scheduler.jobs().find((job) => job.url === found[0].url)?.archived).toBe(false);
    const before = service.snapshot();
    authored.mockResolvedValue(found.slice(1));
    known.mockRejectedValue(new Error("GitHub rate limit reached"));
    await service.refreshPullRequests();

    expect(service.prs().find((pr) => pr.number === 1)).toMatchObject({
      state: "UNKNOWN",
      last_known_state: "OPEN",
      access_error: "GitHub rate limit reached",
    });

    expect(service.catalog()).toEqual(before.repositories);

    expect(service.snapshot()).toMatchObject({
      last_sync: before.last_sync,
      error: "GitHub rate limit reached",
      phase: null,
    });

    const reopened = new GitHubService(engine, scheduler);

    expect(reopened.snapshot()).toMatchObject({
      last_sync: before.last_sync,
      error: "GitHub rate limit reached",
    });

    await reopened.close();
    expect(db.all("SELECT * FROM ai_usage")).toEqual([]);
  } finally {
    await service.close();
    await scheduler.close();
    db.close();
    vi.restoreAllMocks();
  }
});

it("uses proven fork parents and refuses a same-name unrelated fork", async () => {
  const db = new Database(":memory:");

  const engine = {
    root: "/tmp",
    trackActivity: vi.fn(() => vi.fn()),
    isExecuting: vi.fn(() => false),
    db,
    changed: vi.fn(),
  } as unknown as Engine;

  const service = new GitHubService(engine, new Scheduler(engine));

  vi.spyOn(service.client, "detect").mockResolvedValue({
    installed: true,
    connected: true,
    username: "viewer",
    version: "gh",
    error: null,
  });

  const metadata = vi
    .spyOn(service.client, "repository")
    .mockImplementation(async (name) =>
      repository(name, name.startsWith("viewer") ? "unrelated/repo" : undefined),
    );

  try {
    expect((await service.resolve("upstream/repo")).origin_url).toBeNull();

    metadata.mockImplementation(async (name) =>
      repository(name, name.startsWith("viewer") ? "upstream/repo" : undefined),
    );

    expect(await service.resolve("upstream/repo")).toMatchObject({
      upstream_url: "https://github.com/upstream/repo.git",
      origin_url: "https://github.com/viewer/repo.git",
      base_branch: "develop",
    });
  } finally {
    await service.close();
    db.close();
  }
});

it.each(["viewer/repo", "organization/repo"])(
  "prefers the verified writable source %s instead of looking for a fork",
  async (name) => {
    const db = new Database(":memory:");
    const engine = { root: "/tmp", db, changed: vi.fn() } as unknown as Engine;
    const service = new GitHubService(engine, new Scheduler(engine));

    vi.spyOn(service.client, "detect").mockResolvedValue({
      installed: true,
      connected: true,
      username: "viewer",
      version: "gh",
      error: null,
    });

    const metadata = vi
      .spyOn(service.client, "repository")
      .mockResolvedValue({ ...repository(name), permissions: { push: true } });

    try {
      expect(await service.resolve(name)).toMatchObject({
        upstream_url: `https://github.com/${name}.git`,
        origin_url: null,
      });

      expect(metadata).toHaveBeenCalledTimes(1);
    } finally {
      await service.close();
      db.close();
    }
  },
);

it("paginates repository catalogs instead of limiting them to 100", async () => {
  const client = new GitHubClient("/tmp");

  const api = vi
    .spyOn(client, "api")
    .mockResolvedValueOnce(Array.from({ length: 100 }, (_, id) => ({ id })))
    .mockResolvedValueOnce([{ id: 100 }]);

  expect(await client.pages("user/repos")).toHaveLength(101);
  expect(api.mock.calls[1][0]).toContain("page=2");
});

const node = (number: number) => ({
  url: `https://github.com/upstream/repo/pull/${number}`,
  number,
  title: "Contribution",
  state: "OPEN",
  isDraft: false,
  updatedAt: "2026-10-25T00:00:00Z",
  headRefName: "feature",
  headRefOid: "a".repeat(40),
  headRepository: { nameWithOwner: "viewer/repo" },
  repository: { nameWithOwner: "upstream/repo" },
});

const page = (nodes: ReturnType<typeof node>[], count: number, cursor: string | null = null) =>
  JSON.stringify({
    data: {
      search: {
        issueCount: count,
        nodes,
        pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
      },
    },
  });

it("retrieves 501 PR statuses in six metadata pages without per-PR detail requests", async () => {
  const client = new GitHubClient("/tmp");
  const gh = vi.spyOn(client, "gh");
  const nodes = Array.from({ length: 501 }, (_, i) => node(i + 1));
  for (let offset = 0; offset < nodes.length; offset += 100)
    gh.mockResolvedValueOnce(
      page(nodes.slice(offset, offset + 100), 501, offset < 500 ? `cursor-${offset}` : null),
    );
  expect(await client.authored("viewer")).toHaveLength(501);
  expect(gh).toHaveBeenCalledTimes(6);
  expect(gh.mock.calls.every(([args]) => args.includes("graphql"))).toBe(true);
  expect(gh.mock.calls[1][0]).toContain("cursor=cursor-0");
});

it("refuses truncated, duplicate or stalled authored PR pages", async () => {
  const client = new GitHubClient("/tmp");
  const gh = vi.spyOn(client, "gh");
  const nodes = Array.from({ length: 100 }, (_, i) => node(i + 1));
  gh.mockResolvedValueOnce(page(nodes, 101, "next")).mockResolvedValueOnce(page([nodes[0]], 101));
  await expect(client.authored("viewer")).rejects.toThrow(/truncated or duplicated/);

  gh.mockResolvedValueOnce(page(nodes, 101, "next")).mockResolvedValueOnce(
    page([node(101)], 101, "next"),
  );

  await expect(client.authored("viewer")).rejects.toThrow(/did not advance/);
  gh.mockResolvedValueOnce(page(nodes, 101));
  await expect(client.authored("viewer")).rejects.toThrow(/truncated/);
});

it("batches known missing PR identities and refuses inaccessible or mismatched results", async () => {
  const client = new GitHubClient("/tmp");
  const gh = vi.spyOn(client, "gh");
  const urls = Array.from({ length: 26 }, (_, i) => node(i + 1).url);

  gh.mockResolvedValueOnce(
    JSON.stringify({
      data: Object.fromEntries(
        urls.slice(0, 25).map((_, i) => [`p${i}`, { pullRequest: node(i + 1) }]),
      ),
    }),
  );

  gh.mockResolvedValueOnce(
    JSON.stringify({ data: { p0: { pullRequest: { ...node(26), state: "MERGED" } } } }),
  );

  const found = await client.pullRequests(urls);
  expect(found).toHaveLength(26);
  expect(found[25].state).toBe("MERGED");
  expect(gh).toHaveBeenCalledTimes(2);
  gh.mockResolvedValueOnce(JSON.stringify({ data: { p0: null } }));
  await expect(client.pullRequests([urls[0]])).rejects.toThrow(/lifecycle is unknown/);
  gh.mockResolvedValueOnce(JSON.stringify({ data: { p0: { pullRequest: node(2) } } }));
  await expect(client.pullRequests([urls[0]])).rejects.toThrow(/different PR/);
});
