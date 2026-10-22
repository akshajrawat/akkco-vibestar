import { it, expect, vi } from "vitest";
import { Database } from "../backend/storage/database";
import { GitHubClient } from "../backend/github/client";
import { GitHubService } from "../backend/github/service";
import { Scheduler } from "../backend/scheduled/scheduler";
import { GitHubMonitor } from "../backend/scheduled/github";
import type { GitHubRepository } from "../backend/github/contracts";
import type { Engine } from "../backend/execution/engine";
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
  vi.spyOn(service.client, "pages").mockResolvedValue([
    repository("viewer/repo", "upstream/repo"),
  ]);
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
    expect(scheduler.jobs()).toHaveLength(0);
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
      repository(
        name,
        name.startsWith("viewer") ? "unrelated/repo" : undefined,
      ),
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
