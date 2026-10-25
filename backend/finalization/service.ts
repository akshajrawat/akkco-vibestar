import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import { AdeError, now, remoteIdentity } from "../domain";
import type { Engine } from "../execution/engine";
import { execute, redact } from "../execution/process";
import { sandboxInvocation } from "../execution/sandbox";
import { OutputBudget } from "../execution/bounded-output";
import { planSchemas } from "../execution/providers/contracts";
import { taskVerification } from "../execution/task-verification";
import {
  verificationSummary,
  type VerificationCommand,
} from "../execution/verification";
import { GitHubClient } from "../github/client";
import {
  CommitMessageSchema,
  createExactCommit,
} from "../workspace/commit-message";
import {
  gitCapture,
  gitChecked,
  gitExecute,
  githubTransport,
} from "../workspace/git-command";
import { inside, managedPath, workspaceEntry } from "../workspace/paths";
import { publishFastForward } from "../workspace/publication";
import {
  FinalizationSchema,
  FinalizationViewSchema,
  GitPresetSchema,
  SelectedFilesInput,
  type Finalization,
} from "./contracts";
import { inspectSelectedFile } from "./files";
import { FinalizationStore } from "./store";
import { FinalizationWorkspaces } from "./workspaces";

const identitySchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  full_name: z.string(),
  permissions: z.object({ push: z.boolean() }),
  fork: z.boolean(),
  parent: z.object({ full_name: z.string() }).optional(),
  viewer: z.string().min(1),
});
const operationInput = z
  .object({ id: z.string().uuid(), operation_id: z.string().uuid() })
  .strict();
const destinationInput = GitPresetSchema.pick({ remote: true, branch: true });
const gitPhases = new Map([
  ["worktree", "Preparing isolated review workspace"],
  ["add", "Staging selected files"],
  ["write-tree", "Checking staged content"],
  ["restore", "Updating selected staged entries"],
  ["update-ref", "Recording local branch state"],
]);

export class FinalizationService {
  readonly store: FinalizationStore;
  private readonly workspaces: FinalizationWorkspaces;
  private readonly active = new Map<
    string,
    { controller: AbortController; promise: Promise<unknown> }
  >();
  constructor(
    private readonly engine: Engine,
    private readonly identity = async (
      repository: string,
      signal: AbortSignal,
    ) => {
      const client = new GitHubClient(engine.root);
      const viewer = await client.api<{ login: string }>("user", signal);
      const repositoryData = await client.api<Record<string, unknown>>(
        `repos/${repository}`,
        signal,
      );
      return identitySchema.parse({ ...repositoryData, viewer: viewer.login });
    },
    private readonly transport?: (url: string) => string,
    private readonly push = execute,
  ) {
    this.store = new FinalizationStore(engine.db);
    this.workspaces = new FinalizationWorkspaces(engine, this.git);
  }
  private git = async (
    record: Finalization,
    cwd: string,
    args: string[],
    signal: AbortSignal,
  ) => {
    const result = await gitExecute({
      program: "git",
      cwd,
      args,
      signal,
      rawStdoutForIntegrity: true,
      onSpawn: (pid, identity) => {
        record.pid = pid;
        record.process_identity = identity;
        this.store.save(record);
        this.engine.changed(record.task_id);
      },
      onLine:
        args[0] === "diff"
          ? undefined
          : (stream, line) => {
              this.store.event(record, `git ${args[0]} ${stream}`, line);
              this.engine.changed(record.task_id);
            },
    });
    record.pid = null;
    record.process_identity = null;
    this.store.event(
      record,
      `git ${args[0]}`,
      result.stderr || (args[0] === "diff" ? "Diff inspected" : result.stdout),
      result.code,
    );
    this.store.save(record);
    const phase = gitPhases.get(args[0]);
    if (phase)
      this.store.event(
        record,
        phase,
        result.code === 0
          ? `${record.paths.length} verified literal paths`
          : result.stderr,
        result.code,
      );
    if (result.code !== 0)
      throw new AdeError(
        "git_finalization",
        `git ${args[0]} exited ${result.code}: ${redact(result.stderr).slice(-6000)}`,
      );
    return result.stdout;
  };
  private exclusive = <T>(
    id: string,
    label: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ) => {
    this.engine.assertAvailable();
    if (this.active.has(id))
      throw new AdeError(
        "busy",
        "A Git operation is already running for this task.",
      );
    const releaseTask = this.engine.acquireTaskWorkspace(
      id,
      "Git finalization",
    );
    const controller = new AbortController();
    let releaseActivity = () => {};
    const promise = Promise.resolve()
      .then(async () => {
        const task = this.engine.db.task(id);
        const repo = this.engine.db.repository(task.repo_id);
        const releaseBranch = await this.engine.git.acquireWrite(
          repo.path,
          `branch:${task.branch_name}`,
        );
        try {
          return await this.engine.git.withLock(repo.id, () =>
            operation(controller.signal),
          );
        } finally {
          await releaseBranch();
        }
      })
      .finally(() => {
        this.active.delete(id);
        releaseTask();
        releaseActivity();
        this.engine.changed(id);
      });
    this.active.set(id, { controller, promise });
    releaseActivity = this.engine.trackActivity(
      { id: `git:${id}`, kind: "task", task_id: id, label, stoppable: true },
      async () => {
        controller.abort();
        await promise.catch(() => {});
      },
    );
    return promise;
  };
  private preset = (taskId: string) => {
    const task = this.engine.db.task(taskId);
    const saved = this.engine.db.all<{ data: string }>(
      "SELECT data FROM task_git_presets WHERE task_id=?",
      taskId,
    )[0];
    return saved
      ? this.engine.db.records.decode(
          {
            table: "task_git_presets",
            id: taskId,
            column: "data",
            source: saved.data,
          },
          GitPresetSchema.parse,
        )
      : GitPresetSchema.parse({
          name: "Standard",
          commit_hooks: "normal",
          push: "normal",
          remote:
            this.engine.db.repository(task.repo_id).origin_remote || "origin",
          branch: task.branch_name,
        });
  };
  private verifiedTask = (id: string) => {
    const verification = taskVerification(this.engine.db, id);
    if (!verification.canReview)
      throw new AdeError("verification_blocked", verification.summary);
    return verification;
  };
  private selectionGap = (record: Finalization) => {
    if (record.review_source !== "selection") return null;
    const required = this.verifiedTask(record.task_id).checks.filter(
      (check) =>
        check.required &&
        check.kind === "check" &&
        check.command &&
        check.command !==
          JSON.stringify(["git", "diff", "--check", record.base, "--"]),
    );
    const commands = this.engine.db.all<VerificationCommand>(
      "SELECT id,run_id,command,status,exit_code FROM test_runs WHERE run_id=? ORDER BY started_at,rowid",
      record.review_run_id,
    );
    const result = verificationSummary(
      {
        verification: required.map((check) => ({
          name: check.name,
          command: check.command,
          kind: check.kind,
          outcome: "not_run",
          required: true,
          detail:
            "Required check must be observed against this selected projection.",
          prerequisite: null,
        })),
      },
      commands,
    );
    return result.checks.some(
      (check) => check.required && check.outcome !== "passed",
    )
      ? result.summary
      : null;
  };
  private verifiedSelection = (record: Finalization) => {
    const gap = this.selectionGap(record);
    if (gap) throw new AdeError("verification_blocked", gap);
  };
  inspect = async (id: string) => {
    const task = this.engine.db.task(id);
    const cwd = await this.workspaces.source(task);
    const diff = await this.engine.git.diff(task);
    const hasImplementation =
      this.engine.db.all(
        "SELECT id FROM task_artifacts WHERE task_id=? AND stage=3 AND kind='plan' LIMIT 1",
        id,
      ).length > 0;
    const implementation = planSchemas[3].safeParse(
      hasImplementation ? this.engine.db.artifact(id, 3) : null,
    );
    const reviewedPaths = new Set(
      implementation.success ? implementation.data.filesChanged : [],
    );
    const files = [];
    for (const file of diff.files) {
      let size = 0;
      let excluded: string | null = null;
      try {
        size = (await workspaceEntry(cwd, file.path)).metadata?.size ?? 0;
        size = (await inspectSelectedFile(cwd, file.path, file.untracked)).size;
      } catch (error) {
        excluded = redact(
          error instanceof Error ? error.message : String(error),
        );
      }
      const committed =
        (
          await gitCapture(
            [
              "diff",
              "--name-only",
              task.base_commit_sha,
              "HEAD",
              "--",
              `:(literal)${file.path}`,
            ],
            cwd,
          )
        ).stdout.length > 0;
      files.push({
        ...file,
        size,
        excluded,
        committed,
        reviewed: reviewedPaths.has(file.path),
      });
    }
    const ignored = await gitExecute({
      program: "git",
      args: ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
      cwd,
      rawStdoutForIntegrity: true,
    });
    if (ignored.code !== 0 || ignored.stdout_truncated)
      throw new AdeError(
        "git_finalization",
        "Ignored-file evidence is incomplete.",
      );
    return {
      files,
      ignored: ignored.stdout.split("\0").filter(Boolean).slice(0, 200),
      fingerprint: await this.engine.git.fingerprint(task),
      hook_configuration: await this.hookConfiguration(cwd),
      preset: this.preset(id),
      history: this.store
        .list(id)
        .map((record) => FinalizationViewSchema.parse(record)),
      active: this.active.has(id),
    };
  };
  preview = async (input: unknown) => {
    const request = SelectedFilesInput.parse(input);
    const digest = createHash("sha256")
      .update(JSON.stringify(request))
      .digest("hex");
    const existing = this.store
      .list(request.id)
      .find((record) => record.id === request.request_id);
    if (existing) {
      if (existing.request_digest !== digest)
        throw new AdeError(
          "idempotency",
          "This Git request ID was already used with different selected files.",
        );
      return existing;
    }
    return this.exclusive(
      request.id,
      "Preparing selected Git files",
      async (signal) => {
        const task = this.engine.db.task(request.id);
        this.verifiedTask(task.id);
        if (
          !["completed", "ready_for_review"].includes(task.status) ||
          planSchemas[5].parse(this.engine.db.artifact(task.id, 5)).approval !==
            "approved"
        )
          throw new AdeError(
            "review_required",
            "Finish the independent final review before Git finalization.",
          );
        if (
          this.store
            .list(task.id)
            .some(
              (record) =>
                ["committing", "pushing", "uncertain"].includes(
                  record.status,
                ) ||
                (record.status === "interrupted" && !!record.head),
            )
        )
          throw new AdeError(
            "reconciliation",
            "Reconcile the previous Git operation before preparing another selection.",
          );
        const state = await this.inspect(task.id);
        if (state.fingerprint !== request.expected_hash)
          throw new AdeError(
            "review_changed",
            "Task files or index changed. Reload the changed-file list.",
          );
        const selected = new Set(request.paths);
        if (
          selected.size !== request.paths.length ||
          request.paths.some(
            (path) =>
              !state.files.some((file) => file.path === path && !file.excluded),
          )
        )
          throw new AdeError(
            "file_selection",
            "Select unique, inspected changed files only.",
          );
        if (
          state.files.some(
            (file) =>
              file.committed && (!selected.has(file.path) || file.excluded),
          )
        )
          throw new AdeError(
            "file_selection",
            "Existing task commits are part of publication and cannot be omitted. Remove unsafe content and request a fresh final review.",
          );
        const paths = new Set(request.paths);
        for (const file of state.files.filter((file) =>
          selected.has(file.path),
        ))
          if (file.old_path) paths.add(file.old_path);
        const staged = state.files
          .filter((file) => file.staged && selected.has(file.path))
          .map((file) => file.path);
        if (staged.length && !request.replace_selected_staged)
          throw new AdeError(
            "staged_changes",
            "Explicitly confirm replacing the selected files' staged hunks with their complete reviewed contents. Other staged files remain unchanged.",
          );
        const cwd = await this.workspaces.source(task);
        const parent = await gitChecked(["rev-parse", "HEAD"], cwd);
        const record: Finalization = FinalizationSchema.parse({
          id: request.request_id,
          task_id: task.id,
          request_digest: digest,
          status: "preparing",
          source_hash: state.fingerprint,
          source_content_hash: await this.engine.git.contentFingerprint(task),
          source_index: await gitChecked(
            ["ls-files", "--stage", "-v", "-z"],
            cwd,
            signal,
          ),
          projected_index: "",
          hook_configuration: await this.hookConfiguration(cwd, signal),
          parent,
          base: task.base_commit_sha,
          paths: [...paths].sort(),
          staged_paths: staged,
          preview_path: join(
            this.engine.root,
            "worktrees",
            task.repo_id,
            `finalization-${request.request_id}`,
          ),
          preview_branch: `vibestar-finalization/${request.request_id}`,
          tree: null,
          review: null,
          review_source: null,
          approved_at: null,
          message: null,
          preset: request.preset ?? this.preset(task.id),
          head: null,
          committed_source_hash: null,
          destination: null,
          error: null,
          pid: null,
          process_identity: null,
          created_at: now(),
          updated_at: now(),
        });
        this.store.save(record);
        this.store.event(
          record,
          "Preparing selected files",
          `${record.paths.length} literal paths; original worktree and index preserved`,
        );
        try {
          await this.workspaces.create(
            record,
            task,
            new Set(
              state.files
                .filter((file) => file.untracked)
                .map((file) => file.path),
            ),
            signal,
          );
          if ((await this.engine.git.fingerprint(task)) !== record.source_hash)
            throw new AdeError(
              "review_changed",
              "Source files changed while preparing the selection.",
            );
          await this.git(
            record,
            record.preview_path,
            ["diff", "--cached", "--check", record.base, "--"],
            signal,
          );
          const full = state.files.every((file) => selected.has(file.path));
          if (full && task.final_review_hash === record.source_hash) {
            record.review = planSchemas[5].parse(
              this.engine.db.artifact(task.id, 5),
            );
            record.review_source = "pipeline";
            record.status = "reviewed";
          } else record.status = "draft";
          this.store.save(record);
          return record;
        } catch (error) {
          record.status = "failed";
          record.error = redact(String(error));
          this.store.save(record);
          throw error;
        }
      },
    );
  };
  private current = async (record: Finalization, signal: AbortSignal) => {
    const task = this.engine.db.task(record.task_id);
    this.verifiedTask(task.id);
    await this.workspaces.source(task);
    if ((await this.engine.git.fingerprint(task)) !== record.source_hash)
      throw new AdeError(
        "review_changed",
        "The task's files, index or commits changed. Prepare a new selection and review.",
      );
    const cwd = await this.workspaces.unchanged(record, task, signal);
    return { task, cwd };
  };
  review = (taskId: string, id: string) =>
    this.exclusive(
      taskId,
      "Independent review of selected Git files",
      async (signal) => {
        const record = this.store.get(taskId, id);
        if (!["draft", "reviewed"].includes(record.status))
          throw new AdeError(
            "invalid_state",
            "Prepare a selected-file preview before review.",
          );
        const { task, cwd } = await this.current(record, signal);
        const required = this.verifiedTask(task.id).checks.filter(
          (check) =>
            check.required &&
            check.kind === "check" &&
            check.command &&
            check.command !==
              JSON.stringify(["git", "diff", "--check", record.base, "--"]),
        );
        await this.git(
          record,
          cwd,
          ["diff", "--cached", "--check", record.base, "--"],
          signal,
        );
        record.status = "reviewing";
        record.error = null;
        this.store.save(record);
        this.store.event(
          record,
          "Reviewing selected files",
          "Antigravity receives the isolated projected worktree. Unselected task changes are absent.",
        );
        try {
          record.review = planSchemas[5].parse(
            await this.engine.reviewFinalization(
              this.workspaces.assignment(record, task),
              `Independently review this exact selected-file projection for issue ${task.issue_url}. Compare the staged tree with pinned base ${record.base}. Only these literal task paths were selected: ${JSON.stringify(record.paths)}. Unselected worktree changes are excluded. Check correctness, missing dependent changes, security, tests and scope. Re-run these required application checks against this projection and preserve observed command results: ${JSON.stringify(required.map((check) => ({ name: check.name, command: check.command })))}. The host separately checks the staged pinned-base diff. Inspect existing tooling before installs; explain blocked checks without claiming they passed. Do not modify files, commit, publish, authorize publication or assume the previous whole-workspace approval applies. Return approved only when this projected change set is independently acceptable.`,
              signal,
            ),
          );
          await this.current(record, signal);
          record.review_source = "selection";
          record.review_run_id =
            this.engine.db.all<{ id: string }>(
              "SELECT id FROM agent_runs WHERE task_id=? AND purpose='git-finalization-review' ORDER BY started_at DESC,rowid DESC LIMIT 1",
              task.id,
            )[0]?.id || null;
          record.verification_gap = this.selectionGap(record);
          record.status = "reviewed";
          record.approved_at = null;
          this.store.save(record);
          return record;
        } catch (error) {
          record.status = "draft";
          record.review = null;
          record.error = redact(String(error));
          this.store.save(record);
          throw error;
        }
      },
    );
  approve = (taskId: string, id: string) =>
    this.exclusive(taskId, "Approving selected Git files", async (signal) => {
      const record = this.store.get(taskId, id);
      if (
        record.status !== "reviewed" ||
        record.review?.approval !== "approved"
      )
        throw new AdeError(
          "review_required",
          "Successful independent review of this exact selection is required.",
        );
      await this.current(record, signal);
      record.approved_at = now();
      this.verifiedSelection(record);
      record.status = "approved";
      this.store.event(
        record,
        "Manual approval",
        `Selected tree ${record.tree}`,
      );
      this.store.save(record);
      return record;
    });
  private hookConfiguration = async (cwd: string, signal?: AbortSignal) => {
    const extension = await gitExecute({
      program: "git",
      cwd,
      signal,
      rawStdoutForIntegrity: true,
      args: [
        "config",
        "--local",
        "--no-includes",
        "--type=bool",
        "--get",
        "extensions.worktreeConfig",
      ],
    });
    if (![0, 1].includes(extension.code))
      throw new AdeError(
        "hook_policy",
        `Cannot read worktree configuration (${extension.code}): ${redact(extension.stderr)}`,
      );
    const scopes =
      extension.code === 0 && extension.stdout.trim() === "true"
        ? ["--worktree", "--local"]
        : ["--local"];
    for (const scope of scopes) {
      const value = await gitExecute({
        program: "git",
        cwd,
        signal,
        rawStdoutForIntegrity: true,
        args: ["config", scope, "--no-includes", "--get", "core.hooksPath"],
      });
      if (value.code === 0) {
        const path = value.stdout.endsWith("\n")
          ? value.stdout.slice(0, -1)
          : value.stdout;
        if (Buffer.byteLength(path) > 4096)
          throw new AdeError(
            "hook_policy",
            "Optional hook path exceeds the supported filesystem path limit.",
          );
        return path;
      }
      if (value.code !== 1)
        throw new AdeError(
          "hook_policy",
          `Cannot read optional hook configuration (${value.code}): ${redact(value.stderr)}`,
        );
    }
    return null;
  };
  private hooks = async (
    record: Finalization,
    names: string[],
    signal: AbortSignal,
    messageFile?: string,
  ) => {
    const task = this.engine.db.task(record.task_id);
    const cwd = await this.workspaces.assert(record, task);
    const common = await this.engine.git.commonDirectory(cwd);
    const source = await this.workspaces.source(task);
    const configured = await this.hookConfiguration(source, signal);
    if (configured !== record.hook_configuration)
      throw new AdeError(
        "hook_policy",
        "Optional hook configuration changed after the selected preview. Prepare a fresh preview or explicitly skip optional hooks.",
      );
    if (configured === "/dev/null") {
      this.store.event(
        record,
        "Optional hook policy",
        "Repository/worktree configuration explicitly disables optional hooks.",
      );
      return;
    }
    if (
      configured !== null &&
      (!configured || configured.startsWith("~") || configured.includes("\\"))
    )
      throw new AdeError(
        "hook_policy",
        "Optional hook configuration must identify an authorized worktree or shared Git hook directory.",
      );
    const sourceDirectory =
      configured === null ? join(common, "hooks") : resolve(source, configured);
    const directory =
      sourceDirectory === source || inside(source, sourceDirectory)
        ? resolve(cwd, relative(source, sourceDirectory))
        : sourceDirectory;
    const sharedHooks = join(common, "hooks");
    if (directory === cwd || inside(cwd, directory)) {
      if (directory !== cwd) await managedPath(cwd, directory);
    } else if (directory === sharedHooks || inside(sharedHooks, directory))
      await managedPath(common, directory);
    else
      throw new AdeError(
        "hook_policy",
        "Optional hooks outside the authorized worktree or shared Git hooks directory cannot run. Configure a supported local directory or explicitly skip optional hooks.",
      );
    const metadata = await lstat(directory).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    if (
      metadata &&
      (!metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        (await realpath(directory)) !== directory)
    )
      throw new AdeError(
        "hook_policy",
        "Optional hooks must be regular executables in the physical Git hooks directory.",
      );
    for (const name of names) {
      const path = join(directory, name);
      const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!entry || !(entry.mode & 0o111)) {
        if (sourceDirectory !== directory) {
          const original = await lstat(join(sourceDirectory, name)).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null;
              throw error;
            },
          );
          if (original && original.mode & 0o111)
            throw new AdeError(
              "hook_policy",
              "A configured optional hook is missing from the selected review workspace. Include its files in a fresh review or explicitly skip optional hooks.",
            );
        }
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink())
        throw new AdeError(
          "hook_policy",
          "Optional hook aliases are not supported.",
        );
      const args =
        name === "pre-push"
          ? [record.destination!.remote, record.destination!.url]
          : name === "pre-commit" || name === "post-commit"
            ? []
            : [
                messageFile!,
                ...(name === "prepare-commit-msg" ? ["message"] : []),
              ];
      const invocation = await sandboxInvocation(
        this.engine.root,
        this.engine.db,
        this.workspaces.assignment(record, task),
        { program: path, args },
        true,
        undefined,
        undefined,
        undefined,
        messageFile ? [messageFile] : [],
      );
      const outputBudget = new OutputBudget(1024 * 1024);
      let outputLines = 0;
      const result = await execute({
        ...invocation,
        cwd,
        signal,
        timeoutMs: 120000,
        onSpawn: (pid, identity) => {
          record.pid = pid;
          record.process_identity = identity;
          this.store.save(record);
        },
        input:
          name === "pre-push"
            ? `refs/heads/${task.branch_name} ${record.head} refs/heads/${record.destination!.branch} ${record.destination!.expected_remote}\n`
            : undefined,
        onLine: (stream, line) => {
          outputBudget.consume(line);
          if (++outputLines > 2048)
            throw new AdeError(
              "output_limit",
              "Optional hook output exceeded 2,048 lines. Inspect saved output before retrying or explicitly skipping optional hooks.",
            );
          this.store.event(record, `${name} ${stream}`, line);
          this.engine.changed(task.id);
        },
      });
      record.pid = null;
      record.process_identity = null;
      this.store.save(record);
      this.store.event(
        record,
        `Optional ${name}`,
        result.stderr || result.stdout,
        result.code,
      );
      if (result.code !== 0)
        throw new AdeError(
          "hook_failed",
          `Optional ${name} exited ${result.code}. Inspect its saved output or explicitly choose to skip optional hooks.`,
        );
    }
  };
  commit = (taskId: string, id: string, message: string, skipHooks: boolean) =>
    this.exclusive(taskId, "Committing selected Git files", async (signal) => {
      CommitMessageSchema.parse(message);
      const record = this.store.get(taskId, id);
      if (
        ["committed", "prepared", "published", "not_published"].includes(
          record.status,
        )
      ) {
        if (
          record.message !== message ||
          (record.preset.commit_hooks === "skip") !== skipHooks
        )
          throw new AdeError(
            "idempotency",
            "This operation already created a different commit. Start a new selection.",
          );
        return record;
      }
      if (
        record.status !== "approved" ||
        !record.approved_at ||
        record.review?.approval !== "approved"
      )
        throw new AdeError(
          "manual_review",
          "Manually approve this exact reviewed selection before committing.",
        );
      const { cwd } = await this.current(record, signal);
      this.verifiedSelection(record);
      record.message = message;
      record.preset.commit_hooks = skipHooks ? "skip" : "normal";
      this.store.save(record);
      const messageFile = await managedPath(
        this.engine.root,
        join("artifacts", `git-message-${record.id}-${randomUUID()}.txt`),
      );
      await writeFile(messageFile, message, { flag: "wx", mode: 0o600 });
      if (!skipHooks)
        await this.hooks(
          record,
          ["pre-commit", "prepare-commit-msg", "commit-msg"],
          signal,
          messageFile,
        );
      await this.current(record, signal);
      record.head = await createExactCommit(
        cwd,
        record.tree!,
        record.parent,
        message,
        signal,
      );
      record.status = "committing";
      this.store.save(record);
      this.store.event(
        record,
        "Creating commit",
        `Exact message; selected tree ${record.tree}; parent ${record.parent}`,
      );
      try {
        await this.applyLocalCommit(record, signal);
        if (!skipHooks)
          await this.hooks(record, ["post-commit"], signal).catch((error) =>
            this.store.event(record, "Post-commit diagnostic", String(error)),
          );
        return record;
      } catch (error) {
        record.status = "interrupted";
        record.error = redact(String(error));
        this.store.save(record);
        throw error;
      }
    });
  private indexAfterCommit = (record: Finalization) => {
    const selected = new Set(record.paths);
    const entries = new Map<string, string>();
    for (const [source, includeSelected] of [
      [record.source_index, false],
      [record.projected_index, true],
    ] as const)
      for (const entry of source.split("\0").filter(Boolean)) {
        const path = entry.slice(entry.indexOf("\t") + 1);
        if (selected.has(path) === includeSelected) entries.set(path, entry);
      }
    return [...entries]
      .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map(([, entry]) => `${entry}\0`)
      .join("");
  };
  private localState = async (record: Finalization, signal: AbortSignal) => {
    const task = this.engine.db.task(record.task_id);
    const source = await this.workspaces.source(task);
    await this.workspaces.unchanged(record, task, signal);
    if (
      !record.head ||
      !record.approved_at ||
      record.review?.approval !== "approved" ||
      (await gitChecked(
        ["rev-parse", `${record.head}^{tree}`],
        source,
        signal,
      )) !== record.tree ||
      (await this.engine.git.contentFingerprint(task)) !==
        record.source_content_hash
    )
      throw new AdeError(
        "reconciliation",
        "Commit recovery found changed contents or missing approval. Files and index were preserved for inspection.",
      );
    const head = await gitChecked(["rev-parse", "HEAD"], source, signal);
    const index = await gitChecked(
      ["ls-files", "--stage", "-v", "-z"],
      source,
      signal,
    );
    const expectedIndex = this.indexAfterCommit(record);
    if (
      ![record.parent, record.head].includes(head) ||
      ![record.source_index, expectedIndex].includes(index) ||
      (head === record.parent &&
        (await this.engine.git.fingerprint(task)) !== record.source_hash)
    )
      throw new AdeError(
        "reconciliation",
        "The task branch or staged state changed during the interrupted commit. No recovery write was attempted.",
      );
    return { task, source, head, index, expectedIndex };
  };
  private applyLocalCommit = async (
    record: Finalization,
    signal: AbortSignal,
  ) => {
    this.verifiedTask(record.task_id);
    this.verifiedSelection(record);
    const { task, source, head } = await this.localState(record, signal);
    const preview = await this.workspaces.assert(record, task);
    const previewHead = await gitChecked(
      ["rev-parse", "HEAD"],
      preview,
      signal,
    );
    if (previewHead === record.parent)
      await this.git(
        record,
        preview,
        [
          "update-ref",
          `refs/heads/${record.preview_branch}`,
          record.head!,
          record.parent,
        ],
        signal,
      );
    else if (previewHead !== record.head)
      throw new AdeError(
        "reconciliation",
        "The isolated commit branch changed. It was preserved.",
      );
    if (head === record.parent)
      await this.git(
        record,
        source,
        [
          "update-ref",
          `refs/heads/${task.branch_name}`,
          record.head!,
          record.parent,
        ],
        signal,
      );
    const indexPaths = new Set(
      [record.source_index, record.projected_index].flatMap((source) =>
        source
          .split("\0")
          .filter(Boolean)
          .map((entry) => entry.slice(entry.indexOf("\t") + 1)),
      ),
    );
    const restorePaths = record.paths.filter((path) => indexPaths.has(path));
    if (restorePaths.length)
      await this.git(
        record,
        source,
        [
          "restore",
          "--staged",
          `--source=${record.head}`,
          "--",
          ...restorePaths.map((path) => `:(literal)${path}`),
        ],
        signal,
      );
    if (
      (await this.engine.git.contentFingerprint(task)) !==
        record.source_content_hash ||
      (await gitChecked(
        ["ls-files", "--stage", "-v", "-z"],
        source,
        signal,
      )) !== this.indexAfterCommit(record)
    )
      throw new AdeError(
        "reconciliation",
        "Files or staged state changed during commit recovery. Publication remains blocked.",
      );
    record.committed_source_hash = await this.engine.git.fingerprint(task);
    record.status = "committed";
    record.error = null;
    this.store.event(record, "Commit created", record.head!, 0);
    this.store.save(record);
    return record;
  };
  private destination = async (record: Finalization, signal: AbortSignal) => {
    const task = this.engine.db.task(record.task_id);
    const repo = this.engine.db.repository(task.repo_id);
    const cwd = await this.workspaces.source(task);
    if (!repo.origin_url)
      throw new AdeError(
        "destination",
        "Connect a contribution fork before publishing. The local commit is preserved.",
      );
    const url = githubTransport(repo.origin_url);
    for (const mode of [[], ["--push"]]) {
      const actual = await gitChecked(
        ["remote", "get-url", ...mode, "--all", record.preset.remote],
        cwd,
      );
      if (actual.split("\n").length !== 1 || githubTransport(actual) !== url)
        throw new AdeError(
          "destination",
          "The selected remote does not identify the configured contribution repository.",
        );
    }
    if (
      (
        await gitCapture(
          ["check-ref-format", `refs/heads/${record.preset.branch}`],
          cwd,
          signal,
        )
      ).code !== 0
    )
      throw new AdeError("destination", "Invalid target branch.");
    const repository = `${remoteIdentity(url).owner}/${remoteIdentity(url).name}`;
    const fresh = identitySchema.parse(await this.identity(repository, signal));
    if (
      !fresh.permissions.push ||
      fresh.full_name.toLowerCase() !== repository.toLowerCase()
    )
      throw new AdeError(
        "permission",
        "The connected GitHub account cannot publish to this exact repository.",
      );
    const upstream = remoteIdentity(repo.upstream_url);
    const upstreamName = `${upstream.owner}/${upstream.name}`;
    if (
      repository.toLowerCase() === upstreamName.toLowerCase() ||
      !fresh.fork ||
      fresh.parent?.full_name.toLowerCase() !== upstreamName.toLowerCase()
    )
      throw new AdeError(
        "destination",
        "Publishing requires the configured contribution fork of this upstream; direct upstream publication is blocked.",
      );
    return {
      remote: record.preset.remote,
      url,
      repository: fresh.full_name,
      repository_id: fresh.id,
      upstream: upstreamName,
      branch: record.preset.branch,
      viewer: fresh.viewer,
      expected_remote: await this.remoteHead(record, url, signal),
    };
  };
  private remoteHead = async (
    record: Finalization,
    url: string,
    signal: AbortSignal,
  ) => {
    const cwd = await this.workspaces.source(
      this.engine.db.task(record.task_id),
    );
    const destination = this.transport?.(url) ?? url;
    const result = await gitExecute({
      program: "git",
      cwd,
      signal,
      allowLocalTransport: !!this.transport,
      rawStdoutForIntegrity: true,
      args: [
        "ls-remote",
        "--heads",
        "--",
        destination,
        `refs/heads/${record.preset.branch}`,
      ],
    });
    if (result.code !== 0 || result.stdout_truncated)
      throw new AdeError(
        "remote_head",
        "Cannot establish the exact remote state. Retry reconciliation when connected.",
      );
    const rows = result.stdout.trim().split("\n").filter(Boolean);
    if (!rows.length) return "0".repeat(record.parent.length);
    if (
      rows.length !== 1 ||
      rows[0].split("\t")[1] !== `refs/heads/${record.preset.branch}` ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(rows[0].split("\t")[0])
    )
      throw new AdeError("remote_head", "Remote branch evidence is ambiguous.");
    return rows[0].split("\t")[0];
  };
  private committed = async (record: Finalization, signal: AbortSignal) => {
    const task = this.engine.db.task(record.task_id);
    this.verifiedTask(task.id);
    this.verifiedSelection(record);
    const cwd = await this.workspaces.source(task);
    if (
      !record.head ||
      !record.approved_at ||
      record.review?.approval !== "approved" ||
      !record.committed_source_hash ||
      (await this.engine.git.fingerprint(task)) !==
        record.committed_source_hash ||
      (await gitChecked(["rev-parse", "HEAD"], cwd, signal)) !== record.head ||
      (await gitChecked(
        ["rev-parse", `${record.head}^{tree}`],
        cwd,
        signal,
      )) !== record.tree
    )
      throw new AdeError(
        "review_changed",
        "The approved local commit, file selection or task index changed. Publishing remains blocked.",
      );
    return cwd;
  };
  prepare = (
    taskId: string,
    id: string,
    destination?: z.infer<typeof destinationInput>,
  ) =>
    this.exclusive(
      taskId,
      "Checking Git publication destination",
      async (signal) => {
        const record = this.store.get(taskId, id);
        if (!["committed", "not_published", "prepared"].includes(record.status))
          throw new AdeError(
            "invalid_state",
            "Commit locally and reconcile any uncertain operation before preparing publication.",
          );
        await this.committed(record, signal);
        if (destination)
          record.preset = {
            ...record.preset,
            ...destinationInput.parse(destination),
          };
        record.destination = await this.destination(record, signal);
        const cwd = await this.workspaces.source(this.engine.db.task(taskId));
        const ancestor = /^0+$/.test(record.destination.expected_remote)
          ? record.base
          : record.destination.expected_remote;
        if (
          (
            await gitCapture(
              ["merge-base", "--is-ancestor", ancestor, record.head!],
              cwd,
              signal,
            )
          ).code !== 0
        )
          throw new AdeError(
            "ancestry",
            "The target branch is not an ancestor of this commit. Choose a new feature branch or integrate and independently review its history before publishing.",
          );
        record.status = "prepared";
        record.error = null;
        this.store.event(
          record,
          "Ready for explicit push confirmation",
          `${record.destination.repository} ${record.destination.branch}; expected ${record.destination.expected_remote}; local ${record.head}`,
        );
        this.store.save(record);
        return record;
      },
    );
  publish = (taskId: string, id: string, skipHooks: boolean) =>
    this.exclusive(taskId, "Publishing approved Git commit", async (signal) => {
      const record = this.store.get(taskId, id);
      if (record.status === "published") return record;
      if (record.status !== "prepared" || !record.destination)
        throw new AdeError(
          "confirmation",
          "Prepare and explicitly confirm the exact publication destination first.",
        );
      const cwd = await this.committed(record, signal);
      const fresh = await this.destination(record, signal);
      if (JSON.stringify(fresh) !== JSON.stringify(record.destination))
        throw new AdeError(
          "stale_remote_head",
          "Remote head, account, permission or destination changed after preparation. Review a fresh confirmation.",
        );
      const releaseDestination = await this.engine.git.acquireWrite(
        cwd,
        `pr:${fresh.repository_id}:${fresh.branch}`,
      );
      try {
        if (!skipHooks) await this.hooks(record, ["pre-push"], signal);
        await this.committed(record, signal);
        record.status = "pushing";
        record.preset.push = skipHooks ? "skip" : "normal";
        this.store.save(record);
        this.store.event(
          record,
          "Publishing",
          `${fresh.repository} ${fresh.branch}; optional pre-push hooks ${skipHooks ? "skipped" : "checked"}; mandatory host guard enforced`,
        );
        try {
          const result = await publishFastForward(
            {
              cwd,
              destination: this.transport?.(fresh.url) ?? fresh.url,
              branch: fresh.branch,
              expectedRemote: fresh.expected_remote,
              localHead: record.head!,
              ancestryBase: record.base,
              skipHooks,
              allowLocalTransport: !!this.transport,
              signal,
              onSpawn: (pid, identity) => {
                record.pid = pid;
                record.process_identity = identity;
                this.store.save(record);
              },
            },
            this.push,
          );
          this.store.event(
            record,
            "Push process completed",
            result.stderr || result.stdout,
            result.code,
          );
          if (result.code !== 0)
            record.error = redact(result.stderr || result.stdout);
        } catch (error) {
          record.error = redact(String(error));
        }
        record.status = "uncertain";
        record.pid = null;
        record.process_identity = null;
        this.store.save(record);
        return this.reconcileRecord(record);
      } finally {
        await releaseDestination();
      }
    });
  private reconcileRecord = async (record: Finalization) => {
    if (["committing", "interrupted"].includes(record.status) && record.head) {
      try {
        const state = await this.localState(record, AbortSignal.timeout(30000));
        if (state.head === record.head && state.index === state.expectedIndex) {
          record.status = "committed";
          record.committed_source_hash = await this.engine.git.fingerprint(
            state.task,
          );
          record.error = null;
        } else {
          record.status = "interrupted";
          record.error =
            "The exact local commit is preserved. Explicitly resume the local branch/index update; reconciliation performed no writes.";
        }
      } catch (error) {
        record.status = "interrupted";
        record.error = redact(String(error));
      }
      this.store.save(record);
      return record;
    }
    if (
      !["pushing", "uncertain"].includes(record.status) ||
      !record.destination
    )
      return record;
    try {
      const remote = await this.remoteHead(
        record,
        record.destination.url,
        AbortSignal.timeout(60000),
      );
      if (remote === record.head) {
        record.status = "published";
        record.error = null;
        this.store.event(
          record,
          "Push verified",
          `${record.destination.repository} ${record.destination.branch} now equals ${record.head}`,
          0,
        );
      } else if (remote === record.destination.expected_remote) {
        record.status = "not_published";
        this.store.event(
          record,
          "Not published",
          "Remote still equals the previously confirmed head. Explicit preparation and confirmation are required before retry.",
        );
      } else {
        record.status = "failed";
        record.error =
          "The remote moved to a different commit. Fetch and review it before any further publication.";
        this.store.event(record, "Remote changed", record.error);
      }
    } catch (error) {
      record.status = "uncertain";
      record.error = redact(String(error));
    }
    this.store.save(record);
    this.engine.changed(record.task_id);
    return record;
  };
  private dispatch = async (method: string, input: unknown) => {
    if (method === "remove") {
      const request = operationInput
        .extend({ confirmed: z.literal(true) })
        .strict()
        .parse(input);
      return this.exclusive(
        request.id,
        "Removing an owned Git review preview",
        async (signal) => {
          const record = this.store.get(request.id, request.operation_id);
          if (
            ["committing", "pushing", "uncertain"].includes(record.status) ||
            (record.status === "interrupted" && record.head)
          )
            throw new AdeError(
              "reconciliation",
              "Reconcile the saved commit or push before removing its recovery journal.",
            );
          const task = this.engine.db.task(request.id);
          const repo = this.engine.db.repository(task.repo_id);
          const cwd = await this.workspaces.unchanged(record, task, signal);
          if (
            await gitChecked(
              ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
              cwd,
              signal,
            )
          )
            throw new AdeError(
              "review_changed",
              "The review preview contains unexpected ignored files. Preserve and inspect them before removal.",
            );
          const head = await gitChecked(["rev-parse", "HEAD"], cwd, signal);
          if (![record.parent, record.head].includes(head))
            throw new AdeError(
              "ownership",
              "The isolated preview branch changed. It was preserved.",
            );
          await this.git(
            record,
            repo.path,
            ["worktree", "remove", "--force", "--", record.preview_path],
            signal,
          );
          await this.git(
            record,
            repo.path,
            ["update-ref", "-d", `refs/heads/${record.preview_branch}`, head],
            signal,
          );
          await this.git(
            record,
            repo.path,
            [
              "config",
              "--local",
              "--remove-section",
              `branch.${record.preview_branch}`,
            ],
            signal,
          );
          this.store.remove(record.id);
          return null;
        },
      );
    }
    if (method === "inspect")
      return this.inspect(
        z.object({ id: z.string().uuid() }).strict().parse(input).id,
      );
    if (method === "preview") return this.preview(input);
    if (method === "preset") {
      const request = z
        .object({ id: z.string().uuid(), preset: GitPresetSchema })
        .strict()
        .parse(input);
      if (this.active.has(request.id) || this.engine.isActive(request.id))
        throw new AdeError(
          "busy",
          "Wait for the active Git or task operation.",
        );
      this.engine.db.task(request.id);
      this.engine.db.run(
        "INSERT INTO task_git_presets VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET data=excluded.data",
        request.id,
        JSON.stringify(request.preset),
      );
      return request.preset;
    }
    if (method === "commit") {
      const request = operationInput
        .extend({
          message: CommitMessageSchema,
          skip_hooks: z.boolean(),
          confirmed: z.literal(true),
        })
        .strict()
        .parse(input);
      return this.commit(
        request.id,
        request.operation_id,
        request.message,
        request.skip_hooks,
      );
    }
    if (method === "publish") {
      const request = operationInput
        .extend({ skip_hooks: z.boolean(), confirmed: z.literal(true) })
        .strict()
        .parse(input);
      return this.publish(request.id, request.operation_id, request.skip_hooks);
    }
    if (method === "resumeCommit") {
      const request = operationInput
        .extend({ confirmed: z.literal(true) })
        .strict()
        .parse(input);
      return this.exclusive(
        request.id,
        "Resuming the exact local Git commit",
        async (signal) => {
          const record = this.store.get(request.id, request.operation_id);
          if (
            !["interrupted", "committing"].includes(record.status) ||
            !record.head
          )
            throw new AdeError(
              "invalid_state",
              "No interrupted local commit to resume.",
            );
          await this.localState(record, signal);
          record.status = "committing";
          this.store.save(record);
          return this.applyLocalCommit(record, signal);
        },
      );
    }
    if (method === "approve") {
      const request = operationInput
        .extend({ confirmed: z.literal(true) })
        .strict()
        .parse(input);
      return this.approve(request.id, request.operation_id);
    }
    if (method === "cancel") {
      const request = z.object({ id: z.string().uuid() }).strict().parse(input);
      const operation = this.active.get(request.id);
      if (!operation)
        throw new AdeError("invalid_state", "No active Git operation.");
      operation.controller.abort();
      await operation.promise.catch(() => {});
      return null;
    }
    if (method === "prepare") {
      const request = operationInput
        .extend({ destination: destinationInput.optional() })
        .strict()
        .parse(input);
      return this.prepare(
        request.id,
        request.operation_id,
        request.destination,
      );
    }
    if (method === "detail" || method === "output") {
      const request = operationInput
        .extend({ before: z.number().int().positive().optional() })
        .strict()
        .parse(input);
      const record = this.store.get(request.id, request.operation_id);
      const events = this.store.events(record.id, request.before);
      const output = {
        record: FinalizationViewSchema.parse(record),
        events: events.slice(-200),
        events_older: events.length > 200,
        active: this.active.has(request.id),
      };
      if (method === "output") return output;
      try {
        const task = this.engine.db.task(request.id);
        const cwd = await this.workspaces.assert(record, task);
        const diff = await gitExecute({
          program: "git",
          cwd,
          args: [
            "diff",
            "--cached",
            "--no-ext-diff",
            "--no-textconv",
            record.base,
            "--",
          ],
        });
        if (diff.code !== 0)
          throw new Error(`Diff unavailable: ${diff.stderr}`);
        return {
          ...output,
          diff: diff.stdout,
          diff_truncated: !!diff.stdout_truncated,
        };
      } catch (error) {
        return {
          ...output,
          diff: "",
          diff_truncated: false,
          diff_error: redact(
            error instanceof Error ? error.message : String(error),
          ),
        };
      }
    }
    const request = operationInput.parse(input);
    if (method === "review")
      return this.review(request.id, request.operation_id);
    if (method === "reconcile")
      return this.exclusive(
        request.id,
        "Reconciling Git publication",
        async () =>
          this.reconcileRecord(
            this.store.get(request.id, request.operation_id),
          ),
      );
    throw new AdeError(
      "invalid_method",
      `Unknown Git finalization method: ${method}`,
    );
  };
  call = async (method: string, input: unknown) => {
    const result = await this.dispatch(method, input);
    const record = FinalizationSchema.safeParse(result);
    return record.success ? FinalizationViewSchema.parse(record.data) : result;
  };
  close = async () => {
    for (const operation of this.active.values()) operation.controller.abort();
    await Promise.allSettled(
      [...this.active.values()].map((operation) => operation.promise),
    );
  };
}
