import { lstat, readdir, realpath, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AdeError, now } from "../domain";
import type { Engine } from "../execution/engine";
import { checked } from "../execution/process";
import { inside, exists } from "../workspace/paths";

const directorySize = async (path: string): Promise<number> => {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) return entry.size;
    if (!entry.isDirectory()) return entry.size;
    let size = 0;
    for (const name of await readdir(path))
      size += await directorySize(join(path, name));
    return size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
};
export class StorageService {
  constructor(private readonly engine: Engine) {}
  private remove = async (relative: string) => {
    const path = join(this.engine.root, relative);
    if (!inside(this.engine.root, path))
      throw new AdeError(
        "isolation",
        "Cleanup path is outside Vibestar storage",
      );
    try {
      const entry = await lstat(path);
      if (
        !entry.isSymbolicLink() &&
        !inside(this.engine.root, await realpath(path))
      )
        throw new AdeError(
          "isolation",
          "Cleanup path resolves outside Vibestar storage",
        );
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  info = async () => {
    const names = [
      "state",
      "repos",
      "worktrees",
      "logs",
      "artifacts",
      "cache",
      "runtime",
      "telemetry",
    ];
    const sizes = Object.fromEntries(
      await Promise.all(
        names.map(
          async (name) =>
            [name, await directorySize(join(this.engine.root, name))] as const,
        ),
      ),
    );
    return {
      root: this.engine.root,
      sizes,
      database:
        (await directorySize(
          join(this.engine.root, "state", "vibestar.sqlite"),
        )) +
        (await directorySize(
          join(this.engine.root, "state", "vibestar.sqlite-wal"),
        )) +
        (await directorySize(
          join(this.engine.root, "state", "vibestar.sqlite-shm"),
        )),
      total: Object.values(sizes).reduce((n, value) => n + value, 0),
      measured_at: now(),
      external_repositories: this.engine.db
        .repositories()
        .filter((r) => r.source === "imported").length,
    };
  };
  clear = (kind: "logs" | "cache") =>
    this.engine.withStorageMaintenance(() => this.clearData(kind));
  private clearData = async (kind: "logs" | "cache") => {
    await this.remove(kind);
    await mkdir(join(this.engine.root, kind), { recursive: true, mode: 0o700 });
    this.engine.changed();
  };
  cleanupTask = (
    id: string,
    options: {
      worktree: boolean;
      logs: boolean;
      artifacts: boolean;
      history: boolean;
    },
  ) =>
    this.engine.withTaskMaintenance(id, () =>
      this.cleanupTaskData(id, options),
    );
  private cleanupTaskData = async (
    id: string,
    options: {
      worktree: boolean;
      logs: boolean;
      artifacts: boolean;
      history: boolean;
    },
  ) => {
    const e = this.engine;
    let task = e.db.task(id);
    if (e.isActive(id) || (task.status === "queued" && !task.archived))
      throw new AdeError(
        "busy",
        "Stop or dequeue this task before deleting its data.",
      );
    const repo = e.db.repository(task.repo_id);
    if (options.worktree && task.worktree_path) {
      await e.git.withLock(repo.id, async () => {
        if (await exists(task.worktree_path)) {
          const path = await e.git.assertTask(task);
          if (!task.branch_name.startsWith("akkco/"))
            throw new AdeError(
              "isolation",
              "Task branch is not owned by Vibestar",
            );
          await checked(
            "git",
            [
              "-c",
              "core.hooksPath=/dev/null",
              "worktree",
              "remove",
              "--force",
              "--",
              path,
            ],
            repo.path,
          );
          // Git refuses deletion if another checkout has this branch checked out.
          await checked(
            "git",
            ["branch", "-D", "--", task.branch_name],
            repo.path,
          );
        }
      });
      task = { ...task, worktree_path: "" };
    }
    if (options.logs) await this.remove(join("logs", id));
    if (options.artifacts) {
      await this.remove(join("artifacts", id));
      e.db.run("DELETE FROM task_artifacts WHERE task_id=?", id);
    }
    e.db.transaction(() => {
      if (options.history) {
        for (const table of [
          "agent_events",
          "agent_runs",
          "task_messages",
          "test_runs",
          "terminal_sessions",
          "task_review_notes",
          "task_activity",
        ])
          e.db.run(`DELETE FROM ${table} WHERE task_id=?`, id);
      }
      e.db.saveTask({ ...task, archived: true, updated_at: now() });
      if (!task.worktree_path && options.history && options.artifacts) {
        for (const table of ["scheduled_jobs", "github_pull_requests"]) {
          for (const row of e.db.all<{ data: string }>(
            `SELECT data FROM ${table}`,
          )) {
            const value = JSON.parse(row.data);
            if (value.task_id === id) {
              value.task_id = null;
              e.db.run(
                `UPDATE ${table} SET data=? WHERE ${table === "scheduled_jobs" ? "id" : "url"}=?`,
                JSON.stringify(value),
                table === "scheduled_jobs" ? value.id : value.url,
              );
            }
          }
        }
        e.db.run("DELETE FROM tasks WHERE id=?", id);
      }
    });
    e.changed(id);
  };
  removeRepository = (id: string) =>
    this.engine.withStorageMaintenance(() => this.removeRepositoryData(id));
  private removeRepositoryData = async (id: string) => {
    const e = this.engine;
    const repo = e.db.repository(id);
    const tasks = e.db.tasks().filter((t) => t.repo_id === id);
    if (
      tasks.some(
        (t) =>
          e.isActive(t.id) ||
          t.status === "queued" ||
          !["completed", "cancelled", "failed", "interrupted"].includes(
            t.status,
          ),
      )
    )
      throw new AdeError(
        "busy",
        "Stop and clean this repository's tasks first.",
      );
    for (const task of tasks)
      await this.cleanupTaskData(task.id, {
        worktree: true,
        logs: true,
        artifacts: true,
        history: true,
      });
    await e.git.withLock(id, async () => {
      if (repo.source !== "imported") {
        const path = await realpath(repo.path).catch(() => repo.path);
        if (!inside(join(e.root, "repos"), path))
          throw new AdeError("isolation", "Invalid managed repository path");
        if (await exists(join(path, ".git"))) {
          const worktrees = await checked(
            "git",
            ["worktree", "list", "--porcelain"],
            path,
          );
          if (
            worktrees
              .split("\n")
              .filter((line) => line.startsWith("worktree "))
              .some((line) => line.slice(9) !== path)
          )
            throw new AdeError(
              "busy",
              "This managed repository still has registered worktrees. Clean its recorded task worktrees first; external worktrees must remain intact.",
            );
        }
        await this.remove(join("repos", id));
      }
      e.db.transaction(() => {
        e.db.run("DELETE FROM issues WHERE repo_id=?", id);
        e.db.run("DELETE FROM repositories WHERE id=?", id);
      });
    });
    e.changed();
  };
  cleanCompleted = () =>
    this.engine.withStorageMaintenance(this.cleanCompletedData);
  private cleanCompletedData = async () => {
    let count = 0;
    for (const task of this.engine.db
      .tasks()
      .filter(
        (t) => ["completed", "cancelled"].includes(t.status) && t.worktree_path,
      )) {
      await this.cleanupTaskData(task.id, {
        worktree: true,
        logs: false,
        artifacts: false,
        history: false,
      });
      count++;
    }
    return count;
  };
  removeUnused = () =>
    this.engine.withStorageMaintenance(this.removeUnusedData);
  private removeUnusedData = async () => {
    const repos = this.engine.db
      .repositories()
      .filter(
        (r) =>
          r.source !== "imported" &&
          !this.engine.db.tasks().some((t) => t.repo_id === r.id),
      );
    for (const repo of repos) await this.removeRepositoryData(repo.id);
    return repos.length;
  };
  reset = () => this.engine.withStorageMaintenance(this.resetData);
  private resetData = async () => {
    for (const task of this.engine.db.tasks()) {
      if (!task.worktree_path) continue;
      this.engine.db.saveTask({ ...task, status: "cancelled" });
      await this.cleanupTaskData(task.id, {
        worktree: true,
        logs: true,
        artifacts: true,
        history: true,
      });
    }
    for (const repo of this.engine.db.repositories())
      await this.removeRepositoryData(repo.id);
    for (const dir of [
      "logs",
      "artifacts",
      "cache",
      "telemetry",
      "worktrees",
      "repos",
    ]) {
      await this.remove(dir);
      await mkdir(join(this.engine.root, dir), {
        recursive: true,
        mode: 0o700,
      });
    }
    this.engine.db.transaction(() => {
      for (const table of [
        "ai_usage",
        "agent_events",
        "agent_runs",
        "task_messages",
        "task_artifacts",
        "test_runs",
        "task_review_notes",
        "task_activity",
        "terminal_sessions",
        "scheduled_attention",
        "scheduled_agent_runs",
        "utility_runs",
        "scheduled_jobs",
        "github_pull_requests",
        "github_repositories",
        "local_repositories",
        "tasks",
        "issues",
        "repositories",
        "settings",
      ])
        this.engine.db.run(`DELETE FROM ${table}`);
    });
    this.engine.changed();
    return { restart_required: true };
  };
}
