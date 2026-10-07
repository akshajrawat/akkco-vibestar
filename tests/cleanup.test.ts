import { it, expect, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Engine } from "../backend/execution/engine";
import { StorageService } from "../backend/storage/service";
import { now, defaultSettings, type Task } from "../backend/domain";
import { fixtureRepository } from "./fixtures";
import { Scheduler } from "../backend/scheduled/scheduler";
import { GitHubMonitor } from "../backend/scheduled/github";

it("task deletion ignores unrelated scans but reports its own terminal and linked review activity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-cleanup-scope-"));
  const engine = await Engine.create(join(dir, "data"));
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const task: Task = {
      id: "cleanup-task",
      repo_id: repo.id,
      issue_number: 26829,
      issue_url: "https://github.com/fixture/fixture/issues/26829",
      claimed_scope: "",
      notes: "",
      issue: {},
      branch_name: "",
      base_branch: "main",
      base_commit_sha: "",
      worktree_path: "",
      stage: 1,
      status: "cancelled",
      error: "Run cancelled",
      created_at: now(),
      updated_at: now(),
    };
    engine.db.saveTask(task);
    const releaseScan = engine.trackActivity(
      {
        id: "github-sync",
        kind: "github_sync",
        label: "GitHub PR watch sync is running",
        stoppable: true,
      },
      async () => releaseScan(),
    );
    const storage = new StorageService(engine);
    await expect(storage.clear("logs")).rejects.toMatchObject({
      kind: "busy",
      context: {
        blockers: [
          { id: "github-sync", label: "GitHub PR watch sync is running" },
        ],
      },
    });
    const releaseTerminal = engine.acquireTerminal(task.id);
    expect(engine.cleanupBlockers(task.id)).toMatchObject([
      { kind: "terminal", label: "Task #26829 terminal session is open" },
    ]);
    await expect(
      storage.cleanupTask(task.id, {
        worktree: false,
        logs: true,
        artifacts: false,
        history: false,
      }),
    ).rejects.toMatchObject({ kind: "busy" });
    releaseTerminal();
    const releaseReview = engine.trackActivity(
      {
        id: "pr-watch:linked",
        kind: "pr_watch",
        task_id: task.id,
        label: "Linked PR inspection is running",
        stoppable: true,
      },
      async () => releaseReview(),
    );
    await expect(
      storage.cleanupTask(task.id, {
        worktree: false,
        logs: true,
        artifacts: false,
        history: false,
      }),
    ).rejects.toMatchObject({
      context: { blockers: [{ id: "pr-watch:linked" }] },
    });
    await engine.stopActivity("pr-watch:linked");
    expect(engine.cleanupBlockers(task.id)).toEqual([]);
    await storage.cleanupTask(task.id, {
      worktree: false,
      logs: true,
      artifacts: false,
      history: false,
    });
    expect(engine.db.task(task.id).archived).toBe(true);
    expect(engine.cleanupBlockers()).toMatchObject([{ id: "github-sync" }]);
    await engine.stopActivity("github-sync");
    expect(engine.cleanupBlockers()).toEqual([]);
    await storage.clear("logs");
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("maintenance reserves only its task and always releases its lease on failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-maintenance-"));
  const engine = await Engine.create(join(dir, "data"));
  try {
    await expect(
      engine.withTaskMaintenance("one", async () => {
        expect(engine.cleanupBlockers("one")).toMatchObject([
          { kind: "maintenance" },
        ]);
        expect(engine.cleanupBlockers("two")).toEqual([]);
        expect(() =>
          engine.trackActivity(
            {
              id: "linked",
              kind: "pr_watch",
              task_id: "one",
              label: "Review",
              stoppable: true,
            },
            async () => {},
          ),
        ).toThrow("cleanup is running");
        await expect(
          engine.withStorageMaintenance(async () => {}),
        ).rejects.toMatchObject({ kind: "busy" });
        throw new Error("fixture failure");
      }),
    ).rejects.toThrow("fixture failure");
    expect(engine.cleanupBlockers()).toEqual([]);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("cancelled repository discovery releases activity and preserves the previous index", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-scan-stop-"));
  const engine = await Engine.create(join(dir, "data"));
  try {
    const source = join(dir, "source");
    await mkdir(source);
    engine.db.saveSettings({
      ...defaultSettings,
      repository_discovery: { roots: [source], max_depth: 4, scan_home: false },
    });
    await engine.repositoryIndex.scan();
    const previous = engine.repositoryIndex.snapshot();
    const scan = engine.repositoryIndex.scan();
    expect(engine.cleanupBlockers()).toMatchObject([
      { id: "repository-scan", label: "Repository scan is active" },
    ]);
    const rejected = expect(scan).rejects.toThrow();
    await engine.stopActivity("repository-scan");
    await rejected;
    expect(engine.repositoryIndex.snapshot()).toEqual(previous);
    expect(engine.cleanupBlockers()).toEqual([]);
    await writeFile(join(engine.root, "cache", "preserved"), "cache");
    await new StorageService(engine).clear("logs");
    expect(
      await readFile(join(engine.root, "cache", "preserved"), "utf8"),
    ).toBe("cache");
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("stopping a PR inspection aborts and pauses it, releasing its live blocker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-watch-stop-"));
  const engine = await Engine.create(join(dir, "data"));
  const monitor = new GitHubMonitor(dir);
  vi.spyOn(monitor, "inspect").mockImplementation(
    async (_url, signal) =>
      new Promise((_resolve, reject) =>
        signal!.addEventListener(
          "abort",
          () => reject(new Error("Inspection stopped")),
          { once: true },
        ),
      ),
  );
  const scheduler = new Scheduler(engine, monitor);
  try {
    const job = scheduler.add({
      url: "https://github.com/fixture/fixture/pull/1",
      task_id: null,
      interval_minutes: 60,
    });
    const tick = scheduler.tick();
    expect(engine.cleanupBlockers()).toMatchObject([
      { id: `pr-watch:${job.id}` },
    ]);
    await engine.stopActivity(`pr-watch:${job.id}`);
    await tick;
    expect(scheduler.jobs()[0].enabled).toBe(false);
    expect(engine.cleanupBlockers()).toEqual([]);
  } finally {
    await scheduler.close();
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("a stopped semantic analysis cannot start a subsequent verification run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-verification-stop-"));
  const engine = await Engine.create(join(dir, "data"));
  const scheduler = new Scheduler(engine);
  try {
    const job = scheduler.add({
      url: "https://github.com/fixture/fixture/pull/1",
      task_id: null,
      interval_minutes: 60,
    });
    const controller = new AbortController();
    const utility = vi
      .spyOn(engine.utility, "run")
      .mockImplementation(async () => {
        controller.abort();
        return {};
      });
    await expect(
      engine.analyzeScheduled(
        null,
        "Review context",
        true,
        job.id,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(utility).toHaveBeenCalledOnce();
    expect(engine.db.all("SELECT * FROM ai_usage")).toEqual([]);
    expect(engine.cleanupBlockers()).toEqual([]);
  } finally {
    await scheduler.close();
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});
