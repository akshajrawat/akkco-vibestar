import { readWorktreeOwner } from "../workspace/ownership";
import { z } from "zod";
import { gitCapture, gitChecked, gitExecute } from "../workspace/git-command";
import { lstat, readdir, realpath, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AdeError, now, type Task, type Repository } from "../domain";
import type { Engine } from "../execution/engine";
import { inside, exists, managedPath, taskRoot } from "../workspace/paths";
const preparationEvidence = z
  .object({
    code: z.number().int(),
    argv: z.array(z.string()),
    started_at: z.string(),
    duration_ms: z.number().nonnegative(),
  })
  .loose();

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
    const path = await managedPath(this.engine.root, relative);
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
      if (task.worktree_path) await managedPath(e.root, task.worktree_path);
      const common = await e.git.commonDirectory(repo.path);
      if (
        task.workspace_checkpoint &&
        task.workspace_checkpoint.git_common_dir !== common
      )
        throw new AdeError(
          "ownership",
          "Task common-directory ownership changed; its data was preserved.",
        );
      if (
        !task.branch_name.startsWith("akkco/") ||
        [task.base_branch, repo.base_branch].includes(task.branch_name)
      )
        throw new AdeError("isolation", "Task branch is not owned by Vibestar");
      const branch = await gitCapture(
        ["show-ref", "--verify", "--quiet", `refs/heads/${task.branch_name}`],
        repo.path,
      );
      if (![0, 1].includes(branch.code))
        throw new AdeError("git_cleanup", "Could not verify the task branch");
      const worktrees = await gitChecked(
        ["worktree", "list", "--porcelain"],
        repo.path,
      );
      if (
        branch.code === 1 &&
        (!task.worktree_path || !(await exists(task.worktree_path))) &&
        !worktrees.split("\n").includes(`worktree ${task.worktree_path}`)
      ) {
        if (task.workspace_checkpoint) {
          task.workspace_checkpoint.state = "removed";
          task.workspace_checkpoint.operation = null;
          e.db.saveTask(task);
        }
        return;
      }
      const marker = await gitCapture(
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
          .all<{ id: number; data: string }>(
            "SELECT id,data FROM task_activity WHERE task_id=? AND kind='preparation'",
            task.id,
          )
          .map((row) =>
            e.db.records.decode(
              {
                table: "task_activity",
                id: row.id,
                column: "data",
                source: row.data,
              },
              preparationEvidence.parse,
            ),
          )
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
        const reflog = await gitCapture(
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
      const checkpointRemoval = (head: string) => {
        task.workspace_checkpoint = {
          ...task.workspace_checkpoint,
          state: "removing",
          git_common_dir: common,
          started_at: task.workspace_checkpoint?.started_at || now(),
          cleanup_head: head,
          operation: null,
        };
        e.db.saveTask(task);
      };
      const remove = async (args: string[]) => {
        let finished = false;
        try {
          const result = await gitExecute({
            program: "git",
            args,
            cwd: repo.path,
            onSpawn: (pid, identity) => {
              if (finished || !identity || !task.workspace_checkpoint) return;
              task.workspace_checkpoint.operation = {
                kind: args[0],
                pid,
                identity,
                started_at: now(),
              };
              e.db.saveTask(task);
            },
          });
          if (result.code !== 0)
            throw new AdeError(
              "git_cleanup",
              `Git cleanup stopped: ${result.stderr}`,
            );
        } finally {
          finished = true;
          if (task.workspace_checkpoint)
            task.workspace_checkpoint.operation = null;
          e.db.saveTask(task);
        }
      };
      if (task.worktree_path && (await exists(task.worktree_path))) {
        const path = await taskRoot(e.root, task);
        const [taskGit, repoGit] = await Promise.all([
          gitChecked(
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            path,
          ),
          gitChecked(
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            repo.path,
          ),
        ]);
        if ((await realpath(taskGit)) !== (await realpath(repoGit)))
          throw new AdeError(
            "isolation",
            "Task worktree belongs to a different repository",
          );
        const gitdir = await realpath(
          await gitChecked(["rev-parse", "--absolute-git-dir"], path),
        );
        if (!inside(join(common, "worktrees"), gitdir))
          throw new AdeError(
            "ownership",
            "Task metadata is not an isolated worktree; it was preserved.",
          );
        const owner = await readWorktreeOwner(gitdir, "vibestar-task-owner");
        if (
          (owner && owner !== task.id) ||
          (!owner &&
            ["ready", "removing"].includes(
              task.workspace_checkpoint?.state || "",
            ))
        )
          throw new AdeError(
            "ownership",
            "Task worktree owner is missing or changed; it was preserved.",
          );
        const current = await gitCapture(
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
        const ignored = await gitExecute({
          program: "git",
          args: [
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "-z",
          ],
          cwd: path,
          rawStdoutForIntegrity: true,
        });
        if (ignored.code !== 0)
          throw new AdeError(
            "git_cleanup",
            "Ignored worktree files could not be verified; the worktree was preserved.",
          );
        const flags = await gitChecked(["ls-files", "-v", "-z"], path);
        if (
          (await gitChecked(
            ["status", "--porcelain", "--untracked-files=all"],
            path,
          )) ||
          ignored.stdout ||
          flags.split("\0").some((entry) => /^[a-zS]/.test(entry)) ||
          (await gitCapture(["rev-parse", "--verify", "MERGE_HEAD"], path))
            .code === 0
        )
          throw new AdeError(
            "git_dirty",
            "The task has local changes, ignored files, hidden index entries or a pending merge. Preserve or commit them before removing its worktree.",
          );
        const head = await gitChecked(["rev-parse", "HEAD"], path);
        if (
          branch.code === 0 &&
          head !==
            (await gitChecked(
              ["rev-parse", `refs/heads/${task.branch_name}`],
              repo.path,
            ))
        )
          throw new AdeError(
            "ownership",
            "Task branch and worktree heads differ; cleanup was stopped.",
          );
        checkpointRemoval(head);
        await remove([
          "-c",
          "core.hooksPath=/dev/null",
          "worktree",
          "remove",
          "--",
          path,
        ]);
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
        const head =
          task.workspace_checkpoint?.cleanup_head || task.base_commit_sha;
        if (
          branch.code === 0 &&
          head !==
            (await gitChecked(
              ["rev-parse", `refs/heads/${task.branch_name}`],
              repo.path,
            ))
        )
          throw new AdeError(
            "ownership",
            "Missing worktree has no matching removal head. Restore it before cleanup; its branch was preserved.",
          );
        checkpointRemoval(head);
        await remove([
          "-c",
          "core.hooksPath=/dev/null",
          "worktree",
          "remove",
          "--",
          task.worktree_path,
        ]);
      }
      if (branch.code === 0) {
        const head =
          task.workspace_checkpoint?.cleanup_head || task.base_commit_sha;
        if (
          !head ||
          head !==
            (await gitChecked(
              ["rev-parse", `refs/heads/${task.branch_name}`],
              repo.path,
            ))
        )
          throw new AdeError(
            "ownership",
            "The task branch changed after removal was checkpointed; it was preserved.",
          );
        const checkouts = await gitChecked(
          ["worktree", "list", "--porcelain"],
          repo.path,
        );
        if (
          checkouts
            .split("\n")
            .includes(`branch refs/heads/${task.branch_name}`)
        )
          throw new AdeError(
            "ownership",
            "Task branch is checked out in another worktree; it was preserved.",
          );
        checkpointRemoval(head);
        await remove([
          "update-ref",
          "-d",
          `refs/heads/${task.branch_name}`,
          head,
        ]);
        if (marker.code === 0)
          await gitChecked(
            [
              "config",
              "--local",
              "--remove-section",
              `branch.${task.branch_name}`,
            ],
            repo.path,
          );
      }
      if (task.workspace_checkpoint) {
        task.workspace_checkpoint.state = "removed";
        task.workspace_checkpoint.operation = null;
        e.db.saveTask(task);
      }
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
          for (const row of e.db.all<{ id: string; data: string }>(
            `SELECT ${table === "scheduled_jobs" ? "id" : "url"} AS id,data FROM ${table}`,
          )) {
            const value = e.db.records.tryDecode({
              table,
              id: row.id,
              column: "data",
              source: row.data,
            });
            if (!value) continue;
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
    if (e.db.all("SELECT id FROM pr_repairs WHERE repo_id=?", id).length)
      throw new AdeError(
        "repair_history",
        "Remove this repository's owned PR repair workspaces and history explicitly before deleting its connection.",
      );
    const repo = e.db.repository(id);
    const tasks = e.db
      .all<{ id: string }>("SELECT id FROM tasks WHERE repo_id=?", id)
      .map((row) => e.db.task(row.id));
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
          const worktrees = await gitChecked(
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
          !this.engine.db.all("SELECT id FROM pr_repairs WHERE repo_id=?", r.id)
            .length &&
          !this.engine.db.all("SELECT id FROM tasks WHERE repo_id=?", r.id)
            .length,
      );
    for (const repo of repos) await this.removeRepositoryData(repo.id);
    return repos.length;
  };
  reset = () => this.engine.withStorageMaintenance(this.resetData);
  private resetData = async () => {
    this.engine.db.assertOwnershipRecords();
    if (this.engine.db.all("SELECT id FROM pr_repairs").length)
      throw new AdeError(
        "repair_history",
        "Remove PR repair workspaces and history explicitly before resetting storage; local changes must remain preserved.",
      );
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
      this.engine.db.run("UPDATE issue_watches SET last_complete_scan_id=NULL");
      for (const table of [
        "utility_events",
        "issue_watch_results",
        "issue_watch_candidates",
        "issue_watch_sources",
        "issue_watch_scans",
        "issue_watch_revisions",
        "issue_watches",
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
        "task_requests",
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
