import { it, expect, vi } from "vitest";
import { Database } from "../../backend/storage/database";
import { GitHubClient } from "../../backend/github/client";
import { GitHubService } from "../../backend/github/service";
import { Scheduler } from "../../backend/scheduled/scheduler";
import { GitHubMonitor } from "../../backend/scheduled/github";
import type { GitHubRepository } from "../../backend/github/contracts";
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
it("syncs authored upstream PRs, keeps catalog separate from clones, preserves pauses and archives confirmed closures", async () => {
  vi.useFakeTimers();
  const db = new Database(":memory:");
  const engine = {
    root: "/tmp",
    assertAvailable: vi.fn(),
    trackActivity: vi.fn(() => vi.fn()),
    isExecuting: vi.fn(() => false),
    db,
    changed: vi.fn(),
    publish: vi.fn(),
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
  vi.spyOn(service.client, "pages").mockResolvedValue([repository("viewer/repo", "upstream/repo")]);
  const authored = vi.spyOn(service.client, "authored").mockResolvedValue([
    {
      html_url: "https://github.com/upstream/repo/pull/42",
      number: 42,
      title: "OSS contribution",
      updated_at: "now",
    },
  ]);
  const api = vi.spyOn(service.client, "api").mockResolvedValue({
    head: { ref: "branch", repo: { full_name: "viewer/repo" } },
    state: "open",
    merged: false,
  });
  try {
    await service.sync();
    expect(service.prs()[0].repository).toBe("upstream/repo");
    expect(service.catalog()).toHaveLength(1);
    expect(db.repositories()).toEqual([]);
    expect(scheduler.jobs()).toHaveLength(1);
    scheduler.add({
      url: service.prs()[0].url,
      task_id: null,
      interval_minutes: 60,
    });
    expect(scheduler.jobs()[0].enabled).toBe(false);
    scheduler.setEnabled(scheduler.jobs()[0].id, false);
    await service.sync();
    expect(scheduler.jobs()).toHaveLength(1);
    expect(scheduler.jobs()[0].enabled).toBe(false);
    authored.mockResolvedValue([]);
    api.mockResolvedValue({ state: "closed", merged: true });
    await service.sync();
    expect(service.prs()[0].state).toBe("MERGED");
    expect(scheduler.jobs()[0].archived).toBe(true);
    authored.mockResolvedValue([
      {
        html_url: "https://github.com/upstream/repo/pull/42",
        number: 42,
        title: "Reopened",
        updated_at: "later",
      },
    ]);
    api.mockResolvedValue({
      head: { ref: "branch", repo: { full_name: "viewer/repo" } },
      state: "open",
      merged: false,
    });
    await service.sync();
    expect(scheduler.jobs()[0]).toMatchObject({
      archived: false,
      enabled: false,
    });
    const before = service.snapshot();
    vi.mocked(service.client.pages).mockResolvedValue([]);
    authored.mockResolvedValue([
      {
        html_url: "https://github.com/upstream/repo/pull/43",
        number: 43,
        title: "New",
        updated_at: "later",
      },
      {
        html_url: "https://github.com/upstream/repo/pull/44",
        number: 44,
        title: "Unavailable",
        updated_at: "later",
      },
    ]);
    api
      .mockResolvedValueOnce({
        head: { ref: "new", repo: { full_name: "viewer/repo" } },
        state: "closed",
        merged: true,
      })
      .mockRejectedValueOnce(new Error("GitHub rate limit reached"));
    await service.sync();
    expect(service.prs()).toEqual(expect.arrayContaining(before.pull_requests));
    expect(service.prs().find((pr) => pr.number === 44)).toMatchObject({
      state: "UNKNOWN",
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
    expect(scheduler.jobs()).toHaveLength(2);
    expect(db.all("SELECT * FROM ai_usage")).toEqual([]);
  } finally {
    await service.close();
    await scheduler.close();
    db.close();
    vi.useRealTimers();
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
it("paginates repository catalogs instead of limiting them to 100", async () => {
  const client = new GitHubClient("/tmp");
  const api = vi
    .spyOn(client, "api")
    .mockResolvedValueOnce(Array.from({ length: 100 }, (_, id) => ({ id })))
    .mockResolvedValueOnce([{ id: 100 }]);
  expect(await client.pages("user/repos")).toHaveLength(101);
  expect(api.mock.calls[1][0]).toContain("page=2");
});

it("refuses truncated or duplicate authored PR pages instead of advancing partial discovery", async () => {
  const client = new GitHubClient("/tmp");
  const items = Array.from({ length: 100 }, (_, i) => ({
    html_url: `https://github.com/upstream/repo/pull/${i + 1}`,
    number: i + 1,
    title: "Contribution",
    updated_at: "now",
  }));
  const api = vi
    .spyOn(client, "api")
    .mockResolvedValueOnce({
      total_count: 101,
      incomplete_results: false,
      items,
    })
    .mockResolvedValueOnce({
      total_count: 101,
      incomplete_results: false,
      items: [items[0]],
    });
  await expect(client.authored("viewer")).rejects.toThrow(/truncated/);
  expect(api.mock.calls[1][0]).toContain("page=2");
  api
    .mockResolvedValueOnce({
      total_count: 101,
      incomplete_results: false,
      items,
    })
    .mockResolvedValueOnce({
      total_count: 101,
      incomplete_results: false,
      items: [
        {
          ...items[0],
          html_url: "https://github.com/upstream/repo/pull/101",
          number: 101,
        },
      ],
    });
  expect(await client.authored("viewer")).toHaveLength(101);
});

it("advances persisted bounded PR detail pages and preserves authoritative unknown state without inference", async () => {
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
  const scheduler = new Scheduler(engine);
  let service = new GitHubService(engine, scheduler);
  const found = Array.from({ length: 501 }, (_, i) => ({
    html_url: "https://github.com/upstream/repo/pull/" + (i + 1),
    number: i + 1,
    title: "Contribution " + (i + 1),
    updated_at: "2026-10-25T00:00:00Z",
  }));
  const configure = () => {
    vi.spyOn(service.client, "detect").mockResolvedValue({
      installed: true,
      connected: true,
      username: "viewer",
      version: "fixture",
      error: null,
    });
    vi.spyOn(service.client, "pages").mockResolvedValue([]);
    const authored = vi.spyOn(service.client, "authored").mockResolvedValue(found);
    const api = vi.spyOn(service.client, "api").mockImplementation(async () => ({
      state: "open",
      merged: false,
      head: {
        ref: "feature",
        sha: "a".repeat(40),
        repo: { full_name: "viewer/repo" },
      },
    }));
    return { authored, api };
  };
  try {
    configure();
    await service.sync();
    expect(service.prs()).toHaveLength(500);
    expect(service.snapshot()).toMatchObject({
      last_sync: null,
      error: expect.stringContaining("Partial refresh"),
    });
    await service.close();
    service = new GitHubService(engine, scheduler);
    const { authored, api } = configure();
    await service.sync();
    expect(api).toHaveBeenCalledTimes(1);
    expect(service.prs()).toHaveLength(501);
    const saved = service.prs()[0];
    authored.mockResolvedValue([]);
    api.mockRejectedValueOnce(new Error("Not accessible"));
    await service.sync();
    expect(service.prs().find((pr) => pr.url === saved.url)).toMatchObject({
      state: "UNKNOWN",
      last_known_state: "OPEN",
      access_error: "Not accessible",
    });
    expect(scheduler.jobs()).toHaveLength(501);
    expect(db.all("SELECT * FROM ai_usage")).toEqual([]);
  } finally {
    await service.close();
    await scheduler.close();
    db.close();
    vi.restoreAllMocks();
  }
});
