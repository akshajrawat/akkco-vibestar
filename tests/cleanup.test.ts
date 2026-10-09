import { it, expect, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Engine } from "../backend/execution/engine";
import { StorageService } from "../backend/storage/service";
import {
  now,
  defaultSettings,
  type Task,
  type Repository,
} from "../backend/domain";
import { checked, capture } from "../backend/execution/process";
import { exists } from "../backend/workspace/paths";
import { fixtureRepository } from "./fixtures";
import { Scheduler } from "../backend/scheduled/scheduler";
import { GitHubMonitor } from "../backend/scheduled/github";

const preparedTask = async (
  engine: Engine,
  repo: Repository,
  id: string,
  issue = 1,
) => {
  const task: Task = {
    id,
    repo_id: repo.id,
    issue_number: issue,
    issue_url: `https://github.com/fixture/fixture/issues/${issue}`,
    claimed_scope: id,
    notes: "",
    issue: {},
    branch_name: "",
    base_branch: "main",
    base_commit_sha: "",
    worktree_path: "",
    stage: 1,
    status: "cancelled",
    error: null,
    created_at: now(),
    updated_at: now(),
  };
  engine.db.saveTask(task);
  await engine.git.prepare(
    repo,
    task,
    undefined,
    (value) => engine.db.saveTask(value),
    async (record) => {
      engine.db.run(
        "INSERT INTO task_activity(task_id,kind,data,timestamp) VALUES(?,'preparation',?,?)",
        task.id,
        JSON.stringify(record),
        now(),
      );
    },
  );
  engine.db.saveTask(task);
  return task;
};

it("history deletion removes the owned branch and worktree even when worktree cleanup is deselected, preserving other branches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-history-branch-"));
  const engine = await Engine.create(join(dir, "data"));
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const task = await preparedTask(engine, repo, "history");
    await checked("git", ["branch", "akkco/personal"], repo.path);
    const before = await checked(
      "git",
      ["rev-parse", "main", "akkco/personal"],
      repo.path,
    );
    await writeFile(join(task.worktree_path, "source.txt"), "task change\n");
    await new StorageService(engine).cleanupTask(task.id, {
      worktree: false,
      logs: false,
      artifacts: false,
      history: true,
    });
    expect(await exists(task.worktree_path)).toBe(false);
    expect(
      (
        await capture(
          "git",
          ["show-ref", "--verify", "--quiet", `refs/heads/${task.branch_name}`],
          repo.path,
        )
      ).code,
    ).toBe(1);
    expect(
      await checked("git", ["rev-parse", "main", "akkco/personal"], repo.path),
    ).toBe(before);
    expect(engine.db.task(task.id)).toMatchObject({
      worktree_path: "",
      branch_name: "",
      branch_owned: false,
      archived: true,
    });
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(["unregistered", "missing", "detached"])(
  "cleans owned task history when the worktree is %s",
  async (kind) => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-orphan-branch-"));
    const engine = await Engine.create(join(dir, "data"));
    try {
      const { repo } = await fixtureRepository(engine, dir);
      const task = await preparedTask(engine, repo, kind);
      if (kind === "unregistered") {
        await checked(
          "git",
          ["worktree", "remove", "--", task.worktree_path],
          repo.path,
        );
        engine.db.saveTask({ ...task, worktree_path: "" });
      } else if (kind === "missing") {
        await rm(task.worktree_path, { recursive: true, force: true });
      } else {
        await checked(
          "git",
          ["-c", "core.hooksPath=/dev/null", "checkout", "--detach"],
          task.worktree_path,
        );
        await checked(
          "git",
          ["branch", "-D", "--", task.branch_name],
          repo.path,
        );
      }
      await new StorageService(engine).cleanupTask(task.id, {
        worktree: false,
        logs: false,
        artifacts: true,
        history: true,
      });
      expect(engine.db.tasks()).toEqual([]);
      expect(
        (
          await capture(
            "git",
            [
              "show-ref",
              "--verify",
              "--quiet",
              `refs/heads/${task.branch_name}`,
            ],
            repo.path,
          )
        ).code,
      ).toBe(1);
      expect(await exists(task.worktree_path)).toBe(false);
    } finally {
      await engine.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it("does not delete an unowned namespaced branch, a recreated personal branch, or an external checkout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-foreign-branch-"));
  const engine = await Engine.create(join(dir, "data"));
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const task = await preparedTask(engine, repo, "owned");
    const storage = new StorageService(engine);
    await checked("git", ["branch", "akkco/personal"], repo.path);
    const foreign = {
      ...task,
      id: "foreign",
      branch_name: "akkco/personal",
      branch_owned: false,
      worktree_path: "",
    };
    engine.db.saveTask(foreign);
    const options = {
      worktree: false,
      logs: false,
      artifacts: true,
      history: true,
    };
    await expect(storage.cleanupTask(foreign.id, options)).rejects.toThrow(
      "ownership",
    );
    expect(engine.db.task(foreign.id).branch_name).toBe("akkco/personal");
    expect(
      await checked("git", ["rev-parse", "akkco/personal"], repo.path),
    ).toBe(task.base_commit_sha);
    await checked(
      "git",
      ["worktree", "remove", "--", task.worktree_path],
      repo.path,
    );
    const external = join(dir, "external");
    await checked(
      "git",
      ["worktree", "add", "--", external, task.branch_name],
      repo.path,
    );
    await expect(storage.cleanupTask(task.id, options)).rejects.toThrow(
      "outside its assigned worktree",
    );
    expect(await exists(join(external, "source.txt"))).toBe(true);
    await checked("git", ["worktree", "remove", "--", external], repo.path);
    await checked("git", ["branch", "-D", "--", task.branch_name], repo.path);
    await checked("git", ["branch", task.branch_name], repo.path);
    await expect(storage.cleanupTask(task.id, options)).rejects.toThrow(
      "ownership",
    );
    expect(
      await checked("git", ["rev-parse", task.branch_name], repo.path),
    ).toBe(task.base_commit_sha);
    expect(engine.db.task(task.id).branch_name).toBe(task.branch_name);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("deletes history after preparation left only a checkpoint and no Git resources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-empty-preparation-"));
  const engine = await Engine.create(join(dir, "data"));
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const task = await preparedTask(engine, repo, "checkpoint");
    await checked(
      "git",
      ["worktree", "remove", "--", task.worktree_path],
      repo.path,
    );
    await checked("git", ["branch", "-D", "--", task.branch_name], repo.path);
    engine.db.run("DELETE FROM task_activity WHERE task_id=?", task.id);
    engine.db.saveTask({ ...task, branch_owned: false });
    const refs = await checked("git", ["show-ref"], repo.path);
    await new StorageService(engine).cleanupTask(task.id, {
      worktree: false,
      logs: false,
      artifacts: true,
      history: true,
    });
    expect(engine.db.tasks()).toEqual([]);
    expect(await checked("git", ["show-ref"], repo.path)).toBe(refs);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("accepts a successful legacy creation record but never treats the branch prefix alone as ownership", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-legacy-branch-"));
  const engine = await Engine.create(join(dir, "data"));
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const task = await preparedTask(engine, repo, "legacy");
    await checked(
      "git",
      ["config", "--unset", `branch.${task.branch_name}.vibestarTask`],
      repo.path,
    );
    engine.db.saveTask({ ...task, branch_owned: undefined });
    await new StorageService(engine).cleanupTask(task.id, {
      worktree: false,
      logs: false,
      artifacts: true,
      history: true,
    });
    expect(engine.db.tasks()).toEqual([]);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("preserves a personal branch recreated under a legacy task's branch name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-legacy-recreated-"));
  const engine = await Engine.create(join(dir, "data"));
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const task = await preparedTask(engine, repo, "legacy-recreated");
    engine.db.saveTask({ ...task, branch_owned: undefined });
    await checked(
      "git",
      ["worktree", "remove", "--", task.worktree_path],
      repo.path,
    );
    await checked("git", ["branch", "-D", "--", task.branch_name], repo.path);
    await checked("git", ["branch", task.branch_name, "main"], repo.path);
    await expect(
      new StorageService(engine).cleanupTask(task.id, {
        worktree: false,
        logs: false,
        artifacts: true,
        history: true,
      }),
    ).rejects.toThrow("ownership");
    expect(
      await checked("git", ["rev-parse", task.branch_name], repo.path),
    ).toBe(task.base_commit_sha);
    expect(engine.db.task(task.id).branch_name).toBe(task.branch_name);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

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
