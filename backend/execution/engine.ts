import { gitChecked } from "../workspace/git-command";
import { StreamedPlan } from "./streamed-plan";
import { validatePlan, object } from "./providers/contracts";
import { sandboxInvocation } from "./sandbox";
import type { VerificationEnvironment } from "./browser/contracts";
import { EventEmitter } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { writeFile, rm, mkdir, appendFile } from "node:fs/promises";
import lockfile from "proper-lockfile";
import {
  AdeError,
  FollowupConfigSchema,
  SettingsSchema,
  now,
  parseIssue,
  remoteIdentity,
  repositoryMatchesIssue,
  retryTarget,
  stageStatus,
  type Task,
  type Repository,
  type CoreEvent,
  type ActivityBlocker,
  type IssueRef,
  type WorkspaceAssignment,
  type StageConfig,
} from "../domain";
import { Database } from "../storage/database";
import { GitWorkspace } from "../workspace/git";
import {
  createLayout,
  inside,
  managedPath,
  taskRoot,
  exists,
} from "../workspace/paths";
import { fetchIssue } from "../workspace/issue";
import { taskRuntime } from "../workspace/runtime";
import { execute, processIdentity, terminateGroup, redact } from "./process";
import { AgentRunner } from "./agent-runner";
import { FinalizationStore } from "../finalization/store";
import { CodexProvider } from "./providers/codex";
import { AntigravityProvider } from "./providers/antigravity";
import type { AgentProvider } from "./providers/contracts";
import {
  RepositoryIndex,
  ConnectLocalInput,
  type LocalRepositoryInput,
} from "../workspace/discovery";
import type { z } from "zod";
import { UtilityAI, type UtilityRequest } from "./utility-ai";
import { continuationStage } from "./continuation";
import { taskVerification } from "./task-verification";
import { CommandExecutions } from "./command-executions";
import { missingVerificationChecks } from "./verification-recovery";
import {
  StartWorkflowSchema,
  TaskChatSchema,
  ChatResponseSchema,
  chatPrompt,
} from "./workflow";
export class Engine extends EventEmitter {
  readonly db: Database;
  readonly git: GitWorkspace;
  readonly repositoryIndex: RepositoryIndex;
  readonly utility: UtilityAI;
  private readonly runner: AgentRunner;
  private readonly active = new Map<
    string,
    {
      controller: AbortController;
      promise: Promise<void>;
      taskId?: string;
      purpose?: string;
    }
  >();
  private readonly interactive = new Map<string, string>();
  private readonly creatingTasks = new Map<
    string,
    { digest: string; promise: Promise<Task> }
  >();
  private readonly startingWorkflows = new Map<
    string,
    { digest: string; promise: Promise<Task> }
  >();
  private draining = false;
  private closed = false;
  private closing: Promise<void> | undefined;
  private maintenance = false;
  private readonly taskMaintenance = new Map<string, string>();
  private readonly activities = new Map<
    string,
    { blocker: ActivityBlocker; stop: () => Promise<void> }
  >();
  private readonly repositoryOperations = new Map<Promise<unknown>, string>();
  private readonly repositoryController = new AbortController();
  private readonly localVerifications = new Map<
    string,
    {
      input: z.infer<typeof LocalRepositoryInput>;
      result: Awaited<ReturnType<RepositoryIndex["verifyLocal"]>>;
      expires: number;
    }
  >();
  private repositoryOperation = <T>(
    operation: () => Promise<T>,
    label = "Repository preparation is running",
  ) => {
    this.assertAvailable();
    const result = Promise.resolve()
      .then(operation)
      .finally(() => {
        this.repositoryOperations.delete(result);
        this.changed();
      });
    this.repositoryOperations.set(result, label);
    return result;
  };
  withStorageMaintenance = async <T>(operation: () => Promise<T>) => {
    const blockers = this.cleanupBlockers();
    if (blockers.length)
      throw new AdeError(
        "busy",
        "Storage cleanup is waiting for active operations to finish.",
        { blockers },
      );
    this.maintenance = true;
    try {
      return await operation();
    } finally {
      this.maintenance = false;
      this.changed();
      void this.drain();
    }
  };
  cleanupBlockers = (taskId?: string): ActivityBlocker[] => {
    const tasks = this.db.tasks();
    const label = (id: string) => {
      const task = tasks.find((t) => t.id === id);
      return task ? `Task #${task.issue_number}` : "Utility AI";
    };
    const blockers: ActivityBlocker[] = [];
    for (const [id, activity] of this.active) {
      if (activity.taskId && this.activities.has(`git:${activity.taskId}`))
        continue;
      if (
        id.startsWith("utility:") &&
        (this.activities.has(`pr-watch:${id.slice(8)}`) ||
          this.activities.has(`issue-watch:${id.slice(8)}`))
      )
        continue;
      blockers.push({
        id: `run:${id}`,
        kind: "task",
        task_id:
          activity.taskId || (tasks.some((t) => t.id === id) ? id : undefined),
        label: activity.purpose
          ? `${activity.purpose}${activity.taskId ? ` for ${label(activity.taskId)}` : ""} is running`
          : `${label(id)} is running`,
        stoppable: true,
      });
    }
    for (const [id, activity] of this.interactive) {
      if (this.activities.has(`git:${id}`)) continue;
      blockers.push({
        id: `terminal:${id}`,
        kind: "terminal",
        task_id: id,
        label: `${label(id)} ${activity} is open`,
        stoppable: true,
      });
    }
    for (const task of tasks.filter(
      (t) => t.status === "queued" && !t.archived && !this.active.has(t.id),
    ))
      blockers.push({
        id: `run:${task.id}`,
        kind: "task",
        task_id: task.id,
        label: `${label(task.id)} is queued`,
        stoppable: true,
      });
    for (const { blocker } of this.activities.values()) blockers.push(blocker);
    if (this.maintenance)
      blockers.push({
        id: "storage-maintenance",
        kind: "maintenance",
        label: "Storage cleanup is already running",
        stoppable: false,
      });
    for (const [id, activity] of this.taskMaintenance)
      blockers.push({
        id: `cleanup:${id}`,
        kind: "maintenance",
        task_id: id,
        label: `${label(id)} · ${activity}`,
        stoppable: false,
      });
    if (!taskId)
      for (const [index, description] of [
        ...this.repositoryOperations.values(),
      ].entries())
        blockers.push({
          id: `repository-operation:${index}`,
          kind: "repository",
          label: description,
          stoppable: false,
        });
    return blockers.filter(
      (b) => !taskId || b.task_id === taskId || b.id === "storage-maintenance",
    );
  };
  trackActivity = (blocker: ActivityBlocker, stop: () => Promise<void>) => {
    this.assertAvailable();
    if (blocker.task_id && this.taskMaintenance.has(blocker.task_id))
      throw new AdeError("busy", "Task data cleanup is running", {
        blockers: this.cleanupBlockers(blocker.task_id),
      });
    this.activities.set(blocker.id, { blocker, stop });
    this.changed();
    return () => {
      this.activities.delete(blocker.id);
      this.changed();
    };
  };
  stopActivity = async (id: string) => {
    if (id.startsWith("run:")) {
      const key = id.slice(4);
      const active = this.active.get(key);
      if (active) {
        active.controller.abort();
        await active.promise;
      } else if (
        this.db
          .tasks()
          .some((t) => t.id === key && t.status === "queued" && !t.archived)
      )
        this.cancel(key);
    } else await this.activities.get(id)?.stop();
  };
  withTaskMaintenance = async <T>(
    id: string,
    operation: () => Promise<T>,
    activity = "Data cleanup is running",
  ) => {
    this.assertAvailable();
    const blockers = this.cleanupBlockers(id);
    if (blockers.length)
      throw new AdeError(
        "busy",
        "Task data cleanup is waiting for this task's active operations to finish.",
        { blockers },
      );
    this.taskMaintenance.set(id, activity);
    try {
      return await operation();
    } finally {
      this.taskMaintenance.delete(id);
      this.changed(id);
      void this.drain();
    }
  };
  assertAvailable = () => {
    if (this.maintenance || this.closed)
      throw new AdeError(
        "busy",
        "Vibestar storage is being maintained. Try again when it finishes.",
      );
  };
  private withExecutionSlot = async <T>(
    key: string,
    purpose: string,
    signal: AbortSignal,
    run: (signal: AbortSignal) => Promise<T>,
    taskId?: string,
  ) => {
    this.assertAvailable();
    if (
      this.active.has(key) ||
      this.active.size >= this.db.settings().concurrency
    )
      throw new AdeError(
        "busy",
        "The configured execution slots are occupied. Retry this action explicitly when a slot is available.",
      );
    const controller = new AbortController();
    const result = Promise.resolve().then(() =>
      run(AbortSignal.any([signal, controller.signal])),
    );
    const promise = result
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        this.active.delete(key);
        this.changed(taskId);
        void this.drain();
      });
    this.active.set(key, { controller, promise, purpose, taskId });
    try {
      return await result;
    } finally {
      await promise;
    }
  };
  runRepair = (
    assignment: WorkspaceAssignment,
    provider: "codex" | "antigravity",
    config: StageConfig,
    prompt: string,
    schema: z.ZodType,
    contextPaths: string[],
    signal: AbortSignal,
  ) =>
    this.withExecutionSlot(
      `repair:${assignment.id}`,
      "PR repair",
      signal,
      (combined) =>
        this.runner.run(
          { id: assignment.id, stage: provider === "codex" ? 3 : 5 },
          this.db.settings(),
          combined,
          {
            repair: assignment,
            prompt,
            purpose:
              provider === "codex"
                ? "PR Repair Implementation"
                : "PR Repair Verification",
            provider,
            config,
            schema,
            contextPaths,
          },
        ),
    );
  private constructor(
    readonly root: string,
    private readonly release: () => Promise<void>,
    database: Database,
    providers?: (
      stage: number,
      provider?: "codex" | "antigravity",
    ) => AgentProvider,
    gitTransport?: (url: string) => string,
  ) {
    super();
    this.db = database;
    this.git = new GitWorkspace(
      root,
      (id) => this.db.repository(id),
      gitTransport,
    );
    this.repositoryIndex = new RepositoryIndex(root, this.db, () =>
      this.trackActivity(
        {
          id: "repository-scan",
          kind: "repository_scan",
          label: "Repository scan is active",
          stoppable: true,
        },
        () => this.repositoryIndex.stop(),
      ),
    );
    this.runner = new AgentRunner(
      root,
      this.db,
      this.git,
      this.publish,
      providers ??
        ((stage, provider) =>
          provider === "antigravity" || (stage === 1 && !provider)
            ? new AntigravityProvider()
            : new CodexProvider()),
    );
    this.utility = new UtilityAI(this.db, this.runUtility);
  }
  static create = async (
    root: string,
    providers?: (
      stage: number,
      provider?: "codex" | "antigravity",
    ) => AgentProvider,
    gitTransport?: (url: string) => string,
  ) => {
    root = await createLayout(root);
    const path = join(root, "state", "core.lock");
    await writeFile(path, "", { flag: "a", mode: 0o600 });
    const release = await lockfile.lock(path, {
      stale: 10000,
      update: 5000,
      retries: 0,
    });
    let database: Database | undefined;
    try {
      database = await Database.open(join(root, "state", "vibestar.sqlite"));
      const engine = new Engine(
        root,
        release,
        database,
        providers,
        gitTransport,
      );
      for (const run of engine.db.all<{
        pid: number;
        process_identity: string;
      }>(
        "SELECT pid,process_identity FROM agent_runs WHERE status='running' AND pid IS NOT NULL UNION ALL SELECT pid,process_identity FROM test_runs WHERE status='running' AND pid IS NOT NULL UNION ALL SELECT pid,process_identity FROM terminal_sessions WHERE status='running' AND pid IS NOT NULL UNION ALL SELECT pid,process_identity FROM scheduled_agent_runs WHERE status='running' AND pid IS NOT NULL UNION ALL SELECT pid,process_identity FROM utility_runs WHERE status='running' AND pid IS NOT NULL UNION ALL SELECT json_extract(CASE WHEN json_valid(data) THEN data END,'$.workspace.operation.pid'),json_extract(CASE WHEN json_valid(data) THEN data END,'$.workspace.operation.identity') FROM pr_repairs WHERE json_extract(CASE WHEN json_valid(data) THEN data END,'$.workspace.operation.pid') IS NOT NULL UNION ALL SELECT json_extract(CASE WHEN json_valid(data) THEN data END,'$.pid'),json_extract(CASE WHEN json_valid(data) THEN data END,'$.process_identity') FROM repair_publications WHERE status='pushing' AND json_extract(CASE WHEN json_valid(data) THEN data END,'$.pid') IS NOT NULL UNION ALL SELECT json_extract(CASE WHEN json_valid(data) THEN data END,'$.pid'),json_extract(CASE WHEN json_valid(data) THEN data END,'$.process_identity') FROM git_finalizations WHERE json_extract(CASE WHEN json_valid(data) THEN data END,'$.pid') IS NOT NULL",
      )) {
        if (
          Number.isSafeInteger(run.pid) &&
          run.pid > 1 &&
          run.process_identity &&
          (await processIdentity(run.pid)) === run.process_identity
        )
          terminateGroup(run.pid, "SIGKILL");
      }
      for (const task of engine.db.tasks()) {
        const operation = task.workspace_checkpoint?.operation;
        if (
          operation?.identity &&
          (await processIdentity(operation.pid)) === operation.identity
        )
          terminateGroup(operation.pid, "SIGKILL");
        if (task.workspace_checkpoint)
          task.workspace_checkpoint.operation = null;
        if (task.status === "preserved") {
          engine.db.saveTask(task);
          continue;
        }
        if (task.workflow_version === 1 && !task.workflow_start) {
          engine.db.saveTask({ ...task, stage: 0, status: "not_started" });
          continue;
        }
        if (task.stage === 0 && task.worktree_path) {
          try {
            if (!(await exists(task.worktree_path)))
              throw new AdeError(
                "recovery",
                "The task preparation worktree is missing. Resume explicitly to reconcile its owned branch; the checkpoint was retained.",
              );
            const ready = await engine.git.recoverTaskPreparation(
              engine.db.repository(task.repo_id),
              task,
              (value) => engine.db.saveTask(value),
            );
            engine.db.saveTask({ ...task, stage: ready ? 1 : 0 });
          } catch (error) {
            engine.db.saveTask({
              ...task,
              status: "interrupted",
              error: redact(String(error)),
              updated_at: now(),
            });
          }
        } else if (task.workspace_checkpoint) {
          engine.db.saveTask(task);
        }
      }
      const finalizations = new FinalizationStore(engine.db);
      for (const task of engine.db.tasks())
        for (const record of finalizations.list(task.id)) {
          if (
            ["preparing", "reviewing", "committing", "pushing"].includes(
              record.status,
            )
          ) {
            record.status =
              record.status === "pushing" ? "uncertain" : "interrupted";
            record.error =
              "The execution core restarted. Reconcile this saved Git operation before continuing.";
            record.pid = null;
            record.process_identity = null;
            finalizations.save(record);
          }
        }
      engine.db.recover();
      return engine;
    } catch (error) {
      database?.close();
      await release();
      throw error;
    }
  };
  publish = (e: CoreEvent) => {
    this.emit("event", e);
  };
  changed = (id?: string) => this.publish({ event: "changed", task_id: id });
  isActive = (id: string) => this.active.has(id) || this.interactive.has(id);
  isExecuting = (id: string) => this.active.has(id);
  hasActive = () => this.cleanupBlockers().length > 0;
  acquireTaskWorkspace = (id: string, label: string) => {
    this.assertAvailable();
    if (this.taskMaintenance.has(id))
      throw new AdeError("busy", "Task data cleanup is running");
    if (this.isActive(id) || this.db.task(id).status === "queued")
      throw new AdeError(
        "busy",
        "Wait for task execution to finish before opening its terminal",
      );
    this.interactive.set(id, label);
    this.changed(id);
    return () => {
      this.interactive.delete(id);
      this.changed(id);
      void this.drain();
    };
  };
  acquireTerminal = (id: string) =>
    this.acquireTaskWorkspace(id, "terminal session");
  start = () => {
    void this.drain();
  };
  drain = async () => {
    if (this.draining || this.closed || this.maintenance) return;
    this.draining = true;
    try {
      const limit = this.db.settings().concurrency;
      for (const t of this.db
        .tasks()
        .reverse()
        .filter((t) => t.status === "queued" && !t.archived)) {
        if (this.active.size >= limit) break;
        if (this.isActive(t.id) || this.taskMaintenance.has(t.id)) continue;
        const controller = new AbortController();
        t.status = stageStatus(t.stage);
        this.db.saveTask(t);
        const promise = Promise.resolve()
          .then(() => this.pipeline(t, controller.signal))
          .catch((e) => {
            const latest = this.db.task(t.id);
            this.db.saveTask({
              ...latest,
              ...(latest.stage === 0 && latest.preparation_timing
                ? {
                    preparation_timing: {
                      ...latest.preparation_timing,
                      ended_at: now(),
                    },
                  }
                : {}),
              status: controller.signal.aborted
                ? this.closed
                  ? "interrupted"
                  : "cancelled"
                : e instanceof AdeError && e.kind === "verification_blocked"
                  ? "verification_blocked"
                  : "failed",
              error: redact(e instanceof Error ? e.message : String(e)),
              updated_at: now(),
            });
          })
          .finally(() => {
            this.active.delete(t.id);
            this.changed(t.id);
            void this.drain();
          });
        this.active.set(t.id, { controller, promise });
      }
    } catch (error) {
      if (!(error instanceof AdeError && error.kind === "corrupt_record"))
        throw error;
      this.publish({ event: "core.error", text: error.message });
    } finally {
      this.draining = false;
    }
  };
  register = (...args: Parameters<Engine["registerData"]>) =>
    this.repositoryOperation(() => this.registerData(...args));
  private registerData = async (
    upstream: string,
    origin: string | null,
    base: string,
    deferred = false,
    localPath?: string,
    discover = true,
  ) => {
    this.assertAvailable();
    const { owner, name } = remoteIdentity(upstream);
    if (origin) remoteIdentity(origin);
    if (
      discover &&
      this.db
        .repositories()
        .some(
          (r) =>
            r.owner.toLowerCase() === owner.toLowerCase() &&
            r.name.toLowerCase() === name.toLowerCase(),
        )
    )
      throw new AdeError(
        "repository_exists",
        "Repository is already registered",
      );
    await gitChecked(["check-ref-format", "--branch", base], this.root);
    if (discover && !localPath) await this.repositoryIndex.scan();
    const candidate = localPath
      ? await this.repositoryIndex.inspect(localPath)
      : discover
        ? this.repositoryIndex.matches(`${owner}/${name}`)[0]
        : undefined;
    if (
      candidate &&
      !candidate.identities.includes(`${owner}/${name}`.toLowerCase())
    )
      throw new AdeError(
        "repository_mismatch",
        "Selected checkout does not have a matching GitHub remote.",
      );
    const id = randomUUID();
    const r: Repository = {
      id,
      owner,
      name,
      upstream_url: upstream,
      origin_url: origin,
      base_branch: base,
      path: candidate?.path || join(this.root, "repos", id),
      source: candidate ? "imported" : "managed",
      connected: !(!discover && deferred),
      ...(!discover && deferred ? { clone_status: "cloning" as const } : {}),
      ...(!discover ? { selection: "explicit" as const } : {}),
      last_fetched: null,
      created_at: now(),
    };
    this.db.saveRepository(r);
    if (!deferred) {
      try {
        await this.prepareClone(r);
      } catch (error) {
        this.db.run("DELETE FROM repositories WHERE id=?", r.id);
        throw error;
      }
    }
    this.changed();
    return r;
  };
  prepareClone = (
    r: Repository,
    signal = this.repositoryController.signal,
    localPath?: string,
    onProgress?: (line: string) => void,
  ) =>
    this.repositoryOperation(() =>
      this.git.withLock(r.id, async () => {
        if (r.source === "imported") {
          const candidate = await this.repositoryIndex.inspect(r.path);
          if (
            !candidate.identities.includes(`${r.owner}/${r.name}`.toLowerCase())
          )
            throw new AdeError(
              "repository_mismatch",
              "Imported checkout remotes no longer match this repository.",
            );
          return;
        }
        await managedPath(this.root, r.path);
        // A caller can wait behind the original clone's lock. Refresh its
        // marker before deciding whether an incomplete destination is removable.
        if (r.clone_status === "cloning") {
          const current = this.db.repository(r.id);
          if (current.clone_status === "ready") Object.assign(r, current);
        }
        if (r.clone_status === "cloning" && (await exists(r.path))) {
          if (
            !inside(join(this.root, "repos"), r.path) ||
            this.db.tasks().some((t) => t.repo_id === r.id)
          )
            throw new AdeError(
              "isolation",
              "Cannot remove an incomplete clone with task history or external ownership.",
            );
          await rm(r.path, { recursive: true, force: true });
        }
        if (await exists(join(r.path, ".git"))) return;
        if (r.selection !== "explicit") await this.repositoryIndex.scan();
        const existing = localPath
          ? await this.repositoryIndex.inspect(localPath)
          : r.selection !== "explicit"
            ? this.repositoryIndex.matches(`${r.owner}/${r.name}`)[0]
            : undefined;
        if (existing) {
          if (
            !existing.identities.includes(`${r.owner}/${r.name}`.toLowerCase())
          )
            throw new AdeError(
              "repository_mismatch",
              "Selected checkout does not have a matching GitHub remote.",
            );
          if (
            this.db.tasks().some((t) => t.repo_id === r.id && t.worktree_path)
          )
            throw new AdeError(
              "isolation",
              "This repository has existing task worktrees. Restore its original managed clone before continuing.",
            );
          r.path = existing.path;
          r.source = "imported";
          this.db.saveRepository(r);
          return;
        }
        try {
          await this.git.clone(r.upstream_url, r.path, signal, onProgress);
          onProgress?.("Configuring remotes…");
          if (r.origin_url)
            await gitChecked(
              ["remote", "add", "origin", r.origin_url],
              r.path,
              signal,
            );
          await this.git.fetch(r, signal);
          await gitChecked(
            [
              "rev-parse",
              "--verify",
              `refs/remotes/upstream/${r.base_branch}^{commit}`,
            ],
            r.path,
            signal,
          );
          r.clone_status = "ready";
          this.db.saveRepository(r);
        } catch (error) {
          if (inside(join(this.root, "repos"), r.path)) {
            await managedPath(this.root, r.path);
            await rm(r.path, { recursive: true, force: true });
          }
          throw error;
        }
      }),
    );
  createTask = async (
    repositoryId: string,
    url: string,
    scope: string,
    notes: string,
    scopeMode: "whole_issue" | "partial" = "partial",
    settings?: import("../domain").Settings,
    requestId: string = randomUUID(),
  ) => {
    this.assertAvailable();
    if (
      (scopeMode === "partial" && !scope.trim()) ||
      scope.length > 1000 ||
      notes.length > 32000
    )
      throw new AdeError(
        "invalid_input",
        "Scope is required (max 1000 characters); notes max 32000",
      );
    const reference = parseIssue(url);
    const configuration = settings ? SettingsSchema.parse(settings) : undefined;
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          repository_id: repositoryId,
          issue_url: reference.url.toLowerCase(),
          scope_mode: scopeMode,
          claimed_scope: scopeMode === "partial" ? scope.trim() : "",
          notes,
          settings: configuration || null,
        }),
      )
      .digest("hex");
    const previous = this.existingTaskRequest(requestId, digest);
    if (previous) return previous;
    const active = this.creatingTasks.get(requestId);
    if (active) {
      if (active.digest !== digest)
        throw new AdeError(
          "invalid_input",
          "This task request identity already belongs to a different payload.",
        );
      return active.promise;
    }
    this.taskRepository(repositoryId, reference);
    const promise = this.repositoryOperation(async () => {
      const context = await fetchIssue(
        reference,
        this.root,
        this.repositoryController.signal,
      );
      this.repositoryController.signal.throwIfAborted();
      const repo = {
        ...this.taskRepository(repositoryId, reference),
        selection: "explicit" as const,
      };
      this.db.saveRepository(repo);
      return this.enqueue(
        repo,
        reference,
        scope,
        notes,
        context,
        scopeMode,
        configuration,
        { id: requestId, digest },
        "not_started",
      );
    }, "Issue context retrieval is running").finally(() =>
      this.creatingTasks.delete(requestId),
    );
    this.creatingTasks.set(requestId, { digest, promise });
    return promise;
  };
  private existingTaskRequest = (id: string, digest: string) => {
    const row = this.db.all<{ digest: string; task_id: string | null }>(
      "SELECT digest,task_id FROM task_requests WHERE request_id=?",
      id,
    )[0];
    if (!row) return undefined;
    if (row.digest !== digest)
      throw new AdeError(
        "invalid_input",
        "This task request identity already belongs to a different payload.",
      );
    if (!row.task_id)
      throw new AdeError(
        "request_completed",
        "This request already created a task whose history was removed. Start a new explicit request to create another task.",
      );
    return this.db.task(row.task_id);
  };
  taskRepository = (id: string, reference: IssueRef) => {
    const repo = this.db.repository(id);
    if (repo.connected === false)
      throw new AdeError(
        "repository_missing",
        "Reconnect this repository before creating a task.",
      );
    if (!repositoryMatchesIssue(repo, reference))
      throw new AdeError(
        "repository_mismatch",
        `Repository mismatch: this issue belongs to ${reference.owner}/${reference.repo}. Selected repository: ${repo.owner}/${repo.name}.`,
      );
    return repo;
  };
  verifyLocalRepository = (input: z.infer<typeof LocalRepositoryInput>) =>
    this.repositoryOperation(async () => {
      const result = await this.repositoryIndex.verifyLocal(input);
      for (const [id, verification] of this.localVerifications) {
        if (verification.expires < Date.now())
          this.localVerifications.delete(id);
      }
      if (this.localVerifications.size >= 100)
        this.localVerifications.delete(
          this.localVerifications.keys().next().value!,
        );
      const verification_id = randomUUID();
      this.localVerifications.set(verification_id, {
        input,
        result,
        expires: Date.now() + 10 * 60 * 1000,
      });
      return { ...result, verification_id };
    }, "Local repository verification is running");
  connectLocalRepository = (input: z.infer<typeof ConnectLocalInput>) =>
    this.repositoryOperation(async () => {
      const p = ConnectLocalInput.parse(input);
      const verification = this.localVerifications.get(p.verification_id);
      if (!verification || verification.expires < Date.now())
        throw new AdeError(
          "invalid_input",
          "Verification expired. Verify the repository again before connecting.",
        );
      const current = await this.repositoryIndex.verifyLocal(
        verification.input,
      );
      if (
        current.path !== verification.result.path ||
        JSON.stringify(current.remotes) !==
          JSON.stringify(verification.result.remotes)
      )
        throw new AdeError(
          "repository_changed",
          "Repository location or remotes changed. Verify again before connecting.",
        );
      const upstream = current.remotes.find(
        (r) => r.name === p.upstream_remote && r.identity,
      );
      const origin = p.origin_remote
        ? current.remotes.find((r) => r.name === p.origin_remote && r.identity)
        : null;
      if (!upstream || (p.origin_remote && !origin))
        throw new AdeError(
          "invalid_input",
          "Choose verified GitHub remotes for upstream and origin.",
        );
      if (origin?.name === upstream.name)
        throw new AdeError(
          "invalid_input",
          "Upstream and fork must use different remotes. Choose None if there is no fork.",
        );
      await gitChecked(
        ["check-ref-format", "--branch", p.base_branch],
        current.path,
      );
      if (!current.branches.includes(p.base_branch))
        throw new AdeError(
          "invalid_input",
          "Choose a base branch found in this repository.",
        );
      const { owner, name } = remoteIdentity(upstream.url);
      const existing = this.db
        .repositories()
        .find(
          (r) =>
            r.path === current.path &&
            `${r.owner}/${r.name}`.toLowerCase() ===
              `${owner}/${name}`.toLowerCase(),
        );
      if (
        existing &&
        this.db
          .tasks()
          .some(
            (t) =>
              t.repo_id === existing.id &&
              (this.isActive(t.id) || (t.status === "queued" && !t.archived)),
          )
      )
        throw new AdeError(
          "busy",
          "Stop this repository's tasks before reconnecting.",
        );
      const repo: Repository = {
        id: existing?.id || randomUUID(),
        owner,
        name,
        path: current.path,
        upstream_url: upstream.url,
        origin_url: origin?.url || null,
        upstream_remote: upstream.name,
        origin_remote: origin?.name || null,
        base_branch: p.base_branch,
        source: "imported",
        connected: true,
        selection: "explicit",
        environment: current.environment,
        distro: current.distro,
        ...(current.windows_path ? { windows_path: current.windows_path } : {}),
        last_fetched: existing?.last_fetched || null,
        created_at: existing?.created_at || now(),
      };
      this.db.saveRepository(repo);
      this.localVerifications.delete(p.verification_id);
      this.changed();
      return repo;
    }, "Local repository connection is running");
  disconnectRepository = (id: string) =>
    this.repositoryOperation(async () => {
      const repo = this.db.repository(id);
      const taskIds = this.db
        .tasks()
        .filter((t) => t.repo_id === id)
        .map((t) => t.id);
      const blockers = this.cleanupBlockers().filter(
        (blocker) => blocker.task_id && taskIds.includes(blocker.task_id),
      );
      if (blockers.length)
        throw new AdeError(
          "busy",
          "Stop this repository's active tasks and terminals before disconnecting.",
          { blockers },
        );
      this.db.saveRepository({ ...repo, connected: false });
      this.changed();
      return null;
    }, "Repository disconnection is running");
  reconnectRepository = (id: string) =>
    this.repositoryOperation(async () => {
      const repo = this.db.repository(id);
      if (repo.source === "imported")
        throw new AdeError(
          "invalid_input",
          "Verify the local checkout before reconnecting it.",
        );
      repo.selection = "explicit";
      await this.prepareClone(repo);
      repo.connected = true;
      this.db.saveRepository(repo);
      this.changed();
      return repo;
    }, "Managed repository reconnection is running");
  verifyRepository = (id: string) =>
    this.repositoryOperation(async () => {
      const repo = this.db.repository(id);
      return this.repositoryIndex.verifyLocal(
        { environment: "wsl", path: repo.path },
        repo.source !== "imported",
      );
    }, "Repository verification is running");
  enqueue = (
    repo: Repository,
    reference: IssueRef,
    scope: string,
    notes: string,
    issue: Record<string, unknown>,
    scopeMode: "whole_issue" | "partial" = "partial",
    settings?: import("../domain").Settings,
    request?: { id: string; digest: string },
    status: "queued" | "not_started" = "queued",
  ) => {
    this.assertAvailable();
    const t = this.db.transaction(() => {
      const previous =
        request && this.existingTaskRequest(request.id, request.digest);
      if (previous) return previous;
      const t: Task = {
        id: randomUUID(),
        repo_id: repo.id,
        issue_number: reference.number,
        issue_url: reference.url,
        claimed_scope: scopeMode === "partial" ? scope.trim() : "",
        scope_mode: scopeMode,
        notes,
        verification_policy: "repository",
        issue,
        execution_settings: settings ?? this.db.settings(),
        branch_name: "",
        base_branch: repo.base_branch,
        base_commit_sha: "",
        worktree_path: "",
        created_at: now(),
        updated_at: now(),
        status,
        workflow_version: status === "not_started" ? 1 : undefined,
        stage: 0,
        error: null,
      };
      this.db.run(
        "INSERT INTO issues VALUES(?,?,?) ON CONFLICT(repo_id,number) DO UPDATE SET data=excluded.data",
        repo.id,
        reference.number,
        JSON.stringify(issue),
      );
      this.db.saveTask(t);
      if (request)
        this.db.run(
          "INSERT INTO task_requests VALUES(?,?,?,?)",
          request.id,
          request.digest,
          t.id,
          now(),
        );
      return t;
    });
    this.changed(t.id);
    if (t.status === "queued") void this.drain();
    return t;
  };
  /** Persists explicit startup authority once, after read-only identity and capability checks. */
  startWorkflow = async (input: z.input<typeof StartWorkflowSchema>) => {
    this.assertAvailable();
    const p = StartWorkflowSchema.parse(input);
    if (new Set(p.message_ids).size !== p.message_ids.length)
      throw new AdeError(
        "invalid_input",
        "Select each conversation instruction once.",
      );
    const digest = createHash("sha256")
      .update(JSON.stringify({ ...p, message_ids: [...p.message_ids].sort() }))
      .digest("hex");
    const task = this.db.task(p.id);
    if (task.status === "preserved")
      throw new AdeError(
        "invalid_state",
        "This task's history was removed while its files were preserved. Open the retained worktree in your editor.",
      );
    if (task.workflow_start) {
      if (
        task.workflow_start.request_id !== p.request_id ||
        task.workflow_start.digest !== digest
      )
        throw new AdeError(
          "invalid_state",
          "This task's workflow has already been authorized.",
        );
      return Promise.resolve(task);
    }
    const starting = this.startingWorkflows.get(p.id);
    if (starting) {
      if (starting.digest !== digest)
        throw new AdeError(
          "busy",
          "Another workflow start is being validated for this task.",
        );
      return starting.promise;
    }
    if (task.status !== "not_started" || task.archived)
      throw new AdeError(
        "invalid_state",
        "Only an unarchived task whose workflow has not started can start.",
      );
    const promise = this.withTaskMaintenance(
      p.id,
      async () => {
        const repo = this.taskRepository(
          task.repo_id,
          parseIssue(task.issue_url),
        );
        const repositoryIdentity = JSON.stringify(repo);
        if (await exists(repo.path)) {
          const verified = await this.repositoryIndex.verifyLocal(
            { environment: "wsl", path: repo.path },
            repo.source !== "imported",
          );
          if (
            !verified.remotes.some(
              (remote) =>
                remote.url === repo.upstream_url ||
                remote.identity?.toLowerCase() ===
                  `${repo.owner}/${repo.name}`.toLowerCase(),
            )
          )
            throw new AdeError(
              "repository_mismatch",
              "The checkout no longer matches the registered repository. Verify its connection before starting.",
            );
        } else if (repo.source === "imported") {
          throw new AdeError(
            "repository_missing",
            "Reconnect the missing source checkout before starting.",
          );
        }
        await this.runner.validateWorkflow(
          task,
          this.repositoryController.signal,
        );
        for (const id of p.message_ids) {
          if (
            !this.db.all(
              "SELECT id FROM task_messages WHERE id=? AND task_id=? AND purpose='chat' AND status='chat_completed'",
              id,
              task.id,
            ).length
          )
            throw new AdeError(
              "invalid_input",
              "Selected conversation instructions must belong to this task and be complete.",
            );
        }
        // Re-read immediately before the atomic authorization; metadata discovery is read-only.
        const current = this.db.task(task.id);
        if (
          JSON.stringify(
            this.taskRepository(task.repo_id, parseIssue(task.issue_url)),
          ) !== repositoryIdentity
        )
          throw new AdeError(
            "repository_mismatch",
            "The repository connection changed during startup. Inspect it and start explicitly again.",
          );
        if (current.status !== "not_started" || current.archived)
          throw new AdeError(
            "invalid_state",
            "The task changed while workflow startup was being checked.",
          );
        const started = {
          ...current,
          status: "queued" as const,
          workflow_start: {
            request_id: p.request_id,
            digest,
            started_at: now(),
            message_ids: p.message_ids,
            summary: redact(p.summary),
          },
          error: null,
          updated_at: now(),
        };
        this.db.saveTask(started);
        this.changed(task.id);
        return started;
      },
      "Checking workflow startup",
    ).finally(() => this.startingWorkflows.delete(p.id));
    this.startingWorkflows.set(p.id, { digest, promise });
    return promise;
  };
  /** Runs a persisted read-only question through AgentRunner without advancing workflow authority. */
  chat = (input: z.input<typeof TaskChatSchema>) => {
    this.assertAvailable();
    const p = TaskChatSchema.parse(input);
    const task = this.db.task(p.id);
    if (task.status === "preserved")
      throw new AdeError(
        "invalid_state",
        "This task's conversation history was removed. Its retained worktree can be opened in your editor.",
      );
    this.taskRepository(task.repo_id, parseIssue(task.issue_url));
    const existing = this.db.all<{
      id: string;
      task_id: string;
      content: string;
      configuration: string;
      purpose: string;
      status: string;
    }>("SELECT * FROM task_messages WHERE id=?", p.request_id)[0];
    if (existing) {
      if (
        existing.task_id !== task.id ||
        existing.purpose !== "chat" ||
        existing.content !== redact(p.content) ||
        existing.configuration !== JSON.stringify(p.configuration)
      )
        throw new AdeError(
          "invalid_input",
          "This conversation request belongs to a different message.",
        );
      return { message: existing, disposition: existing.status };
    }
    if (
      task.archived ||
      task.status === "queued" ||
      this.cleanupBlockers(task.id).length ||
      this.active.size >= this.db.settings().concurrency
    )
      throw new AdeError(
        "busy",
        "Wait for this task's active operation and an available execution slot before asking a question.",
      );
    const message = {
      id: p.request_id,
      role: "user",
      content: redact(p.content),
      created_at: now(),
      status: "chat_pending",
      purpose: "chat",
    };
    this.db.run(
      "INSERT INTO task_messages(id,task_id,role,content,created_at,status,configuration,purpose) VALUES(?,?,?,?,?,?,?,'chat')",
      message.id,
      task.id,
      message.role,
      message.content,
      message.created_at,
      message.status,
      JSON.stringify(p.configuration),
    );
    const prompt = chatPrompt(this.db, task, p.content);
    void this.withExecutionSlot(
      task.id,
      "Read-only conversation",
      this.repositoryController.signal,
      async (signal) => {
        if (!task.worktree_path || task.workspace_checkpoint?.state !== "ready")
          await this.prepareTaskWorkspace(task, signal, "chat_preparation");
        const result = ChatResponseSchema.parse(
          await this.runner.run(
            { ...task, stage: 1 },
            task.execution_settings || this.db.settings(),
            signal,
            {
              prompt,
              purpose: "Read-only conversation",
              schema: ChatResponseSchema,
              provider: p.configuration.provider,
              config: p.configuration.config,
              messageId: message.id,
            },
          ),
        );
        this.db.transaction(() => {
          this.db.run(
            "UPDATE task_messages SET status='chat_completed' WHERE id=? AND task_id=?",
            message.id,
            task.id,
          );
          this.db.run(
            "INSERT INTO task_messages(id,task_id,role,content,created_at,status,run_id,purpose) SELECT ?,task_id,'assistant',?,?,'chat_completed',run_id,'chat' FROM task_messages WHERE id=?",
            randomUUID(),
            redact(result.summary),
            now(),
            message.id,
          );
        });
      },
      task.id,
    )
      .catch((error) => {
        this.db.run(
          "UPDATE task_messages SET status=? WHERE id=? AND task_id=?",
          (error instanceof AdeError && error.kind === "cancelled") ||
            (error instanceof Error && error.name === "AbortError")
            ? "chat_cancelled"
            : "chat_failed",
          message.id,
          task.id,
        );
        this.db.run(
          "INSERT INTO task_activity(task_id,kind,data,timestamp) VALUES(?,'chat_error',?,?)",
          task.id,
          JSON.stringify({
            message_id: message.id,
            error: redact(String(error)),
          }),
          now(),
        );
      })
      .finally(() => this.changed(task.id));
    this.changed(task.id);
    return { message, disposition: message.status };
  };
  private prepareTaskWorkspace = async (
    t: Task,
    signal: AbortSignal,
    kind = "preparation",
  ) => {
    const repo = this.db.repository(t.repo_id);
    await this.prepareClone(repo, signal);
    const logDir = join(this.root, "logs", t.id);
    await mkdir(logDir, { recursive: true, mode: 0o700 });
    await this.git.prepare(
      repo,
      t,
      signal,
      (checkpoint) => this.db.saveTask(checkpoint),
      async (record) => {
        this.db.run(
          "INSERT INTO task_activity(task_id,kind,data,timestamp) VALUES(?,?,?,?)",
          t.id,
          kind,
          JSON.stringify(record),
          now(),
        );
        this.changed(t.id);
        await appendFile(
          join(logDir, "preparation.jsonl"),
          JSON.stringify(record) + "\n",
          { mode: 0o600 },
        );
      },
    );
    this.db.saveRepository(repo);
    this.db.saveTask(t);
  };
  private pipeline = async (t: Task, signal: AbortSignal) => {
    for (; t.stage < 6; t.stage++) {
      if (signal.aborted) throw new AdeError("cancelled", "Task cancelled");
      t.status = stageStatus(t.stage);
      t.updated_at = now();
      t.error = null;
      if (t.stage === 0)
        t.preparation_timing = { started_at: now(), ended_at: null };
      this.db.saveTask(t);
      this.changed(t.id);
      if (t.stage === 0) {
        await this.prepareTaskWorkspace(t, signal);
        if (t.preparation_timing) t.preparation_timing.ended_at = now();
        this.db.saveTask(t);
      } else if (t.stage <= 3 || t.stage === 5) {
        if (t.stage === 5) {
          const verification = taskVerification(this.db, t.id);
          if (
            !verification.canReview &&
            !(
              verification.canReviewWithGaps &&
              t.review_gap_acknowledgment &&
              t.review_gap_acknowledgment.evidence_hash ===
                this.verificationEvidenceHash(t.id) &&
              t.review_gap_acknowledgment.fingerprint ===
                (await this.git.fingerprint(t))
            )
          )
            throw new AdeError(
              "verification_blocked",
              "Review requires verified checks or a current explicit acknowledgment of environmental gaps.",
            );
        }
        const runtime = await taskRuntime(
          this.db.repository(t.repo_id).path,
          t.worktree_path,
          true,
        );
        t.runtime = {
          python: runtime.python,
          dependencies: runtime.dependencies,
          warnings: runtime.warnings,
        };
        this.db.saveTask(t);
        // Refresh authored context at each approved stage, never invoke a model to fetch it.
        if (t.issue.context_fetched_at || t.issue.number === t.issue_number) {
          t.issue = await fetchIssue(
            parseIssue(t.issue_url),
            this.root,
            signal,
          );
          this.db.saveTask(t);
        }
        await this.runner.run(
          t,
          t.execution_settings ?? this.db.settings(),
          signal,
        );
      } else {
        const output = await this.manual(
          t.id,
          ["git", "diff", "--check", t.base_commit_sha, "--"],
          signal,
          true,
        );
        if (output.code !== 0)
          throw new AdeError(
            "validation",
            "git diff --check failed. Inspect Tests.",
          );
        const verification = taskVerification(this.db, t.id);
        if (!verification.canReview)
          throw new AdeError(
            verification.outcome === "failed"
              ? "validation"
              : "verification_blocked",
            verification.summary,
          );
      }
      if (t.stage === 5) {
        t.final_review_hash = await this.git.fingerprint(t);
        t.final_review_verdict = this.savedReviewVerdict(t.id);
      }
      const queued =
        t.stage === 4
          ? []
          : this.db.all<{ id: string; configuration: string | null }>(
              "SELECT id,configuration FROM task_messages WHERE task_id=? AND status='queued' ORDER BY created_at,rowid",
              t.id,
            );
      if (queued.length) {
        const message = queued.at(-1)!;
        if (message.configuration)
          t.followup_config = this.db.records.decode(
            {
              table: "task_messages",
              id: message.id,
              column: "configuration",
              source: message.configuration,
            },
            FollowupConfigSchema.parse,
          );
        this.db.run(
          "UPDATE task_messages SET status='delivered' WHERE task_id=? AND status='queued'",
          t.id,
        );
        if (t.stage >= 3) {
          this.db.run(
            "DELETE FROM task_artifacts WHERE task_id=? AND stage>=3",
            t.id,
          );
          t.final_review_hash = undefined;
          t.final_review_verdict = undefined;
          t.review_gap_acknowledgment = undefined;
          t.stage = 2;
          t.continuation = "implementation";
        } else if (t.stage === 1) {
          this.db.run(
            "DELETE FROM task_artifacts WHERE task_id=? AND stage>=1",
            t.id,
          );
          t.stage = 0;
        } else if (t.stage === 2) {
          this.db.run(
            "DELETE FROM task_artifacts WHERE task_id=? AND stage>=2",
            t.id,
          );
          t.stage = 1;
        }
      }
      const nextStage = t.stage + 1;
      const approvalGate = queued.length
        ? undefined
        : t.stage === 1
          ? "antigravity_plan"
          : t.stage === 2
            ? "codex_plan"
            : t.stage === 4
              ? "implementation"
              : t.stage === 5
                ? "final_review"
                : undefined;
      if (approvalGate) {
        this.db.saveTask({
          ...t,
          stage: nextStage,
          approval_gate: approvalGate,
          status: "awaiting_approval",
          updated_at: now(),
        });
        this.changed(t.id);
        return;
      }
      this.db.saveTask({ ...t, stage: nextStage, approval_gate: undefined });
    }
    t.status = "ready_for_review";
    t.updated_at = now();
    this.db.saveTask(t);
  };
  cancel = (id: string) => {
    if (this.interactive.has(id))
      throw new AdeError(
        "busy",
        "Close the task terminal before changing execution state",
      );
    const active = this.active.get(id);
    if (active) active.controller.abort();
    else {
      const t = this.db.task(id);
      if (t.workflow_version === 1 && !t.workflow_start) return;
      this.db.saveTask({ ...t, status: "cancelled", updated_at: now() });
    }
    this.changed(id);
  };
  retry = async (id: string, stage?: number, restart = false) => {
    this.assertAvailable();
    if (this.taskMaintenance.has(id))
      throw new AdeError("busy", "Task data cleanup is running");
    const t = this.db.task(id);
    if (
      t.status === "preserved" ||
      (t.workflow_version === 1 && !t.workflow_start)
    )
      throw new AdeError(
        "workflow_not_started",
        "Use Start workflow to explicitly authorize this task's first execution.",
      );
    if (t.status === "awaiting_approval" && stage === undefined && !restart)
      throw new AdeError(
        "approval_required",
        "Review and approve the saved stage before continuing.",
      );
    if (this.db.repository(t.repo_id).connected === false)
      throw new AdeError(
        "repository_missing",
        "Reconnect the source repository before resuming this task.",
      );
    if (t.stage === 0 && t.worktree_path && !this.isActive(id)) {
      if (
        await this.git.recoverTaskPreparation(
          this.db.repository(t.repo_id),
          t,
          (value) => this.db.saveTask(value),
        )
      )
        t.stage = 1;
    }
    const pending = this.db.all<{ id: string; configuration: string | null }>(
      "SELECT id,configuration FROM task_messages WHERE task_id=? AND status='queued' ORDER BY created_at,rowid",
      id,
    );
    const target = restart
      ? t.worktree_path
        ? 1
        : 0
      : (stage ??
        (pending.length
          ? continuationStage(this.db, t)
          : Math.min(t.stage, 5)));
    if (t.approval_gate && !restart) {
      const completedStage =
        t.approval_gate === "antigravity_plan"
          ? 1
          : t.approval_gate === "codex_plan"
            ? 2
            : t.approval_gate === "implementation"
              ? 4
              : 5;
      if (target > completedStage)
        throw new AdeError(
          "approval_required",
          "Approve the saved stage before starting a later stage.",
        );
    }
    retryTarget(t, target, this.isActive(id));
    if (target >= 2) this.db.artifact(id, 1);
    if (target >= 3) this.db.artifact(id, 2);
    if (target === 5) this.db.artifact(id, 3);
    if (target === 5 && !taskVerification(this.db, id).canReview)
      throw new AdeError(
        "approval_required",
        "Recheck saved evidence, then explicitly acknowledge current environmental gaps before starting another independent review.",
      );
    if (restart || target < 3) {
      t.followup_config = undefined;
      t.continuation = "planning";
    }
    if (target === 3 && pending.length) {
      t.continuation = "implementation";
      const message = pending.at(-1)!;
      if (message.configuration)
        t.followup_config = this.db.records.decode(
          {
            table: "task_messages",
            id: message.id,
            column: "configuration",
            source: message.configuration,
          },
          FollowupConfigSchema.parse,
        );
    }
    if (target <= 3)
      this.db.run(
        "UPDATE task_messages SET status='delivered' WHERE task_id=? AND status='queued'",
        id,
      );
    if (target <= 3 || target === 5)
      this.db.run(
        "DELETE FROM task_artifacts WHERE task_id=? AND stage>=?",
        id,
        target,
      );
    if (target <= 3) {
      t.review_gap_acknowledgment = undefined;
      t.final_review_hash = undefined;
      t.final_review_verdict = undefined;
    }
    const updated: Task = {
      ...t,
      archived: false,
      approval_gate: undefined,
      stage: target,
      status: "queued",
      error: null,
      updated_at: now(),
    };
    this.db.saveTask(updated);
    this.changed(id);
    void this.drain();
    return updated;
  };
  approveStage = async (
    id: string,
    instructions?: {
      disposition: "keep_saved" | "include_next_stage";
      message_ids: string[];
    },
    artifactId?: string,
    gapAcknowledgment?: { fingerprint: string; evidence_hash: string },
  ) => {
    this.assertAvailable();
    const original = this.db.task(id);
    const task =
      gapAcknowledgment &&
      original.status === "verification_blocked" &&
      original.stage === 4
        ? ({
            ...original,
            status: "awaiting_approval",
            approval_gate: "implementation",
          } as Task)
        : original;
    if (this.isActive(id) || this.taskMaintenance.has(id))
      throw new AdeError(
        "busy",
        "Wait for task activity to finish before approving.",
      );
    if (this.db.repository(task.repo_id).connected === false)
      throw new AdeError(
        "repository_missing",
        "Reconnect the source repository before continuing.",
      );
    if (task.status !== "awaiting_approval" || !task.approval_gate)
      throw new AdeError(
        "invalid_state",
        "This task is not waiting for a pipeline approval.",
      );
    const target =
      task.approval_gate === "antigravity_plan"
        ? 2
        : task.approval_gate === "codex_plan"
          ? 3
          : task.approval_gate === "implementation"
            ? 5
            : 6;
    const completedStage =
      task.approval_gate === "antigravity_plan"
        ? 1
        : task.approval_gate === "codex_plan"
          ? 2
          : task.approval_gate === "implementation"
            ? 3
            : 5;
    const result = validatePlan(
      completedStage,
      this.db.artifact(id, completedStage),
    );
    if (
      artifactId &&
      this.db.all<{ id: string }>(
        "SELECT id FROM task_artifacts WHERE task_id=? AND stage=? AND kind='plan' ORDER BY created_at DESC,rowid DESC LIMIT 1",
        id,
        completedStage,
      )[0]?.id !== artifactId
    )
      throw new AdeError(
        "stale_review",
        "The saved artifact changed. Open and review the current version before approving.",
      );
    if (completedStage === 3) {
      const verification = taskVerification(this.db, id);
      if (!verification.canReview && !gapAcknowledgment)
        throw new AdeError("verification_blocked", verification.summary);
      if (gapAcknowledgment) {
        const preview = await this.reviewGapsPreview(id);
        if (
          !preview.eligible ||
          preview.fingerprint !== gapAcknowledgment.fingerprint ||
          preview.evidence_hash !== gapAcknowledgment.evidence_hash
        )
          throw new AdeError(
            "stale_review",
            "Verification evidence or the implementation changed. Inspect the current gaps before authorizing review.",
          );
      }
    }
    if (
      completedStage === 5 &&
      (object(result).approval !== "approved" ||
        taskVerification(this.db, id).outcome === "failed" ||
        task.final_review_verdict === "changes_requested")
    )
      throw new AdeError(
        "review_required",
        "Antigravity reported unresolved findings or blocked validation. Request changes or retry the review before completing.",
      );
    if (
      completedStage === 5 &&
      task.final_review_hash !== (await this.git.fingerprint(task))
    )
      throw new AdeError(
        "stale_review",
        "The worktree changed after Antigravity reviewed it. Run the final review again.",
      );
    const pendingIds = () =>
      this.db
        .all<{ id: string }>(
          "SELECT id FROM task_messages WHERE task_id=? AND status IN ('draft','queued') ORDER BY created_at,rowid",
          id,
        )
        .map((message) => message.id);
    const pending = pendingIds();
    if (
      (pending.length && !instructions) ||
      (instructions &&
        (new Set(instructions.message_ids).size !== pending.length ||
          instructions.message_ids.length !== pending.length ||
          pending.some(
            (message) => !instructions.message_ids.includes(message),
          )))
    )
      throw new AdeError(
        "instruction_choice_required",
        "Review the current saved instructions and choose whether to keep them saved or include them in the next stage.",
      );
    if (target === 6 && instructions?.disposition === "include_next_stage")
      throw new AdeError(
        "invalid_state",
        "Final acceptance starts no agent. Keep instructions saved or send feedback explicitly.",
      );
    const current = this.db.task(id);
    if (
      current.status !== original.status ||
      current.approval_gate !== original.approval_gate ||
      JSON.stringify(pendingIds()) !== JSON.stringify(pending) ||
      this.isActive(id)
    )
      throw new AdeError(
        "invalid_state",
        "The task changed while approving. Refresh and review its current state.",
      );
    this.db.transaction(() => {
      if (instructions?.disposition === "include_next_stage")
        for (const message of pending)
          this.db.run(
            "UPDATE task_messages SET status='delivered' WHERE id=? AND task_id=?",
            message,
            id,
          );
      else
        this.db.run(
          "UPDATE task_messages SET status='draft' WHERE task_id=? AND status='queued'",
          id,
        );
      this.db.saveTask({
        ...current,
        approval_gate: undefined,
        stage: target,
        status: target === 6 ? "ready_for_review" : "queued",
        ...(target === 6 && !taskVerification(this.db, id).canReview
          ? { status: "reviewed_with_gaps" as const }
          : {}),
        ...(target === 6
          ? {
              final_review_verdict: taskVerification(this.db, id).canReview
                ? ("verified" as const)
                : ("code_approved_incomplete" as const),
            }
          : {}),
        ...(completedStage === 3
          ? {
              review_gap_acknowledgment: gapAcknowledgment
                ? { ...gapAcknowledgment, acknowledged_at: now() }
                : undefined,
            }
          : {}),
        continuation: "pipeline",
        followup_config: undefined,
        updated_at: now(),
      });
    });
    this.changed(id);
    if (target < 6) void this.drain();
    return this.db.task(id);
  };
  private verificationEvidenceHash = (id: string) =>
    createHash("sha256")
      .update(
        JSON.stringify({
          checks: taskVerification(this.db, id).checks,
          commands: this.db.all(
            "SELECT id,command,status,exit_code,stdout,stderr FROM test_runs WHERE task_id=? ORDER BY started_at,rowid",
            id,
          ),
          implementation: this.db.artifact(id, 3),
        }),
      )
      .digest("hex");
  reviewGapsPreview = async (id: string) => {
    this.assertAvailable();
    const task = this.db.task(id);
    if (this.isActive(id) || this.taskMaintenance.has(id))
      throw new AdeError(
        "busy",
        "Wait for task activity to finish before reviewing gaps.",
      );
    if (
      !(task.stage === 4 && task.status === "verification_blocked") &&
      !(
        task.status === "awaiting_approval" &&
        task.approval_gate === "implementation"
      )
    )
      throw new AdeError(
        "invalid_state",
        "Review gaps at the implementation approval boundary.",
      );
    const verification = taskVerification(this.db, id);
    return {
      eligible: verification.canReviewWithGaps,
      fingerprint: await this.git.fingerprint(task),
      evidence_hash: this.verificationEvidenceHash(id),
      checks: verification.checks.filter(
        (check) => check.required && check.outcome !== "passed",
      ),
    };
  };
  private savedReviewVerdict = (id: string) => {
    const review = object(this.db.artifact(id, 5));
    const verification = taskVerification(this.db, id);
    return review.approval === "changes_requested" ||
      verification.outcome === "failed" ||
      (Array.isArray(review.issues) && review.issues.length > 0) ||
      (Array.isArray(review.implementationConcerns) &&
        review.implementationConcerns.length > 0)
      ? ("changes_requested" as const)
      : review.approval !== "approved"
        ? ("blocked" as const)
        : verification.canReview
          ? ("verified" as const)
          : ("code_approved_incomplete" as const);
  };
  recheckEvidence = async (id: string) => {
    await this.withTaskMaintenance(id, async () => {
      new CommandExecutions(this.db).recoverToolExits(id);
    });
    const task = this.db.task(id);
    if (task.stage < 5 || !task.final_review_hash) return this.retry(id, 4);
    return this.withTaskMaintenance(id, async () => {
      if (task.final_review_hash !== (await this.git.fingerprint(task)))
        throw new AdeError(
          "stale_review",
          "The worktree changed since independent review. Review the changed implementation before accepting it.",
        );
      const output = await this.manual(
        id,
        ["git", "diff", "--check", task.base_commit_sha, "--"],
        undefined,
        true,
      );
      if (output.code !== 0)
        throw new AdeError(
          "validation",
          "git diff --check failed. Inspect Tests.",
        );
      const verdict = this.savedReviewVerdict(id);
      const current = this.db.task(id);
      if (current.final_review_hash !== (await this.git.fingerprint(current)))
        throw new AdeError(
          "stale_review",
          "The worktree changed during validation. Review the changed implementation before accepting it.",
        );
      const updated = {
        ...current,
        final_review_verdict: verdict,
        status: ["reviewed_with_gaps", "ready_for_review"].includes(
          current.status,
        )
          ? verdict === "verified"
            ? ("ready_for_review" as const)
            : ("reviewed_with_gaps" as const)
          : current.status,
        updated_at: now(),
      };
      this.db.saveTask(updated);
      return updated;
    });
  };
  setVerificationPolicy = async (
    id: string,
    policy: "repository" | "extended_browser",
  ) => {
    await this.withTaskMaintenance(id, async () => {
      const task = this.db.task(id);
      if (task.stage < 4)
        throw new AdeError(
          "invalid_state",
          "Wait for implementation before changing verification policy.",
        );
      await this.git.assertTask(task);
      this.db.transaction(() => {
        this.db.saveTask({
          ...this.db.task(id),
          verification_policy: policy,
          updated_at: now(),
        });
        this.db.run(
          "INSERT INTO task_activity(task_id,kind,data,timestamp) VALUES(?,'verification_policy',?,?)",
          id,
          JSON.stringify({ policy, source: "user" }),
          now(),
        );
      });
    });
    return this.recheckEvidence(id);
  };
  runMissingCheck = async (id: string, command: string) => {
    const task = this.db.task(id);
    const candidate = missingVerificationChecks(taskVerification(this.db, id), {
      selected: task.verification_environment,
      report: task.browser_environment_report,
    }).find((check) => check.command === command);
    if (!candidate)
      throw new AdeError(
        "invalid_input",
        "Select an executable recorded check with resolved prerequisites. Setup and arbitrary prose are never executed by this action.",
      );
    return this.runCommand(id, candidate.argv);
  };
  fixWithCodex = (id: string, requestId: string) => {
    this.assertAvailable();
    const existing = this.db.all<{
      task_id: string;
      content: string;
      configuration: string;
    }>(
      "SELECT task_id,content,configuration FROM task_messages WHERE id=?",
      requestId,
    )[0];
    if (existing) {
      if (existing.task_id !== id)
        throw new AdeError(
          "invalid_input",
          "Repair request belongs to another task.",
        );
      return { disposition: "already_requested" };
    }
    if (this.isActive(id) || this.taskMaintenance.has(id))
      throw new AdeError(
        "busy",
        "Wait for task activity to finish before requesting Codex fixes.",
      );
    const task = this.db.task(id);
    if (task.stage < 4)
      throw new AdeError(
        "invalid_state",
        "Implementation must finish before requesting verification fixes.",
      );
    const evidence = taskVerification(this.db, id);
    const settings = task.execution_settings || this.db.settings();
    const review = this.db.all<{ output: string }>(
      "SELECT output FROM agent_runs WHERE task_id=? AND stage=5 ORDER BY started_at DESC,rowid DESC LIMIT 1",
      id,
    )[0]?.output;
    const context = JSON.stringify({
      verification: evidence,
      review,
      commands: this.db.all(
        "SELECT command,status,exit_code,stdout,stderr FROM test_runs WHERE task_id=? ORDER BY started_at,rowid",
        id,
      ),
    });
    this.db.run(
      "INSERT INTO task_activity(task_id,kind,data,timestamp) VALUES(?,'verification_repair',?,?)",
      id,
      context,
      now(),
    );
    return this.followUp(
      id,
      "Fix the demonstrated implementation failures and rerun affected checks in this original worktree. Read the saved verification repair evidence in TASK CONTEXT. For required checks without an executable recorded command, prepare repeatable test scripts using the project's tooling, run feasible checks and report their exact commands, outcomes and prerequisites. Prefer supported check-only npm scripts, node --test, pytest or npx playwright test so Run missing checks can replay the saved commands. Use stable check names to link the new commands to the existing requirements; do not discard requirements or claim unexecuted checks passed. Investigate environmental gaps without repeating failed installation attempts unless prerequisites changed. One Codex iteration is authorized; further iterations require a new explicit request.",
      {
        provider: "codex",
        config: task.stage_settings?.[3] || settings.codex_implementation,
      },
      false,
      requestId,
    );
  };
  acceptDraft = async (id: string, runId: string) => {
    this.assertAvailable();
    const task = this.db.task(id);
    const runs = this.db.all<{
      id: string;
      stage: number;
      status: string;
      purpose: string;
    }>(
      "SELECT id,stage,status,purpose FROM agent_runs WHERE task_id=? ORDER BY started_at,rowid",
      id,
    );
    const run = runs.find((r) => r.id === runId);
    if (
      !run ||
      ![1, 2].includes(run.stage) ||
      run.status === "completed" ||
      !["pipeline", "Antigravity Plan", "Codex Plan Refinement"].includes(
        run.purpose,
      ) ||
      runs.at(-1)?.id !== runId ||
      (task.approval_gate && task.status === "awaiting_approval")
    )
      throw new AdeError(
        "invalid_state",
        "Only the latest unfinished planning run can supply a draft.",
      );
    if (this.interactive.has(id) || this.taskMaintenance.has(id))
      throw new AdeError(
        "busy",
        "Close task activity before using a planning draft.",
      );
    const stored = this.db.all<{ id: string; content: string }>(
      "SELECT id,content FROM task_artifacts WHERE task_id=? AND kind=? ORDER BY created_at DESC LIMIT 1",
      id,
      `draft:${runId}`,
    )[0];
    const draft = stored
      ? this.db.records.decode({
          table: "task_artifacts",
          id: stored.id,
          column: "content",
          source: stored.content,
        })
      : null;
    let plan: unknown = draft?.plan;
    if (!plan) {
      const stream = new StreamedPlan(run.stage);
      for (const event of this.db.all<{ id: number; data: string }>(
        "SELECT id,data FROM agent_events WHERE task_id=? AND run_id=? AND kind='message' ORDER BY id",
        id,
        runId,
      ))
        plan =
          stream.observe(
            this.db.records.decode({
              table: "agent_events",
              id: event.id,
              column: "data",
              source: event.data,
            }),
          ) || plan;
    }
    if (!plan)
      throw new AdeError(
        "missing_draft",
        "This run has not emitted a complete, valid planning draft.",
      );
    const result = validatePlan(run.stage, plan);
    const active = this.active.get(id);
    if (active) {
      active.controller.abort();
      await active.promise;
    }
    if (
      !["failed", "cancelled", "interrupted"].includes(this.db.task(id).status)
    )
      throw new AdeError(
        "invalid_state",
        "The planning stage finished or changed. Review its current result instead.",
      );
    await this.git.assertTask(task);
    if (
      typeof draft?.source_hash === "string" &&
      draft.source_hash.startsWith("issue-v2:")
    ) {
      if (draft.source_hash !== (await this.git.fingerprint(task)))
        throw new AdeError(
          "stale_plan",
          "The worktree changed after this draft. Retry planning against current files.",
        );
    } else {
      throw new AdeError(
        "stale_plan",
        "This historical draft has no comparable current integrity fingerprint. Retry planning against the current files; its saved output is preserved.",
      );
    }
    this.db.run(
      "DELETE FROM task_artifacts WHERE task_id=? AND stage>=? AND kind='plan'",
      id,
      run.stage,
    );
    this.db.run(
      "INSERT INTO task_artifacts VALUES(?,?,?,'plan',?,?)",
      randomUUID(),
      id,
      run.stage,
      JSON.stringify(result),
      now(),
    );
    this.db.saveTask({
      ...task,
      stage: run.stage + 1,
      status: "awaiting_approval",
      approval_gate: run.stage === 1 ? "antigravity_plan" : "codex_plan",
      error: null,
      updated_at: now(),
    });
    this.changed(id);
    return this.db.task(id);
  };
  followUp = (
    id: string,
    content: string,
    configuration?: Task["followup_config"],
    saveOnly = false,
    requestId: string = randomUUID(),
    sendSaved = false,
  ) => {
    const t = this.db.task(id);
    if (
      t.status === "preserved" ||
      (t.workflow_version === 1 && !t.workflow_start && !saveOnly)
    )
      throw new AdeError(
        "workflow_not_started",
        "Ask a read-only question or choose Start workflow before requesting code changes.",
      );
    if (!content.trim() || content.length > 32000)
      throw new AdeError(
        "invalid_state",
        "Provide an instruction of 1–32000 characters.",
      );
    const existing = this.db.all<{
      id: string;
      task_id: string;
      content: string;
      configuration: string | null;
      status: string;
      created_at: string;
    }>("SELECT * FROM task_messages WHERE id=?", requestId)[0];
    if (existing) {
      if (
        existing.task_id !== id ||
        existing.content !== redact(content) ||
        (existing.configuration !==
          (configuration ? JSON.stringify(configuration) : null) &&
          !(sendSaved && existing.status === "draft"))
      )
        throw new AdeError(
          "invalid_state",
          "This message request already belongs to a different instruction.",
        );
      if (!sendSaved || existing.status !== "draft")
        return { message: existing, disposition: existing.status };
    }
    const message = {
      id: requestId,
      role: "user",
      content: redact(content),
      created_at: existing?.created_at ?? now(),
      status:
        saveOnly ||
        this.interactive.has(id) ||
        this.maintenance ||
        this.taskMaintenance.has(id) ||
        this.db.repository(t.repo_id).connected === false
          ? "draft"
          : this.isExecuting(id)
            ? "queued"
            : "delivered",
    };
    const disposition = this.db.transaction(() => {
      if (existing)
        this.db.run(
          "UPDATE task_messages SET status=?,configuration=? WHERE id=? AND task_id=?",
          message.status,
          configuration ? JSON.stringify(configuration) : null,
          message.id,
          id,
        );
      else
        this.db.run(
          "INSERT INTO task_messages(id,task_id,role,content,created_at,status,configuration) VALUES(?,?,?,?,?,?,?)",
          message.id,
          id,
          message.role,
          message.content,
          message.created_at,
          message.status,
          configuration ? JSON.stringify(configuration) : null,
        );
      if (message.status !== "delivered") return message.status;
      const target = continuationStage(this.db, t);
      this.db.run(
        "DELETE FROM task_artifacts WHERE task_id=? AND stage>=?",
        id,
        target,
      );
      this.db.saveTask({
        ...t,
        followup_config: configuration,
        final_review_hash: undefined,
        final_review_verdict: undefined,
        review_gap_acknowledgment: undefined,
        approval_gate: undefined,
        archived: false,
        continuation: target >= 3 ? "implementation" : "planning",
        stage: target,
        status: "queued",
        error: null,
        updated_at: now(),
      });
      return target >= 3 ? "implementation" : "resume_planning";
    });
    this.changed(id);
    if (message.status === "delivered") void this.drain();
    return { message, disposition };
  };
  sendSavedMessage = (
    id: string,
    messageId: string,
    configuration?: Task["followup_config"],
  ) => {
    const message = this.db.all<{
      content: string;
      status: string;
      configuration: string | null;
    }>(
      "SELECT content,status,configuration FROM task_messages WHERE task_id=? AND id=?",
      id,
      messageId,
    )[0];
    if (!message) throw new AdeError("not_found", "Message not found");
    if (message.status !== "draft") return { disposition: message.status };
    if (configuration) message.configuration = JSON.stringify(configuration);
    return this.followUp(
      id,
      message.content,
      message.configuration
        ? this.db.records.decode(
            {
              table: "task_messages",
              id: messageId,
              column: "configuration",
              source: message.configuration,
            },
            FollowupConfigSchema.parse,
          )
        : undefined,
      false,
      messageId,
      true,
    );
  };
  manual = async (
    id: string,
    argv: string[],
    signal?: AbortSignal,
    internal = false,
    repair?: WorkspaceAssignment,
    verification?: {
      environment?: VerificationEnvironment;
      readOnly?: boolean;
      timeoutMs?: number;
    },
  ) => {
    if (
      !argv.length ||
      argv.length > 100 ||
      argv.some((s) => typeof s !== "string")
    )
      throw new AdeError(
        "invalid_input",
        "Provide executable and arguments as a JSON string array",
      );
    if (!internal && this.isActive(id))
      throw new AdeError(
        "invalid_state",
        "Wait for task execution to finish before running a manual command",
      );
    const t = repair || this.db.task(id);
    const cwd = await taskRoot(this.root, t);
    const run = randomUUID();
    this.db.run(
      `INSERT INTO test_runs(id,${repair ? "repair_id" : "task_id"},command,status,started_at) VALUES(?,?,?,'running',?)`,
      run,
      id,
      JSON.stringify(argv),
      now(),
    );
    const owner = repair ? { repair_id: id } : { task_id: id };
    this.publish({ event: "changed", ...owner });
    try {
      const invocation = await sandboxInvocation(
        this.root,
        this.db,
        t,
        {
          program: argv[0],
          args: argv.slice(1),
          verificationEnvironment: verification?.environment,
        },
        verification?.readOnly || false,
      );
      const output = await execute({
        ...invocation,
        cwd,
        signal,
        timeoutMs: verification?.timeoutMs || 1800000,
        onSpawn: (pid, identity) =>
          this.db.run(
            "UPDATE test_runs SET pid=?,process_identity=? WHERE id=?",
            pid,
            identity,
            run,
          ),
        onLine: (stream, text) => {
          const column = stream === "stdout" ? "stdout" : "stderr";
          this.db.run(
            `UPDATE test_runs SET ${column}=substr(${column}||?,-1048576),output_truncated=CASE WHEN length(${column})+length(?)>1048576 THEN 1 ELSE output_truncated END WHERE id=?`,
            `${text}\n`,
            `${text}\n`,
            run,
          );
          this.publish({ event: "command.output", ...owner, stream, text });
        },
      });
      this.db.run(
        "UPDATE test_runs SET status=?,ended_at=?,exit_code=?,duration_ms=?,stdout=?,stderr=?,output_truncated=0 WHERE id=?",
        output.code === 0 ? "passed" : "failed",
        now(),
        output.code,
        output.duration_ms,
        output.stdout,
        output.stderr,
        run,
      );
      return output;
    } catch (e) {
      this.db.run(
        "UPDATE test_runs SET status=?,ended_at=?,stderr=? WHERE id=?",
        signal?.aborted ? "cancelled" : "failed",
        now(),
        String(e),
        run,
      );
      throw e;
    } finally {
      this.publish({ event: "changed", ...owner });
    }
  };
  runCommand = async (id: string, argv: string[], diagnostic = false) => {
    this.assertAvailable();
    if (this.taskMaintenance.has(id))
      throw new AdeError("busy", "Task data cleanup is running");
    if (this.isActive(id))
      throw new AdeError("invalid_state", "Task already has an active process");
    const controller = new AbortController();
    const output = Promise.resolve().then(() =>
      this.manual(id, argv, controller.signal, true, undefined, {
        environment: this.db.task(id).verification_environment,
        readOnly: diagnostic,
        timeoutMs: diagnostic ? 25000 : undefined,
      }),
    );
    const promise = output
      .then(() => {})
      .catch(() => {})
      .finally(() => {
        this.active.delete(id);
        this.changed(id);
        void this.drain();
      });
    this.active.set(id, { controller, promise });
    return output;
  };
  private runUtility = async (
    request: UtilityRequest,
    config: import("../domain").Settings["utility_ai"],
  ) => {
    const id =
      request.context?.scanId || request.context?.jobId || randomUUID();
    const task =
      request.workspace && request.context?.taskId
        ? this.db.task(request.context.taskId)
        : null;
    const key = task?.id || `utility:${id}`;
    if (
      this.closed ||
      this.maintenance ||
      (request.context?.taskId &&
        this.taskMaintenance.has(request.context.taskId)) ||
      this.isActive(key) ||
      this.active.size >= this.db.settings().concurrency ||
      this.db.tasks().some((t) => t.status === "queued" && !t.archived)
    )
      throw new AdeError(
        "busy",
        "Utility analysis is waiting for task execution capacity",
      );
    const workspace =
      request.workspace || join(this.root, "cache", "utility", id);
    if (request.workspace && !task)
      throw new AdeError(
        "isolation",
        "Utility filesystem context requires a linked isolated task",
      );
    const controller = new AbortController();
    const output = Promise.resolve().then(async () => {
      if (!task) {
        await managedPath(this.root, workspace);
        await mkdir(workspace, { recursive: true, mode: 0o700 });
        await managedPath(this.root, workspace);
      }
      return this.runner.run(
        task ? { ...task, stage: 1 } : { id, stage: 1 },
        this.db.settings(),
        request.signal
          ? AbortSignal.any([controller.signal, request.signal])
          : controller.signal,
        {
          prompt: request.prompt,
          purpose: request.purpose,
          workspace,
          schema: request.schema,
          jobId: request.context?.jobId,
          analysisId: request.context?.analysisId,
          watchId: request.context?.watchId,
          scanId: request.context?.scanId,
          telemetryTaskId: request.context?.taskId,
          questionId: request.context?.questionId,
          telemetryRepository: request.context?.repository,
          provider: config.provider,
          config,
        },
      );
    });
    const completed = output.finally(() => {
      this.active.delete(key);
      this.changed(task?.id);
      void this.drain();
    });
    const promise = completed.then(() => {}).catch(() => {});
    this.active.set(key, {
      controller,
      promise,
      taskId: request.context?.taskId,
      purpose: request.purpose,
    });
    return completed;
  };
  reviewFinalization = (task: Task, prompt: string, signal: AbortSignal) =>
    this.withExecutionSlot(
      `git-review:${task.id}`,
      "Selected-file review",
      signal,
      (combined) =>
        this.runner.run(
          { ...task, stage: 5 },
          task.execution_settings ?? this.db.settings(),
          combined,
          { prompt, purpose: "git-finalization-review" },
        ),
      task.id,
    );
  beginShutdown = () => {
    this.closed = true;
    this.repositoryController.abort();
    for (const a of this.active.values()) a.controller.abort();
  };
  close = () =>
    (this.closing ??= (async () => {
      this.beginShutdown();
      try {
        await Promise.allSettled(
          [...this.active.values()].map((a) => a.promise),
        );
        await Promise.allSettled([...this.repositoryOperations.keys()]);
        await Promise.allSettled(
          [...this.startingWorkflows.values()].map(
            (operation) => operation.promise,
          ),
        );
        await this.repositoryIndex.close();
      } finally {
        try {
          this.db.close();
        } finally {
          await this.release();
        }
      }
    })());
  fetchRepository = (id: string) =>
    this.repositoryOperation(
      () => this.fetchRepositoryData(id),
      "Repository fetch is running",
    );
  private fetchRepositoryData = async (id: string) => {
    const r = this.db.repository(id);
    await this.prepareClone(r);
    await this.git.withLock(id, async () => {
      await this.git.fetch(r, this.repositoryController.signal);
      this.db.saveRepository(r);
    });
    this.changed();
    return r;
  };
  providers = async () =>
    Promise.all([
      new AntigravityProvider().detect(this.root),
      new CodexProvider().detect(this.root),
    ]);
  configureRepository = (
    ...args: Parameters<Engine["configureRepositoryData"]>
  ) =>
    this.repositoryOperation(
      () => this.configureRepositoryData(...args),
      "Repository configuration is being updated",
    );
  private configureRepositoryData = async (
    id: string,
    configuration: {
      upstream_url: string;
      origin_url: string | null;
      base_branch: string;
    },
  ) => {
    const r = this.db.repository(id);
    const identity = remoteIdentity(configuration.upstream_url);
    if (
      `${identity.owner}/${identity.name}`.toLowerCase() !==
      `${r.owner}/${r.name}`.toLowerCase()
    )
      throw new AdeError(
        "invalid_input",
        "Upstream must match the managed repository",
      );
    if (configuration.origin_url) remoteIdentity(configuration.origin_url);
    await gitChecked(
      ["check-ref-format", "--branch", configuration.base_branch],
      this.root,
    );
    if (
      this.db
        .tasks()
        .some(
          (t) =>
            t.repo_id === id &&
            (this.isActive(t.id) || (t.status === "queued" && !t.archived)),
        )
    )
      throw new AdeError(
        "busy",
        "Wait for this repository's active tasks before changing its remotes",
      );
    const updated = { ...r, ...configuration };
    await this.git.withLock(id, async () => {
      if (r.source !== "imported" && (await exists(join(r.path, ".git")))) {
        await gitChecked(
          ["remote", "set-url", "upstream", updated.upstream_url],
          r.path,
        );
        const remotes = (await gitChecked(["remote"], r.path)).split("\n");
        if (updated.origin_url)
          await gitChecked(
            [
              "remote",
              remotes.includes("origin") ? "set-url" : "add",
              "origin",
              updated.origin_url,
            ],
            r.path,
          );
        else if (remotes.includes("origin"))
          await gitChecked(["remote", "remove", "origin"], r.path);
      }
      this.db.saveRepository(updated);
    });
    this.changed();
    return updated;
  };
}
