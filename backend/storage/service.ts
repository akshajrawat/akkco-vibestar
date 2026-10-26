import { readWorktreeOwner } from "../workspace/ownership";
import { z } from "zod";
import { gitCapture, gitChecked, gitExecute } from "../workspace/git-command";
import { lstat, readdir, realpath, rm, mkdir, writeFile, cp, chmod } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import BetterSqlite3 from "better-sqlite3";
import { join } from "node:path";
import { AdeError, now, type Task, type Repository } from "../domain";
import type { Engine } from "../execution/engine";
import { inside, exists, managedPath, taskRoot } from "../workspace/paths";
import type { TaskDisposalPreview } from "./disposal";

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
    for (const name of await readdir(path)) size += await directorySize(join(path, name));
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
      throw new AdeError("isolation", "Cleanup path is outside Vibestar storage");
    try {
      const entry = await lstat(path);
      if (!entry.isSymbolicLink() && !inside(this.engine.root, await realpath(path)))
        throw new AdeError("isolation", "Cleanup path resolves outside Vibestar storage");
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
          async (name) => [name, await directorySize(join(this.engine.root, name))] as const,
        ),
      ),
    );

    return {
      root: this.engine.root,
      sizes,
      database:
        (await directorySize(join(this.engine.root, "state", "vibestar.sqlite"))) +
        (await directorySize(join(this.engine.root, "state", "vibestar.sqlite-wal"))) +
        (await directorySize(join(this.engine.root, "state", "vibestar.sqlite-shm"))),
      total: Object.values(sizes).reduce((n, value) => n + value, 0),
      measured_at: now(),
      external_repositories: this.engine.db.repositories().filter((r) => r.source === "imported")
        .length,
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
  ) => this.engine.withTaskMaintenance(id, () => this.cleanupTaskData(id, options));

  private disposalDependencies = (id: string) => ({
    finalizations: this.engine.db.all("SELECT id FROM git_finalizations WHERE task_id=?", id)
      .length,
    repairs: this.engine.db.all(
      "SELECT id FROM pr_repairs WHERE job_id IN (SELECT id FROM scheduled_jobs WHERE json_extract(CASE WHEN json_valid(data) THEN data END,'$.task_id')=?)",
      id,
    ).length,
  });

  /** Reuses removal's ownership checks without mutating files, binding any later discard to this content. */
  previewTaskDisposal = (id: string) =>
    this.engine.withTaskMaintenance(id, async () => {
      const task = this.engine.db.task(id);
      const repo = this.engine.db.repository(task.repo_id);
      if (await this.disposalRecovery(task)) {
        await this.removeTaskWorkspace(
          task,
          repo,
          true,
          !task.disposal_authorization!.acknowledge_unpublished,
        );

        return {
          ...this.emptyDisposalPreview(task, repo),
          fingerprint: task.disposal_authorization!.fingerprint,
          active_operation: "Finish previously confirmed task removal",
        };
      }

      return (
        (await this.removeTaskWorkspace(task, repo, true, false, {})) ||
        this.emptyDisposalPreview(task, repo)
      );
    });

  private disposalRecovery = async (task: Task) =>
    !!task.disposal_authorization &&
    ["removing", "removed"].includes(task.workspace_checkpoint?.state || "") &&
    !!task.worktree_path &&
    !(await exists(task.worktree_path));

  private emptyDisposalPreview = (task: Task, repo: Repository): TaskDisposalPreview => ({
    task_id: task.id,
    title: String(task.issue?.title || `Issue #${task.issue_number}`),
    repository: `${repo.owner}/${repo.name}`,
    branch: task.branch_name,
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify([
          task.id,
          task.repo_id,
          task.branch_name,
          task.worktree_path,
          task.updated_at,
        ]),
      )
      .digest("hex"),
    modified: [],
    untracked: [],
    ignored: [],
    unpublished_commits: 0,
    active_operation: null,
    dependencies: this.disposalDependencies(task.id),
  });

  /** Binds deliberate loss to an owned workspace preview; interrupted removal retains that authorization. */
  discardTask = (id: string, fingerprint: string, acknowledgeUnpublished: boolean) =>
    this.engine.withTaskMaintenance(id, async () => {
      const task = this.engine.db.task(id);
      const repo = this.engine.db.repository(task.repo_id);
      const dependencies = this.disposalDependencies(id);
      if (dependencies.finalizations || dependencies.repairs)
        throw new AdeError(
          "task_dependencies",
          "Remove the dependent Git Finalization previews and PR repair sessions explicitly before discarding this task.",
        );
      if (
        !task.branch_name &&
        !task.worktree_path &&
        this.emptyDisposalPreview(task, repo).fingerprint !== fingerprint
      )
        throw new AdeError("stale_preview", "The task changed. Inspect a fresh discard preview.");
      if (await this.disposalRecovery(task)) {
        if (task.disposal_authorization!.fingerprint !== fingerprint)
          throw new AdeError(
            "stale_preview",
            "This removal must resume its original confirmed discard.",
          );

        await this.removeTaskWorkspace(
          task,
          repo,
          false,
          !task.disposal_authorization!.acknowledge_unpublished,
        );
      } else {
        await this.removeTaskWorkspace(task, repo, false, false, {
          fingerprint,
          acknowledgeUnpublished,
        });
      }

      await this.cleanupTaskData(id, {
        worktree: false,
        logs: true,
        artifacts: true,
        history: true,
      });
    });

  /** Removes conversation history while retaining the ownership record needed to protect files and dependencies. */
  preserveTaskWork = (id: string) =>
    this.engine.withTaskMaintenance(id, async () => {
      const e = this.engine;
      const task = e.db.task(id);
      if (["removing", "removed"].includes(task.workspace_checkpoint?.state || ""))
        throw new AdeError(
          "removal_pending",
          "Finish the previously confirmed worktree removal before clearing history.",
        );
      if (
        e.db.all(
          "SELECT id FROM git_finalizations WHERE task_id=? AND status IN ('committing','pushing','uncertain','interrupted')",
          id,
        ).length
      )
        throw new AdeError(
          "publication_pending",
          "Reconcile the unfinished Git Finalization operation before removing task history.",
        );

      // Retain the minimal task ownership record. It keeps worktrees/branches and
      // dependent finalization/repair records reachable by storage and migration.
      await this.cleanupTaskData(
        id,
        { worktree: false, logs: true, artifacts: true, history: true },
        false,
        true,
      );

      e.db.saveTask({
        ...e.db.task(id),
        status: "preserved",
        archived: true,
        notes: "",
        issue: { title: task.issue?.title },
        execution_settings: undefined,
        stage_settings: undefined,
        workflow_start: undefined,
        followup_config: undefined,
        approval_gate: undefined,
        error: null,
        updated_at: now(),
      });

      e.changed(id);
    });

  private removeTaskWorkspace = async (
    task: Task,
    repo: Repository,
    preview = false,
    protectUnpushed = false,
    discard?: { fingerprint?: string; acknowledgeUnpublished?: boolean },
  ) => {
    const e = this.engine;
    return e.git.withLock(repo.id, async () => {
      let disposal: TaskDisposalPreview | undefined;
      let removalHead: string | undefined;
      if (!task.branch_name && !task.worktree_path) return;
      if (discard && (!task.worktree_path || !(await exists(task.worktree_path))))
        throw new AdeError(
          "ownership",
          "The assigned task worktree is missing. Restore or inspect its ownership before discarding the branch.",
        );
      if (task.worktree_path) await managedPath(e.root, task.worktree_path);
      const common = await e.git.commonDirectory(repo.path);
      if (task.workspace_checkpoint && task.workspace_checkpoint.git_common_dir !== common)
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
      const worktrees = await gitChecked(["worktree", "list", "--porcelain"], repo.path);
      if (
        branch.code === 1 &&
        (!task.worktree_path || !(await exists(task.worktree_path))) &&
        !worktrees.split("\n").includes(`worktree ${task.worktree_path}`)
      ) {
        if (task.workspace_checkpoint && !preview) {
          task.workspace_checkpoint.state = "removed";
          task.workspace_checkpoint.operation = null;
          e.db.saveTask(task);
        }

        return;
      }

      const marker = await gitCapture(
        ["config", "--local", "--get", `branch.${task.branch_name}.vibestarTask`],
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
          ["reflog", "show", "--date=raw", "--format=%gD%x00%gs", `refs/heads/${task.branch_name}`],
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
        const path = lines.find((line) => line.startsWith("worktree "))?.slice(9);
        if (!path || !task.worktree_path || path !== task.worktree_path)
          throw new AdeError(
            "busy",
            "The task branch is checked out outside its assigned worktree. Task history was retained.",
          );
      }

      const checkpointRemoval = (head: string) => {
        removalHead = head;
        if (preview) return;

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
        if (preview) return;
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
            throw new AdeError("git_cleanup", `Git cleanup stopped: ${result.stderr}`);
        } finally {
          finished = true;
          if (task.workspace_checkpoint) task.workspace_checkpoint.operation = null;
          e.db.saveTask(task);
        }
      };

      if (task.worktree_path && (await exists(task.worktree_path))) {
        const path = await taskRoot(e.root, task);

        const [taskGit, repoGit] = await Promise.all([
          gitChecked(["rev-parse", "--path-format=absolute", "--git-common-dir"], path),
          gitChecked(["rev-parse", "--path-format=absolute", "--git-common-dir"], repo.path),
        ]);

        if ((await realpath(taskGit)) !== (await realpath(repoGit)))
          throw new AdeError("isolation", "Task worktree belongs to a different repository");
        const gitdir = await realpath(await gitChecked(["rev-parse", "--absolute-git-dir"], path));
        if (!inside(join(common, "worktrees"), gitdir))
          throw new AdeError(
            "ownership",
            "Task metadata is not an isolated worktree; it was preserved.",
          );
        const owner = await readWorktreeOwner(gitdir, "vibestar-task-owner");
        if (
          (owner && owner !== task.id) ||
          (!owner && ["ready", "removing"].includes(task.workspace_checkpoint?.state || ""))
        )
          throw new AdeError(
            "ownership",
            "Task worktree owner is missing or changed; it was preserved.",
          );
        const current = await gitCapture(["symbolic-ref", "--quiet", "--short", "HEAD"], path);
        if (
          (current.code === 0 && current.stdout.trim() !== task.branch_name) ||
          ![0, 1].includes(current.code)
        )
          throw new AdeError("isolation", "Task worktree has a different branch; it was preserved");

        const ignored = await gitExecute({
          program: "git",
          args: ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
          cwd: path,
          rawStdoutForIntegrity: true,
        });

        if (ignored.code !== 0 || ignored.stdout_truncated)
          throw new AdeError(
            "git_cleanup",
            "Ignored worktree files could not be verified; the worktree was preserved.",
          );
        const flags = await gitChecked(["ls-files", "-v", "-z"], path);
        const hidden = flags.split("\0").some((entry) => /^[a-zS]/.test(entry));
        if (discard) {
          for (const name of [
            "MERGE_HEAD",
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
            "rebase-merge",
            "rebase-apply",
            "sequencer",
            "index.lock",
            "BISECT_LOG",
          ])
            if (await exists(join(gitdir, name)))
              throw new AdeError(
                "git_operation",
                `Resolve the pending Git operation (${name}) before discarding this task. Its files were preserved.`,
              );
          if (hidden)
            throw new AdeError(
              "git_index",
              "Clear assume-unchanged and skip-worktree index flags before discarding. Hidden index state requires manual inspection.",
            );
        }

        if (
          !discard &&
          ((await gitChecked(["status", "--porcelain", "--untracked-files=all"], path)) ||
            ignored.stdout ||
            hidden ||
            (await gitCapture(["rev-parse", "--verify", "MERGE_HEAD"], path)).code === 0)
        )
          throw new AdeError(
            "git_dirty",
            "The task has local changes, ignored files, hidden index entries or a pending merge. Preserve or commit them before removing its worktree.",
          );
        const head = await gitChecked(["rev-parse", "HEAD"], path);
        if (discard) {
          const changes = await e.git.diff(task);

          disposal = {
            ...this.emptyDisposalPreview(task, repo),
            modified: changes.files.filter((file) => !file.untracked).map((file) => file.path),
            untracked: changes.files.filter((file) => file.untracked).map((file) => file.path),
            ignored: ignored.stdout.split("\0").filter(Boolean),
            unpublished_commits: Number(
              await gitChecked(
                ["rev-list", "--count", head, "--not", task.base_commit_sha, "--remotes"],
                path,
              ),
            ),
            fingerprint: createHash("sha256")
              .update(
                JSON.stringify([
                  task.id,
                  task.repo_id,
                  path,
                  task.branch_name,
                  await e.git.disposalFingerprint(task),
                ]),
              )
              .digest("hex"),
          };

          if (!preview) {
            if (disposal.fingerprint !== discard.fingerprint)
              throw new AdeError(
                "stale_preview",
                "Task contents changed after the discard preview. Inspect the current files before confirming again.",
              );
            if (disposal.unpublished_commits && !discard.acknowledgeUnpublished)
              throw new AdeError(
                "unpublished_commits",
                "Confirm the additional loss of unique unpublished commits before discarding this task.",
              );
          }
        }

        if (
          protectUnpushed &&
          (await gitChecked(
            ["rev-list", "--count", head, "--not", task.base_commit_sha, "--remotes"],
            repo.path,
          )) !== "0"
        )
          throw new AdeError(
            "git_unpushed",
            "Unpushed task commits were preserved. Publish or preserve them separately before resetting.",
          );
        if (
          branch.code === 0 &&
          head !== (await gitChecked(["rev-parse", `refs/heads/${task.branch_name}`], repo.path))
        )
          throw new AdeError(
            "ownership",
            "Task branch and worktree heads differ; cleanup was stopped.",
          );
        checkpointRemoval(head);
        if (discard && !preview) {
          await taskRoot(e.root, task);
          if ((await readWorktreeOwner(gitdir, "vibestar-task-owner")) !== task.id)
            throw new AdeError(
              "ownership",
              "Task ownership changed immediately before discard. Its files were preserved.",
            );

          task.disposal_authorization = {
            fingerprint: discard.fingerprint!,
            acknowledge_unpublished: !!discard.acknowledgeUnpublished,
            authorized_at: now(),
          };

          e.db.saveTask(task);
        }

        await remove([
          "-c",
          "core.hooksPath=/dev/null",
          "worktree",
          "remove",
          ...(discard ? ["--force"] : []),
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
        const head = task.workspace_checkpoint?.cleanup_head || task.base_commit_sha;
        if (
          branch.code === 0 &&
          head !== (await gitChecked(["rev-parse", `refs/heads/${task.branch_name}`], repo.path))
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
        const head = removalHead || task.workspace_checkpoint?.cleanup_head || task.base_commit_sha;
        if (
          !head ||
          head !== (await gitChecked(["rev-parse", `refs/heads/${task.branch_name}`], repo.path))
        )
          throw new AdeError(
            "ownership",
            "The task branch changed after removal was checkpointed; it was preserved.",
          );
        if (
          protectUnpushed &&
          (await gitChecked(
            [
              "rev-list",
              "--count",
              `refs/heads/${task.branch_name}`,
              "--not",
              task.base_commit_sha,
              "--remotes",
            ],
            repo.path,
          )) !== "0"
        )
          throw new AdeError(
            "git_unpushed",
            "Unpushed task commits were preserved. Publish or preserve them separately before resetting.",
          );
        const checkouts = await gitChecked(["worktree", "list", "--porcelain"], repo.path);
        if (!preview && checkouts.split("\n").includes(`branch refs/heads/${task.branch_name}`))
          throw new AdeError(
            "ownership",
            "Task branch is checked out in another worktree; it was preserved.",
          );
        checkpointRemoval(head);
        await remove(["update-ref", "-d", `refs/heads/${task.branch_name}`, head]);
        if (marker.code === 0 && !preview)
          await gitChecked(
            ["config", "--local", "--remove-section", `branch.${task.branch_name}`],
            repo.path,
          );
      }

      if (task.workspace_checkpoint && !preview) {
        task.workspace_checkpoint.state = "removed";
        task.workspace_checkpoint.operation = null;
        e.db.saveTask(task);
      }

      return disposal;
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
    protectUnpushed = true,
    preserveWork = false,
  ) => {
    const e = this.engine;
    let task = e.db.task(id);
    if (e.isActive(id) || (task.status === "queued" && !task.archived))
      throw new AdeError("busy", "Stop or dequeue this task before deleting its data.");
    const repo = e.db.repository(task.repo_id);
    if (!preserveWork && (options.worktree || options.history)) {
      if (e.db.all("SELECT id FROM git_finalizations WHERE task_id=?", id).length)
        throw new AdeError(
          "git_history",
          "Remove this task's owned Git Finalization previews explicitly before deleting its workspace or history.",
        );
      await this.removeTaskWorkspace(task, repo, false, protectUnpushed);

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
          "task_git_presets",
        ])
          e.db.run(`DELETE FROM ${table} WHERE task_id=?`, id);
      }

      e.db.saveTask({ ...task, archived: true, updated_at: now() });
      if (!preserveWork && !task.worktree_path && options.history && options.artifacts) {
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
          !["completed", "cancelled", "failed", "interrupted", "verification_blocked"].includes(
            t.status,
          ),
      )
    )
      throw new AdeError("busy", "Stop and clean this repository's tasks first.");
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
          const worktrees = await gitChecked(["worktree", "list", "--porcelain"], path);
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

  cleanCompleted = () => this.engine.withStorageMaintenance(this.cleanCompletedData);

  private cleanCompletedData = async () => {
    let count = 0;
    for (const task of this.engine.db
      .tasks()
      .filter(
        (t) => ["completed", "cancelled"].includes(t.status) && (t.worktree_path || t.branch_name),
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

  removeUnused = () => this.engine.withStorageMaintenance(this.removeUnusedData);

  private removeUnusedData = async () => {
    const repos = this.engine.db
      .repositories()
      .filter(
        (r) =>
          r.source !== "imported" &&
          !this.engine.db.all("SELECT id FROM pr_repairs WHERE repo_id=?", r.id).length &&
          !this.engine.db.all("SELECT id FROM tasks WHERE repo_id=?", r.id).length,
      );

    for (const repo of repos) await this.removeRepositoryData(repo.id);
    return repos.length;
  };

  previewReset = async () => {
    const e = this.engine;
    e.db.assertOwnershipRecords();
    const tasks = [];
    for (const task of e.db.tasks()) {
      let reason = "";
      let fingerprint = "";
      try {
        if (e.cleanupBlockers(task.id).some((blocker) => blocker.id !== "storage-maintenance"))
          throw new AdeError("busy", "Active task processes must stop before resetting.");
        if (e.db.all("SELECT id FROM git_finalizations WHERE task_id=?", task.id).length)
          throw new AdeError(
            "git_history",
            "Git Finalization records require separate explicit removal.",
          );
        await this.removeTaskWorkspace(task, e.db.repository(task.repo_id), true, true);
        if (task.worktree_path && (await exists(task.worktree_path)))
          fingerprint = await e.git.fingerprint(task);
        await managedPath(e.root, join("logs", task.id));
        await managedPath(e.root, join("artifacts", task.id));
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }

      tasks.push({
        id: task.id,
        title: String(task.issue.title || task.claimed_scope || "Entire issue"),
        archived: !!task.archived,
        worktree: task.worktree_path,
        branch: task.branch_name,
        eligible: !reason,
        reason,
        fingerprint,
        remove: [
          task.worktree_path,
          task.branch_name && "refs/heads/" + task.branch_name,
          join(e.root, "logs", task.id),
          join(e.root, "artifacts", task.id),
          "Task conversation, plans, runs, terminals and task usage",
        ].filter(Boolean),
      });
    }

    const repairs = e.db.all<{ id: string; status: string }>("SELECT id,status FROM pr_repairs");

    const finalizations = e.db.all<{ id: string; status: string }>(
      "SELECT id,status FROM git_finalizations",
    );

    const sensitive = [
      ...finalizations.filter((record) =>
        ["preparing", "reviewing", "committing", "pushing", "uncertain"].includes(record.status),
      ),
      ...e.db.all<{ id: string; status: string }>(
        "SELECT id,status FROM repair_publications WHERE status IN ('pushing','uncertain')",
      ),
    ];

    const retained = [];
    for (const category of [
      "logs",
      "artifacts",
      "cache",
      "runtime",
      "telemetry",
      "worktrees",
      "repos",
    ]) {
      const path = await managedPath(e.root, category);
      for (const name of await readdir(path).catch(() => []))
        if (
          !["logs", "artifacts"].includes(category) ||
          !tasks.some((task) => task.id === name && task.eligible)
        )
          retained.push(join(path, name));
    }

    const preview = {
      root: e.root,
      tasks,
      repairs,
      finalizations,
      sensitive,
      retained,
      blockers: e.cleanupBlockers().filter((blocker) => blocker.id !== "storage-maintenance"),
      preserved: [
        "All registered source repositories and managed clones",
        "User-owned branches",
        "Provider and GitHub authentication",
        "Settings and repository connections",
        "Repair sessions, Git Finalization history and unowned cache/log/runtime data",
      ],
    };

    const token = createHash("sha256").update(JSON.stringify(preview)).digest("hex");
    return { ...preview, token };
  };

  reset = (token?: string) => this.engine.withStorageMaintenance(() => this.resetData(token));

  private resetData = async (token?: string) => {
    const e = this.engine;
    const preview = await this.previewReset();
    if (preview.token !== token)
      throw new AdeError(
        "stale_preview",
        "Workspace data changed. Inspect a new reset preview before confirming.",
      );
    if (preview.sensitive.length)
      throw new AdeError(
        "busy",
        "Reconcile pending sensitive Git operations before resetting local test data.",
      );
    const backup = await managedPath(e.root, join("backups", "local-test-reset-" + randomUUID()));
    await mkdir(backup, { recursive: true, mode: 0o700 });
    const database = join(backup, "vibestar.sqlite");
    await e.db.backup(database);
    await chmod(database, 0o600);

    const connection = new BetterSqlite3(database, {
      readonly: true,
      fileMustExist: true,
    });

    try {
      if (connection.pragma("quick_check", { simple: true }) !== "ok")
        throw new AdeError("backup", "SQLite backup validation failed; no task data was removed.");
    } finally {
      connection.close();
    }

    await writeFile(
      join(backup, "manifest.json"),
      JSON.stringify({ created_at: now(), preview }, null, 2),
      { mode: 0o600 },
    );

    for (const category of ["logs", "artifacts"]) {
      const path = await managedPath(e.root, category);

      await cp(path, join(backup, category), {
        recursive: true,
        filter: async (file) => !(await lstat(file)).isSymbolicLink(),
      });
    }

    const removed: string[] = [];

    const preserved = preview.tasks
      .filter((task) => !task.eligible)
      .map((task) => ({ id: task.id, reason: task.reason }));

    for (const task of preview.tasks.filter((task) => task.eligible)) {
      try {
        // Ownership, dirtiness and unpushed commits are rechecked under the same
        // canonical Git lock used by normal task cleanup, after the backup.
        const usage = e.db.all<{ id: string }>("SELECT id FROM ai_usage WHERE task_id=?", task.id);

        const requests = e.db.all<{ request_id: string }>(
          "SELECT request_id FROM task_requests WHERE task_id=?",
          task.id,
        );

        await this.cleanupTaskData(
          task.id,
          { worktree: true, logs: true, artifacts: true, history: true },
          true,
        );

        e.db.transaction(() => {
          for (const row of usage) e.db.run("DELETE FROM ai_usage WHERE id=?", row.id);
          for (const request of requests)
            e.db.run("DELETE FROM task_requests WHERE request_id=?", request.request_id);
        });

        removed.push(task.id);
      } catch (error) {
        preserved.push({
          id: task.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const result = {
      backup,
      removed,
      preserved,
      retained: preview.retained,
      repairs: preview.repairs,
      finalizations: preview.finalizations,
      restart_required: false,
    };

    await writeFile(join(backup, "result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
    e.changed();
    return result;
  };
}
