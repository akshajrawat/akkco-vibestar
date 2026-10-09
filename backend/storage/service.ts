import { lstat, readdir, realpath, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AdeError, now, type Task, type Repository } from "../domain";
import type { Engine } from "../execution/engine";
import { capture, checked } from "../execution/process";
import { inside, exists, taskRoot } from "../workspace/paths";

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
  private removeTaskWorkspace = async (task: Task, repo: Repository) => {
    const e = this.engine;
    await e.git.withLock(repo.id, async () => {
      if (!task.branch_name && !task.worktree_path) return;
      if (
        !task.branch_name.startsWith("akkco/") ||
        [task.base_branch, repo.base_branch].includes(task.branch_name)
      )
        throw new AdeError("isolation", "Task branch is not owned by Vibestar");
      const branch = await capture(
        "git",
        ["show-ref", "--verify", "--quiet", `refs/heads/${task.branch_name}`],
        repo.path,
      );
      if (![0, 1].includes(branch.code))
        throw new AdeError("git_cleanup", "Could not verify the task branch");
      const worktrees = await checked(
        "git",
        ["worktree", "list", "--porcelain"],
        repo.path,
      );
      if (
        branch.code === 1 &&
        (!task.worktree_path || !(await exists(task.worktree_path))) &&
        !worktrees.split("\n").includes(`worktree ${task.worktree_path}`)
      )
        return;
      const marker = await capture(
        "git",
        [
          "config",
          "--local",
          "--get",
          `branch.${task.branch_name}.vibestarTask`,
        ],
        repo.path,
      );
      const legacyRecord =
        marker.code === 1 &&
        !task.branch_owned &&
        e.db
          .all<{ data: string }>(
            "SELECT data FROM task_activity WHERE task_id=? AND kind='preparation'",
            task.id,
          )
          .map((row) => JSON.parse(row.data))
          .find((data) => {
            return (
              data.code === 0 &&
              Array.isArray(data.argv) &&
              data.argv.slice(0, 4).join(" ") === "git worktree add -b" &&
              data.argv[4] === task.branch_name &&
              data.argv[6] === task.base_commit_sha
            );
          });
      let legacyCreation = !!legacyRecord && branch.code === 1;
      if (legacyRecord && branch.code === 0) {
        const reflog = await capture(
          "git",
          [
            "reflog",
            "show",
            "--date=raw",
            "--format=%gD%x00%gs",
            `refs/heads/${task.branch_name}`,
          ],
          repo.path,
        );
        const first = reflog.stdout.trim().split("\n").at(-1) ?? "";
        const [selector, message] = first.split("\0");
        const created = Number(selector.match(/@\{(\d+) /)?.[1]);
        const started = Date.parse(legacyRecord.started_at) / 1000;
        legacyCreation =
          reflog.code === 0 &&
          message === `branch: Created from ${task.base_commit_sha}` &&
          created >= Math.floor(started) &&
          created <= Math.ceil(started + legacyRecord.duration_ms / 1000);
      }
      if (
        !(marker.code === 0 && marker.stdout.trim() === task.id) &&
        !legacyCreation &&
        !(branch.code === 1 && task.branch_owned)
      )
        throw new AdeError(
          "isolation",
          "No verified Vibestar ownership record for this branch. Task history was retained.",
        );
      for (const entry of worktrees.split("\n\n")) {
        const lines = entry.split("\n");
        if (!lines.includes(`branch refs/heads/${task.branch_name}`)) continue;
        const path = lines
          .find((line) => line.startsWith("worktree "))
          ?.slice(9);
        if (!path || !task.worktree_path || path !== task.worktree_path)
          throw new AdeError(
            "busy",
            "The task branch is checked out outside its assigned worktree. Task history was retained.",
          );
      }
      if (task.worktree_path && (await exists(task.worktree_path))) {
        const path = await taskRoot(e.root, task);
        const [taskGit, repoGit] = await Promise.all([
          checked(
            "git",
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            path,
          ),
          checked(
            "git",
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            repo.path,
          ),
        ]);
        if ((await realpath(taskGit)) !== (await realpath(repoGit)))
          throw new AdeError(
            "isolation",
            "Task worktree belongs to a different repository",
          );
        const current = await capture(
          "git",
          ["symbolic-ref", "--quiet", "--short", "HEAD"],
          path,
        );
        if (
          (current.code === 0 && current.stdout.trim() !== task.branch_name) ||
          ![0, 1].includes(current.code)
        )
          throw new AdeError(
            "isolation",
            "Task worktree has a different branch; it was preserved",
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
      } else if (
        task.worktree_path &&
        worktrees.split("\n").includes(`worktree ${task.worktree_path}`)
      ) {
        if (!inside(join(e.root, "worktrees", repo.id), task.worktree_path))
          throw new AdeError(
            "isolation",
            "Task worktree is outside its managed repository boundary",
          );
        // Remove only this missing registration; pruning all worktrees could
        // affect unrelated checkouts sharing the same Git metadata.
        await checked(
          "git",
          [
            "-c",
            "core.hooksPath=/dev/null",
            "worktree",
            "remove",
            "--force",
            "--",
            task.worktree_path,
          ],
          repo.path,
        );
      }
      if (branch.code === 0)
        await checked(
          "git",
          ["branch", "-D", "--", task.branch_name],
          repo.path,
        );
    });
  };
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
    if (options.worktree || options.history) {
      await this.removeTaskWorkspace(task, repo);
      task = {
        ...task,
        worktree_path: "",
        branch_name: "",
        branch_owned: false,
      };
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
          "task_reviewed_files",
          "code_questions",
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
        (t) =>
          ["completed", "cancelled"].includes(t.status) &&
          (t.worktree_path || t.branch_name),
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
      if (!task.worktree_path && !task.branch_name) continue;
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
        "task_reviewed_files",
        "code_questions",
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
