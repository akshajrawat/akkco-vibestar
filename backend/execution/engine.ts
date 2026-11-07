import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import { AdeError, now, type CoreEvent } from "../domain";
import { HistoricalFinalizations } from "../storage/git-history";
import { Database } from "../storage/database";
import { RepositoryIndex } from "../workspace/discovery";
import { GitWorkspace } from "../workspace/git";
import { createLayout, exists } from "../workspace/paths";
import { AgentRunner } from "./agents/agent-runner";
import { AgentOperations } from "./engine/agents";
import { CommandExecution } from "./engine/commands";
import { RepositoryOperations } from "./engine/repositories";
import { EngineScheduling } from "./engine/scheduling";
import { ExecutionState } from "./engine/state";
import { TaskLifecycle } from "./engine/tasks";
import { processIdentity, redact, terminateGroup } from "./runtime/process";
import { AntigravityProvider } from "./providers/antigravity";
import { CodexProvider } from "./providers/codex";
import type { AgentProvider } from "./providers/contracts";
import { UtilityAI } from "./agents/utility-ai";
import { FlowStore } from "../flows/store";
import { FlowRunStore } from "../flows/run-store";
import { assertManagedWorkspace } from "../workspace/managed";
import { FlowExecution } from "./engine/flows";
import { initializeProfiles } from "../flows/defaults";
import { migrateLegacyTasks } from "../flows/legacy-migration";

export class Engine extends EventEmitter {
  private readonly state = new ExecutionState();

  private readonly agents: AgentOperations;

  private readonly commands: CommandExecution;

  private readonly scheduling: EngineScheduling;

  private readonly tasks: TaskLifecycle;

  private readonly repositories: RepositoryOperations;

  private readonly flowExecution: FlowExecution;

  readonly db: Database;

  readonly git: GitWorkspace;

  readonly repositoryIndex: RepositoryIndex;

  readonly utility: UtilityAI;

  readonly flows: FlowStore;

  readonly flowRuns: FlowRunStore;

  private readonly runner: AgentRunner;

  private closing: Promise<void> | undefined;

  private repositoryOperation = <T>(
    operation: () => Promise<T>,
    label = "Repository preparation is running",
  ) => this.scheduling.repositoryOperation(operation, label);

  withStorageMaintenance = <T>(operation: () => Promise<T>) =>
    this.scheduling.withStorageMaintenance(operation);

  cleanupBlockers = (...args: Parameters<EngineScheduling["cleanupBlockers"]>) =>
    this.scheduling.cleanupBlockers(...args);

  trackActivity = (...args: Parameters<EngineScheduling["trackActivity"]>) =>
    this.scheduling.trackActivity(...args);

  stopActivity = (...args: Parameters<EngineScheduling["stopActivity"]>) =>
    this.scheduling.stopActivity(...args);

  withTaskMaintenance = <T>(
    id: string,
    operation: () => Promise<T>,
    activity = "Data cleanup is running",
  ) => this.scheduling.withTaskMaintenance(id, operation, activity);

  assertAvailable = (...args: Parameters<EngineScheduling["assertAvailable"]>) =>
    this.scheduling.assertAvailable(...args);

  private withExecutionSlot = <T>(
    key: string,
    purpose: string,
    signal: AbortSignal,
    run: (signal: AbortSignal) => Promise<T>,
    taskId?: string,
  ) => this.scheduling.withExecutionSlot(key, purpose, signal, run, taskId);

  runRepair = (...args: Parameters<AgentOperations["runRepair"]>) => this.agents.runRepair(...args);

  private constructor(
    readonly root: string,
    private readonly release: () => Promise<void>,
    database: Database,
    providers?: (stage: number, provider?: "codex" | "antigravity") => AgentProvider,
    gitTransport?: (url: string) => string,
  ) {
    super();
    this.db = database;
    this.flows = new FlowStore(database);
    this.flowRuns = new FlowRunStore(database);
    initializeProfiles(database);
    this.git = new GitWorkspace(root, (id) => this.db.repository(id), gitTransport);

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
        ((_stage, provider) =>
          provider === "antigravity" ? new AntigravityProvider() : new CodexProvider()),
    );

    this.utility = new UtilityAI(this.db, this.runUtility);

    this.repositories = new RepositoryOperations(
      this,
      this.repositoryOperation,
      this.state.repositoryController.signal,
    );

    this.tasks = new TaskLifecycle(
      this,
      this.repositoryOperation,
      this.state.repositoryController.signal,
    );

    this.scheduling = new EngineScheduling(this, this.state, {
      drainFlows: () => this.flowExecution.drain(),
      queuedFlows: () => this.flowExecution.queuedTasks(),
      cancelFlow: (id) => this.flowExecution.cancel(id),
    });

    this.commands = new CommandExecution(this, this.state);

    this.agents = new AgentOperations(this, this.state, this.runner, {
      withExecutionSlot: this.withExecutionSlot,
    });

    this.flowExecution = new FlowExecution(this, this.state, this.runner, {
      withExecutionSlot: this.withExecutionSlot,
    });
  }

  static create = async (
    root: string,
    providers?: (stage: number, provider?: "codex" | "antigravity") => AgentProvider,
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
      const engine = new Engine(root, release, database, providers, gitTransport);
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
        if (operation?.identity && (await processIdentity(operation.pid)) === operation.identity)
          terminateGroup(operation.pid, "SIGKILL");
      }

      migrateLegacyTasks(engine.db);

      for (const task of engine.db.tasks()) {
        if (task.workspace_checkpoint?.operation) {
          task.workspace_checkpoint.operation = null;
          engine.db.saveTask(task);
        }

        if (
          task.worktree_path &&
          !["removing", "removed"].includes(task.workspace_checkpoint?.state || "")
        ) {
          try {
            if (task.workspace_kind === "managed") await assertManagedWorkspace(root, task);
            else {
              const repo = engine.db.repository(task.repo_id);
              if (!(await exists(repo.path)) || !(await exists(task.worktree_path)))
                throw new AdeError(
                  "recovery",
                  "Saved workspace preparation is missing. Restore the owned checkpoint explicitly; no creation was replayed.",
                );
              if (task.workspace_checkpoint?.state === "ready")
                await engine.git.assertOwnedTask(task);
              else
                await engine.git.recoverTaskPreparation(repo, task, (value) =>
                  engine.db.saveTask(value),
                );
            }
          } catch (error) {
            engine.db.saveTask({
              ...task,
              status: "interrupted",
              error: redact(String(error)),
              updated_at: now(),
            });
          }
        }
      }

      const finalizations = new HistoricalFinalizations(engine.db);
      for (const task of engine.db.tasks())
        for (const record of finalizations.list(task.id)) {
          if (["preparing", "reviewing", "committing", "pushing"].includes(record.status)) {
            record.status = record.status === "pushing" ? "uncertain" : "interrupted";

            record.error =
              "The execution core restarted. Reconcile this saved Git operation before continuing.";

            record.pid = null;
            record.process_identity = null;
            finalizations.save(record);
          }
        }

      engine.db.recover();
      engine.flowRuns.interruptUnfinished();
      engine.flowExecution.dispatches.interruptUnfinished();
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

  isActive = (id: string) => this.state.active.has(id) || this.state.interactive.has(id);

  isExecuting = (id: string) => this.state.active.has(id);

  hasActive = () => this.cleanupBlockers().length > 0;

  acquireTaskWorkspace = (...args: Parameters<EngineScheduling["acquireTaskWorkspace"]>) =>
    this.scheduling.acquireTaskWorkspace(...args);

  acquireTerminal = (...args: Parameters<EngineScheduling["acquireTerminal"]>) =>
    this.scheduling.acquireTerminal(...args);

  start = () => {
    void this.drain();
  };

  drain = (...args: Parameters<EngineScheduling["drain"]>) => this.scheduling.drain(...args);

  register = (...args: Parameters<RepositoryOperations["register"]>) =>
    this.repositories.register(...args);

  prepareClone = (...args: Parameters<RepositoryOperations["prepareClone"]>) =>
    this.repositories.prepareClone(...args);

  createGeneralTask = (...args: Parameters<TaskLifecycle["createGeneralTask"]>) =>
    this.tasks.createGeneralTask(...args);

  createIssueTask = (...args: Parameters<TaskLifecycle["createIssueTask"]>) =>
    this.tasks.createIssueTask(...args);

  startFlow = (...args: Parameters<FlowExecution["start"]>) => this.flowExecution.start(...args);

  chatViber = (...args: Parameters<FlowExecution["chatViber"]>) =>
    this.flowExecution.chatViber(...args);

  pauseFlow = (...args: Parameters<FlowExecution["pause"]>) => this.flowExecution.pause(...args);

  continueFlow = (...args: Parameters<FlowExecution["continue"]>) =>
    this.flowExecution.continue(...args);

  previewFlowContinuation = (...args: Parameters<FlowExecution["previewContinuation"]>) =>
    this.flowExecution.previewContinuation(...args);

  applyFlowContinuation = (...args: Parameters<FlowExecution["applyContinuation"]>) =>
    this.flowExecution.applyContinuation(...args);

  runFlowNode = (...args: Parameters<FlowExecution["runNode"]>) =>
    this.flowExecution.runNode(...args);

  retryFlowNode = (...args: Parameters<FlowExecution["retryNode"]>) =>
    this.flowExecution.retryNode(...args);

  approveFlowNode = (...args: Parameters<FlowExecution["approve"]>) =>
    this.flowExecution.approve(...args);

  cancelFlow = (...args: Parameters<FlowExecution["cancel"]>) => this.flowExecution.cancel(...args);

  taskRepository = (...args: Parameters<TaskLifecycle["taskRepository"]>) =>
    this.tasks.taskRepository(...args);

  verifyLocalRepository = (...args: Parameters<RepositoryOperations["verifyLocalRepository"]>) =>
    this.repositories.verifyLocalRepository(...args);

  connectLocalRepository = (...args: Parameters<RepositoryOperations["connectLocalRepository"]>) =>
    this.repositories.connectLocalRepository(...args);

  disconnectRepository = (...args: Parameters<RepositoryOperations["disconnectRepository"]>) =>
    this.repositories.disconnectRepository(...args);

  reconnectRepository = (...args: Parameters<RepositoryOperations["reconnectRepository"]>) =>
    this.repositories.reconnectRepository(...args);

  verifyRepository = (...args: Parameters<RepositoryOperations["verifyRepository"]>) =>
    this.repositories.verifyRepository(...args);

  cancel = async (id: string) => {
    this.db.task(id);
    if (this.state.interactive.has(id))
      throw new AdeError("busy", "Close the task terminal before changing execution state");

    const current = this.db.all<{ id: string }>(
      "SELECT id FROM flow_runs WHERE task_id=? AND status IN ('queued','running','pausing','paused','waiting') ORDER BY rowid DESC",
      id,
    );

    for (const run of current) await this.flowExecution.cancel(run.id);

    const active = [...this.state.active.entries()].filter(
      ([key, value]) => key === id || value.taskId === id,
    );

    for (const [, value] of active) value.controller.abort();
    await Promise.allSettled(active.map(([, value]) => value.promise));
    this.changed(id);
  };

  manual = (...args: Parameters<CommandExecution["manual"]>) => this.commands.manual(...args);

  runCommand = (...args: Parameters<CommandExecution["runCommand"]>) =>
    this.commands.runCommand(...args);

  private runUtility = (...args: Parameters<AgentOperations["runUtility"]>) =>
    this.agents.runUtility(...args);

  beginShutdown = () => {
    this.state.closed = true;
    this.state.repositoryController.abort();
    for (const a of this.state.active.values()) a.controller.abort();
  };

  close = () =>
    (this.closing ??= (async () => {
      this.beginShutdown();
      try {
        await Promise.allSettled([...this.state.active.values()].map((a) => a.promise));
        await Promise.allSettled([...this.state.repositoryOperations.keys()]);

        await Promise.allSettled([...this.state.flowRequests]);
        this.flowRuns.interruptUnfinished();
        this.flowExecution.dispatches.interruptUnfinished();

        await this.repositoryIndex.close();
      } finally {
        try {
          this.db.close();
        } finally {
          await this.release();
        }
      }
    })());

  fetchRepository = (...args: Parameters<RepositoryOperations["fetchRepository"]>) =>
    this.repositories.fetchRepository(...args);

  providers = async () => {
    this.runner.clearProviderDetection();
    return Promise.all([
      new AntigravityProvider().detect(this.root),
      new CodexProvider().detect(this.root),
    ]);
  };

  configureRepository = (...args: Parameters<RepositoryOperations["configureRepository"]>) =>
    this.repositories.configureRepository(...args);
}
