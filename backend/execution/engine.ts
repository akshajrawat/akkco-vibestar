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
import { ApprovalTransitions } from "./engine/approvals";
import { CommandExecution } from "./engine/commands";
import { RepositoryOperations } from "./engine/repositories";
import { EngineScheduling } from "./engine/scheduling";
import { ExecutionState } from "./engine/state";
import { TaskLifecycle } from "./engine/tasks";
import { VerificationTransitions } from "./engine/verification";
import { WorkflowOrchestrator } from "./engine/workflow";
import { processIdentity, redact, terminateGroup } from "./runtime/process";
import { AntigravityProvider } from "./providers/antigravity";
import { CodexProvider } from "./providers/codex";
import type { AgentProvider } from "./providers/contracts";
import { UtilityAI } from "./agents/utility-ai";

export class Engine extends EventEmitter {
  private readonly state = new ExecutionState();

  private readonly agents: AgentOperations;

  private readonly commands: CommandExecution;

  private readonly approvals: ApprovalTransitions;

  private readonly verification: VerificationTransitions;

  private readonly workflow: WorkflowOrchestrator;

  private readonly scheduling: EngineScheduling;

  private readonly tasks: TaskLifecycle;

  private readonly repositories: RepositoryOperations;

  readonly db: Database;

  readonly git: GitWorkspace;

  readonly repositoryIndex: RepositoryIndex;

  readonly utility: UtilityAI;

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
        ((stage, provider) =>
          provider === "antigravity" || (stage === 1 && !provider)
            ? new AntigravityProvider()
            : new CodexProvider()),
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

    this.scheduling = new EngineScheduling(this, this.state, { pipeline: this.pipeline });

    this.workflow = new WorkflowOrchestrator(this, this.state, this.runner, {
      withExecutionSlot: this.withExecutionSlot,
      verificationEvidenceHash: this.verificationEvidenceHash,
      savedReviewVerdict: this.savedReviewVerdict,
    });

    this.verification = new VerificationTransitions(this, this.state);
    this.approvals = new ApprovalTransitions(this, this.state);
    this.commands = new CommandExecution(this, this.state);

    this.agents = new AgentOperations(this, this.state, this.runner, {
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
        if (task.workspace_checkpoint) task.workspace_checkpoint.operation = null;
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

  createTask = (...args: Parameters<TaskLifecycle["createTask"]>) => this.tasks.createTask(...args);

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

  enqueue = (...args: Parameters<TaskLifecycle["enqueue"]>) => this.tasks.enqueue(...args);

  /** Persists explicit startup authority once, after read-only identity and capability checks. */
  startWorkflow = (...args: Parameters<WorkflowOrchestrator["startWorkflow"]>) =>
    this.workflow.startWorkflow(...args);

  /** Runs a persisted read-only question through AgentRunner without advancing workflow authority. */
  chat = (...args: Parameters<WorkflowOrchestrator["chat"]>) => this.workflow.chat(...args);

  private pipeline = (...args: Parameters<WorkflowOrchestrator["pipeline"]>) =>
    this.workflow.pipeline(...args);

  cancel = (...args: Parameters<EngineScheduling["cancel"]>) => this.scheduling.cancel(...args);

  retry = (...args: Parameters<ApprovalTransitions["retry"]>) => this.approvals.retry(...args);

  approveStage = (...args: Parameters<ApprovalTransitions["approveStage"]>) =>
    this.approvals.approveStage(...args);

  private verificationEvidenceHash = (
    ...args: Parameters<VerificationTransitions["verificationEvidenceHash"]>
  ) => this.verification.verificationEvidenceHash(...args);

  reviewGapsPreview = (...args: Parameters<VerificationTransitions["reviewGapsPreview"]>) =>
    this.verification.reviewGapsPreview(...args);

  private savedReviewVerdict = (
    ...args: Parameters<VerificationTransitions["savedReviewVerdict"]>
  ) => this.verification.savedReviewVerdict(...args);

  recheckEvidence = (...args: Parameters<VerificationTransitions["recheckEvidence"]>) =>
    this.verification.recheckEvidence(...args);

  setVerificationPolicy = (...args: Parameters<VerificationTransitions["setVerificationPolicy"]>) =>
    this.verification.setVerificationPolicy(...args);

  runMissingCheck = (...args: Parameters<VerificationTransitions["runMissingCheck"]>) =>
    this.verification.runMissingCheck(...args);

  fixVerification = (...args: Parameters<VerificationTransitions["fixVerification"]>) =>
    this.verification.fixVerification(...args);

  acceptDraft = (...args: Parameters<ApprovalTransitions["acceptDraft"]>) =>
    this.approvals.acceptDraft(...args);

  followUp = (...args: Parameters<ApprovalTransitions["followUp"]>) =>
    this.approvals.followUp(...args);

  sendSavedMessage = (...args: Parameters<ApprovalTransitions["sendSavedMessage"]>) =>
    this.approvals.sendSavedMessage(...args);

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

        await Promise.allSettled(
          [...this.state.startingWorkflows.values()].map((operation) => operation.promise),
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
