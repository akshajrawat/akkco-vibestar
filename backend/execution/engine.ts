import { gitChecked } from "../workspace/git-command";
import { StreamedPlan } from "./streamed-plan";
import { validatePlan, object } from "./providers/contracts";
import { sandboxInvocation } from "./sandbox";
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
  private readonly interactive = new Set<string>();
  private readonly creatingTasks = new Map<
    string,
    { digest: string; promise: Promise<Task> }
  >();
  private draining = false;
  private closed = false;
  private closing: Promise<void> | undefined;
  private maintenance = false;
  private readonly taskMaintenance = new Set<string>();
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
    for (const id of this.interactive)
      blockers.push({
        id: `terminal:${id}`,
        kind: "terminal",
        task_id: id,
        label: `${label(id)} terminal session is open`,
        stoppable: true,
      });
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
    for (const id of this.taskMaintenance)
      blockers.push({
        id: `cleanup:${id}`,
        kind: "maintenance",
        task_id: id,
        label: `${label(id)} data cleanup is running`,
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
  withTaskMaintenance = async <T>(id: string, operation: () => Promise<T>) => {
    this.assertAvailable();
    const blockers = this.cleanupBlockers(id);
    if (blockers.length)
      throw new AdeError(
        "busy",
        "Task data cleanup is waiting for this task's active operations to finish.",
        { blockers },
      );
    this.taskMaintenance.add(id);
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
  runRepair = async (
    assignment: WorkspaceAssignment,
    provider: "codex" | "antigravity",
    config: StageConfig,
    prompt: string,
    schema: z.ZodType,
    contextPaths: string[],
    signal: AbortSignal,
  ) => {
    this.assertAvailable();
    const key = `repair:${assignment.id}`;
    if (
      this.active.has(key) ||
      this.active.size >= this.db.settings().concurrency
    )
      throw new AdeError(
        "busy",
        "The configured execution slots are occupied. Start this repair explicitly when a slot is available.",
      );
    const controller = new AbortController();
    const result = Promise.resolve().then(() =>
      this.runner.run(
        { id: assignment.id, stage: provider === "codex" ? 3 : 5 },
        this.db.settings(),
        AbortSignal.any([signal, controller.signal]),
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
    const promise = result
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        this.active.delete(key);
        this.changed();
        void this.drain();
      });
    this.active.set(key, { controller, promise, purpose: "PR repair" });
    try {
      return await result;
    } finally {
      await promise;
    }
  };
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
        "SELECT pid,process_identity FROM agent_runs WHERE status='running' AND pid IS NOT NULL UNION ALL SELECT pid,process_identity FROM test_runs WHERE status='running' AND pid IS NOT NULL UNION ALL SELECT pid,process_identity FROM terminal_sessions WHERE status='running' AND pid IS NOT NULL UNION ALL SELECT pid,process_identity FROM scheduled_agent_runs WHERE status='running' AND pid IS NOT NULL UNION ALL SELECT pid,process_identity FROM utility_runs WHERE status='running' AND pid IS NOT NULL UNION ALL SELECT json_extract(CASE WHEN json_valid(data) THEN data END,'$.workspace.operation.pid'),json_extract(CASE WHEN json_valid(data) THEN data END,'$.workspace.operation.identity') FROM pr_repairs WHERE json_extract(CASE WHEN json_valid(data) THEN data END,'$.workspace.operation.pid') IS NOT NULL UNION ALL SELECT json_extract(CASE WHEN json_valid(data) THEN data END,'$.pid'),json_extract(CASE WHEN json_valid(data) THEN data END,'$.process_identity') FROM repair_publications WHERE status='pushing' AND json_extract(CASE WHEN json_valid(data) THEN data END,'$.pid') IS NOT NULL",
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
  acquireTerminal = (id: string) => {
    this.assertAvailable();
    if (this.taskMaintenance.has(id))
      throw new AdeError("busy", "Task data cleanup is running");
    if (this.isActive(id) || this.db.task(id).status === "queued")
      throw new AdeError(
        "busy",
        "Wait for task execution to finish before opening its terminal",
      );
    this.interactive.add(id);
    this.changed(id);
    return () => {
      this.interactive.delete(id);
      this.changed(id);
      void this.drain();
    };
  };
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
              status: controller.signal.aborted
                ? this.closed
                  ? "interrupted"
                  : "cancelled"
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
        issue,
        execution_settings: settings ?? this.db.settings(),
        branch_name: "",
        base_branch: repo.base_branch,
        base_commit_sha: "",
        worktree_path: "",
        created_at: now(),
        updated_at: now(),
        status: "queued",
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
    void this.drain();
    return t;
  };
  private pipeline = async (t: Task, signal: AbortSignal) => {
    for (; t.stage < 6; t.stage++) {
      if (signal.aborted) throw new AdeError("cancelled", "Task cancelled");
      t.status = stageStatus(t.stage);
      t.updated_at = now();
      t.error = null;
      this.db.saveTask(t);
      this.changed(t.id);
      if (t.stage === 0) {
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
              "INSERT INTO task_activity(task_id,kind,data,timestamp) VALUES(?,'preparation',?,?)",
              t.id,
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
      } else if (t.stage <= 3 || t.stage === 5) {
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
        const implementation = this.db.artifact(t.id, 3);
        if (
          Array.isArray(implementation.testsFailed) &&
          implementation.testsFailed.length
        )
          throw new AdeError(
            "validation",
            "Implementation reported failed tests. Review Tests and retry implementation.",
          );
      }
      if (t.stage === 5) t.final_review_hash = await this.git.fingerprint(t);
      const queued = this.db.all<{ id: string; configuration: string | null }>(
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
      this.db.saveTask({ ...t, status: "cancelled", updated_at: now() });
    }
    this.changed(id);
  };
  retry = async (id: string, stage?: number, restart = false) => {
    this.assertAvailable();
    if (this.taskMaintenance.has(id))
      throw new AdeError("busy", "Task data cleanup is running");
    const t = this.db.task(id);
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
      "SELECT id,configuration FROM task_messages WHERE task_id=? AND status IN ('draft','queued') ORDER BY created_at,rowid",
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
    if (restart || target < 3) {
      t.followup_config = undefined;
      t.continuation = "planning";
    }
    if (target >= 3 && pending.length) {
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
    this.db.run(
      "UPDATE task_messages SET status='delivered' WHERE task_id=? AND status IN ('queued','draft')",
      id,
    );
    if (target <= 3 || target === 5)
      this.db.run(
        "DELETE FROM task_artifacts WHERE task_id=? AND stage>=?",
        id,
        target,
      );
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
  approveStage = async (id: string) => {
    this.assertAvailable();
    const task = this.db.task(id);
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
    if (completedStage === 5 && object(result).approval !== "approved")
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
    const current = this.db.task(id);
    if (
      current.status !== "awaiting_approval" ||
      current.approval_gate !== task.approval_gate ||
      this.isActive(id)
    )
      throw new AdeError(
        "invalid_state",
        "The task changed while approving. Refresh and review its current state.",
      );
    this.db.saveTask({
      ...task,
      approval_gate: undefined,
      stage: target,
      status: target === 6 ? "ready_for_review" : "queued",
      continuation: "pipeline",
      updated_at: now(),
    });
    this.changed(id);
    if (target < 6) void this.drain();
    return this.db.task(id);
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
  ) => {
    const t = this.db.task(id);
    if (!content.trim() || content.length > 32000)
      throw new AdeError(
        "invalid_state",
        "Provide an instruction of 1–32000 characters.",
      );
    const message = {
      id: randomUUID(),
      role: "user",
      content: redact(content),
      created_at: now(),
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
    this.changed(id);
    if (message.status !== "delivered")
      return { message, disposition: message.status };
    const target = continuationStage(this.db, t);
    this.db.run(
      "DELETE FROM task_artifacts WHERE task_id=? AND stage>=?",
      id,
      target,
    );
    this.db.run(
      "UPDATE task_messages SET status='delivered' WHERE task_id=? AND status IN ('draft','queued')",
      id,
    );
    this.db.saveTask({
      ...t,
      followup_config: configuration,
      approval_gate: undefined,
      archived: false,
      continuation: target >= 3 ? "implementation" : "planning",
      stage: target,
      status: "queued",
      error: null,
      updated_at: now(),
    });
    void this.drain();
    return {
      message,
      disposition: target >= 3 ? "implementation" : "resume_planning",
    };
  };
  manual = async (
    id: string,
    argv: string[],
    signal?: AbortSignal,
    internal = false,
    repair?: WorkspaceAssignment,
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
        { program: argv[0], args: argv.slice(1) },
        false,
      );
      const output = await execute({
        ...invocation,
        cwd,
        signal,
        timeoutMs: 1800000,
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
  runCommand = async (id: string, argv: string[]) => {
    this.assertAvailable();
    if (this.taskMaintenance.has(id))
      throw new AdeError("busy", "Task data cleanup is running");
    if (this.isActive(id))
      throw new AdeError("invalid_state", "Task already has an active process");
    const controller = new AbortController();
    const output = Promise.resolve().then(() =>
      this.manual(id, argv, controller.signal, true),
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
