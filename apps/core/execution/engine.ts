import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import { AdeError, type CoreEvent } from "../domain";
import { Database } from "../storage/database";
import { VIBESTAR_DB_NAME } from "../storage/contracts";
import { RepositoryIndex } from "../workspace/discovery";
import { GitWorkspace } from "../workspace/git";
import { createLayout } from "../workspace/paths";
import { ViberMemory } from "../vibers/memory";
import { AgentRunner } from "./agents/agent-runner";
import { RepositoryOperations } from "./engine/repositories";
import { EngineScheduling } from "./engine/scheduling";
import { ExecutionState } from "./engine/state";
import { processIdentity, terminateGroup } from "./runtime/process";
import { AntigravityProvider } from "./providers/antigravity";
import { CodexProvider } from "./providers/codex";
import type { AgentProvider } from "./providers/contracts";
import { ViberSessions, type ScheduleInterpreter } from "./engine/viber-sessions";
import { ViberStore } from "../vibers/store";
import { Computers } from "../computers/service";
import { GitHubClient } from "../github/client";
import { ViberSchedules } from "../vibers/schedules";

export class Engine extends EventEmitter {
  private readonly state = new ExecutionState();

  private readonly scheduling: EngineScheduling;

  private readonly repositories: RepositoryOperations;

  readonly db: Database;

  readonly git: GitWorkspace;

  readonly repositoryIndex: RepositoryIndex;

  readonly viberSessions: ViberSessions;

  readonly vibers: ViberStore;

  readonly memory: ViberMemory;

  readonly computers: Computers;

  readonly schedules: ViberSchedules;

  private readonly runner: AgentRunner;

  private closing: Promise<void> | undefined;

  private repositoryOperation = <T>(
    operation: () => Promise<T>,
    label = "Repository preparation is running",
  ) => this.scheduling.repositoryOperation(operation, label);

  withStorageMaintenance = async <T>(operation: () => Promise<T>) => {
    try {
      return await this.scheduling.withStorageMaintenance(operation);
    } finally {
      this.schedules.wake();
    }
  };

  cleanupBlockers = (...args: Parameters<EngineScheduling["cleanupBlockers"]>) =>
    this.scheduling.cleanupBlockers(...args);

  trackActivity = (...args: Parameters<EngineScheduling["trackActivity"]>) =>
    this.scheduling.trackActivity(...args);

  stopActivity = (...args: Parameters<EngineScheduling["stopActivity"]>) =>
    this.scheduling.stopActivity(...args);

  assertAvailable = (...args: Parameters<EngineScheduling["assertAvailable"]>) =>
    this.scheduling.assertAvailable(...args);

  private withExecutionSlot = <T>(
    key: string,
    purpose: string,
    signal: AbortSignal,
    run: (signal: AbortSignal) => Promise<T>,
  ) => this.scheduling.withExecutionSlot(key, purpose, signal, run);

  private constructor(
    readonly root: string,
    private readonly release: () => Promise<void>,
    database: Database,
    providers?: (stage: number, provider?: "codex" | "antigravity") => AgentProvider,
    gitTransport?: (url: string) => string,
    gitHubClient?: GitHubClient,
    scheduleInterpreter?: ScheduleInterpreter | false,
  ) {
    super();
    this.db = database;
    this.vibers = new ViberStore(database);
    this.memory = new ViberMemory(database);
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

    this.repositories = new RepositoryOperations(
      this,
      this.repositoryOperation,
      this.state.repositoryController.signal,
    );

    this.scheduling = new EngineScheduling(this, this.state);

    this.computers = new Computers(this);

    this.schedules = new ViberSchedules(
      database,
      gitHubClient ?? new GitHubClient(root),
      () => !this.state.closed && !this.state.maintenance,
      this.changed,
      (...args) => this.viberSessions.runScheduledInstruction(...args),
    );

    this.viberSessions = new ViberSessions(
      this,
      this.state,
      this.runner,
      {
        withExecutionSlot: this.withExecutionSlot,
        assertExecutionSlot: this.scheduling.assertExecutionSlot,
        stopActivity: this.stopActivity,
      },
      scheduleInterpreter,
    );
  }

  static create = async (
    root: string,
    providers?: (stage: number, provider?: "codex" | "antigravity") => AgentProvider,
    gitTransport?: (url: string) => string,
    gitHubClient?: GitHubClient,
    scheduleInterpreter?: ScheduleInterpreter | false,
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
      database = await Database.open(join(root, "state", VIBESTAR_DB_NAME));

      const engine = new Engine(
        root,
        release,
        database,
        providers,
        gitTransport,
        gitHubClient,
        scheduleInterpreter,
      );

      for (const run of engine.db.all<{
        pid: number;
        process_identity: string;
      }>(
        "SELECT pid,process_identity FROM utility_runs WHERE status='running' AND pid IS NOT NULL UNION ALL SELECT json_extract(workspace,'$.workspace_checkpoint.operation.pid'),json_extract(workspace,'$.workspace_checkpoint.operation.identity') FROM viber_sessions WHERE workspace IS NOT NULL AND json_extract(workspace,'$.workspace_checkpoint.operation.pid') IS NOT NULL",
      )) {
        if (
          Number.isSafeInteger(run.pid) &&
          run.pid > 1 &&
          run.process_identity &&
          (await processIdentity(run.pid)) === run.process_identity
        ) {
          terminateGroup(run.pid, "SIGKILL");
        }
      }

      engine.db.run(
        "UPDATE viber_sessions SET workspace=json_set(workspace,'$.workspace_checkpoint.operation',NULL) WHERE workspace IS NOT NULL AND json_extract(workspace,'$.workspace_checkpoint.operation') IS NOT NULL",
      );

      engine.db.recover();
      engine.memory.queueIndex();
      engine.schedules.start();
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

  changed = (id?: string) => this.publish({ event: "changed", session_id: id });

  isActive = (id: string) => this.state.active.has(id);

  hasActive = () => this.cleanupBlockers().length > 0;

  register = (...args: Parameters<RepositoryOperations["register"]>) =>
    this.repositories.register(...args);

  prepareClone = (...args: Parameters<RepositoryOperations["prepareClone"]>) =>
    this.repositories.prepareClone(...args);

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

  fetchRepository = (...args: Parameters<RepositoryOperations["fetchRepository"]>) =>
    this.repositories.fetchRepository(...args);

  beginShutdown = () => {
    this.state.closed = true;
    this.schedules.stop();
    this.state.repositoryController.abort();
    for (const a of this.state.active.values()) {
      a.controller.abort();
    }
  };

  prepareRuntimeRestart = () => {
    const blockers = this.cleanupBlockers();
    if (blockers.length) {
      throw new AdeError(
        "busy",
        "Wait for running operations to finish before changing the runtime.",
        { blockers },
      );
    }

    this.beginShutdown();
  };

  close = () =>
    (this.closing ??= (async () => {
      this.beginShutdown();
      try {
        await Promise.allSettled([...this.state.active.values()].map((a) => a.promise));
        await Promise.allSettled([...this.state.repositoryOperations.keys()]);

        const closed = await Promise.allSettled([
          this.memory.close(),
          this.computers.close(),
          this.repositoryIndex.close(),
          this.schedules.close(),
        ]);

        const failure = closed.find((result) => result.status === "rejected");
        if (failure) {
          throw failure.reason;
        }
      } finally {
        try {
          this.db.close();
        } finally {
          await this.release();
        }
      }
    })());

  providers = async () => {
    this.runner.clearProviderDetection();
    return Promise.all([
      new AntigravityProvider().detect(this.root),
      new CodexProvider().detect(this.root),
    ]);
  };
}
