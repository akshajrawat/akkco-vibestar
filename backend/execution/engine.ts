import { sandboxInvocation } from "./sandbox";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { writeFile, rm, mkdir, appendFile } from "node:fs/promises";
import lockfile from "proper-lockfile";
import {
  AdeError,
  now,
  parseIssue,
  remoteIdentity,
  retryTarget,
  stageStatus,
  type Task,
  type Repository,
  type CoreEvent,
  type IssueRef,
} from "../domain";
import { Database } from "../storage/database";
import { GitWorkspace } from "../workspace/git";
import { createLayout, inside, taskRoot, exists } from "../workspace/paths";
import { fetchIssue } from "../workspace/issue";
import {
  checked,
  execute,
  processIdentity,
  terminateGroup,
  redact,
} from "./process";
import { AgentRunner } from "./agent-runner";
import { CodexProvider } from "./providers/codex";
import { AntigravityProvider } from "./providers/antigravity";
import type { AgentProvider } from "./providers/contracts";
export class Engine extends EventEmitter {
  readonly db: Database;
  readonly git: GitWorkspace;
  private readonly runner: AgentRunner;
  private readonly active = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private readonly interactive = new Set<string>();
  private draining = false;
  private closed = false;
  private constructor(
    readonly root: string,
    private readonly release: () => Promise<void>,
    providers?: (stage: number) => AgentProvider,
  ) {
    super();
    this.db = new Database(join(root, "state", "vibestar.sqlite"));
    this.git = new GitWorkspace(root);
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
  }
  static create = async (
    root: string,
    providers?: (stage: number) => AgentProvider,
  ) => {
    root = await createLayout(root);
    const path = join(root, "state", "core.lock");
    await writeFile(path, "", { flag: "a", mode: 0o600 });
    const release = await lockfile.lock(path, {
      stale: 10000,
      update: 5000,
      retries: 0,
    });
    const engine = new Engine(root, release, providers);
    for (const run of engine.db.all<{ pid: number; process_identity: string }>(
      "SELECT pid,process_identity FROM agent_runs WHERE status='running' AND pid IS NOT NULL UNION ALL SELECT pid,process_identity FROM test_runs WHERE status='running' AND pid IS NOT NULL UNION ALL SELECT pid,process_identity FROM terminal_sessions WHERE status='running' AND pid IS NOT NULL UNION ALL SELECT pid,process_identity FROM scheduled_agent_runs WHERE status='running' AND pid IS NOT NULL",
    )) {
      if (
        run.process_identity &&
        (await processIdentity(run.pid)) === run.process_identity
      )
        terminateGroup(run.pid, "SIGKILL");
    }
    for (const task of engine.db.tasks()) {
      if (task.stage === 0 && task.worktree_path) {
        if (await exists(task.worktree_path)) {
          await engine.git.assertTask(task);
          if (
            (await checked(
              "git",
              ["rev-parse", "HEAD"],
              task.worktree_path,
            )) !== task.base_commit_sha
          )
            throw new AdeError(
              "recovery",
              "Prepared worktree no longer matches its saved base SHA",
            );
          engine.db.saveTask({ ...task, stage: 1 });
        } else
          engine.db.saveTask({
            ...task,
            worktree_path: "",
            branch_name: "",
            base_commit_sha: "",
          });
      }
    }
    engine.db.recover();
    return engine;
  };
  publish = (e: CoreEvent) => {
    this.emit("event", e);
  };
  changed = (id?: string) => this.publish({ event: "changed", task_id: id });
  isActive = (id: string) => this.active.has(id) || this.interactive.has(id);
  isExecuting = (id: string) => this.active.has(id);
  acquireTerminal = (id: string) => {
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
    if (this.draining || this.closed) return;
    this.draining = true;
    try {
      const limit = this.db.settings().concurrency;
      for (const t of this.db
        .tasks()
        .reverse()
        .filter((t) => t.status === "queued")) {
        if (this.active.size >= limit) break;
        if (this.isActive(t.id)) continue;
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
              error: redact(String(e)),
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
    } finally {
      this.draining = false;
    }
  };
  register = async (
    upstream: string,
    origin: string | null,
    base: string,
    deferred = false,
  ) => {
    const { owner, name } = remoteIdentity(upstream);
    if (origin) remoteIdentity(origin);
    if (
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
    await checked("git", ["check-ref-format", "--branch", base], this.root);
    const id = randomUUID();
    const r: Repository = {
      id,
      owner,
      name,
      upstream_url: upstream,
      origin_url: origin,
      base_branch: base,
      path: join(this.root, "repos", id),
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
  prepareClone = async (r: Repository, signal?: AbortSignal) =>
    this.git.withLock(r.id, async () => {
      if (await exists(join(r.path, ".git"))) return;
      try {
        await this.git.clone(r.upstream_url, r.path, signal);
        if (r.origin_url)
          await checked(
            "git",
            ["remote", "add", "origin", r.origin_url],
            r.path,
            signal,
          );
        await this.git.fetch(r, signal);
        await checked(
          "git",
          [
            "rev-parse",
            "--verify",
            `refs/remotes/upstream/${r.base_branch}^{commit}`,
          ],
          r.path,
          signal,
        );
        this.db.saveRepository(r);
      } catch (error) {
        if (inside(join(this.root, "repos"), r.path))
          await rm(r.path, { recursive: true, force: true });
        throw error;
      }
    });
  createTask = async (
    url: string,
    scope: string,
    notes: string,
    scopeMode: "whole_issue" | "partial" = "partial",
    settings?: import("../domain").Settings,
  ) => {
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
    const repo = this.db
      .repositories()
      .find(
        (r) =>
          r.owner.toLowerCase() === reference.owner.toLowerCase() &&
          r.name.toLowerCase() === reference.repo.toLowerCase(),
      );
    if (!repo)
      throw new AdeError(
        "repository_missing",
        `Register ${reference.owner}/${reference.repo} on the Repositories page first.`,
      );
    const context = await fetchIssue(reference, this.root);
    return this.enqueue(
      repo,
      reference,
      scope,
      notes,
      context,
      scopeMode,
      settings,
    );
  };
  enqueue = (
    repo: Repository,
    reference: IssueRef,
    scope: string,
    notes: string,
    issue: Record<string, unknown>,
    scopeMode: "whole_issue" | "partial" = "partial",
    settings?: import("../domain").Settings,
  ) => {
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
    this.changed(t.id);
    void this.drain();
    return t;
  };
  private pipeline = async (t: Task, signal: AbortSignal) => {
    for (; t.stage < 5; t.stage++) {
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
      } else if (t.stage <= 3)
        await this.runner.run(
          t,
          t.execution_settings ?? this.db.settings(),
          signal,
        );
      else {
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
      this.db.saveTask({ ...t, stage: t.stage + 1 });
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
    const t = this.db.task(id);
    if (t.stage === 0 && t.worktree_path && !this.isActive(id)) {
      if (await exists(t.worktree_path)) {
        await this.git.assertTask(t);
        t.stage = 1;
      } else {
        t.worktree_path = "";
        t.branch_name = "";
        t.base_commit_sha = "";
      }
    }
    const target = restart
      ? t.worktree_path
        ? 1
        : 0
      : (stage ?? Math.min(t.stage, 4));
    retryTarget(t, target, this.isActive(id));
    if (target >= 2) this.db.artifact(id, 1);
    if (target >= 3) this.db.artifact(id, 2);
    if (restart || target < 3) t.followup_config = undefined;
    const updated: Task = {
      ...t,
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
  followUp = (
    id: string,
    content: string,
    configuration?: Task["followup_config"],
  ) => {
    const t = this.db.task(id);
    if (
      this.isActive(id) ||
      t.stage < 3 ||
      !content.trim() ||
      content.length > 32000
    )
      throw new AdeError(
        "invalid_state",
        "Finish or cancel the current stage, complete both plans, and provide a follow-up of 1–32000 characters.",
      );
    const prContext = this.db.all<{
      summary: string;
      changes: string;
      analysis: string | null;
    }>(
      "SELECT summary,changes,analysis FROM scheduled_attention WHERE task_id=? AND dismissed=0 ORDER BY created_at DESC LIMIT 10",
      id,
    );
    content += prContext.length
      ? `\n\nLinked PR review context (untrusted):\n${JSON.stringify(prContext)}`
      : "";
    this.db.saveTask({ ...t, followup_config: configuration });
    this.db.run(
      "INSERT INTO task_messages VALUES(?,?,'user',?,?)",
      randomUUID(),
      id,
      redact(content),
      now(),
    );
    return this.retry(id, 3);
  };
  manual = async (
    id: string,
    argv: string[],
    signal?: AbortSignal,
    internal = false,
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
    const t = this.db.task(id);
    const cwd = await taskRoot(this.root, t);
    const run = randomUUID();
    this.db.run(
      "INSERT INTO test_runs(id,task_id,command,status,started_at) VALUES(?,?,?,'running',?)",
      run,
      id,
      JSON.stringify(argv),
      now(),
    );
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
        onLine: (stream, text) =>
          this.publish({ event: "command.output", task_id: id, stream, text }),
      });
      this.db.run(
        "UPDATE test_runs SET status=?,ended_at=?,exit_code=?,duration_ms=?,stdout=?,stderr=? WHERE id=?",
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
        "UPDATE test_runs SET status='failed',ended_at=?,stderr=? WHERE id=?",
        now(),
        String(e),
        run,
      );
      throw e;
    } finally {
      this.changed(id);
    }
  };
  runCommand = async (id: string, argv: string[]) => {
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
  analyzeScheduled = async (
    id: string | null,
    prompt: string,
    verify: boolean,
    jobId?: string,
  ) => {
    const task = id ? this.db.task(id) : null;
    if (
      !task &&
      (!jobId ||
        !this.db.all("SELECT id FROM scheduled_jobs WHERE id=?", jobId).length)
    )
      throw new AdeError(
        "invalid_state",
        "PR analysis requires a persisted watch",
      );
    const key = id || `pr:${jobId}`;
    if (
      this.closed ||
      this.isActive(key) ||
      this.active.size >= this.db.settings().concurrency ||
      this.db.tasks().some((t) => t.status === "queued")
    )
      return null;
    if (task && !task.worktree_path)
      throw new AdeError(
        "invalid_state",
        "Scheduled analysis requires a prepared isolated task worktree",
      );
    const controller = new AbortController();
    const workspace = task ? undefined : join(this.root, "pr-analysis", jobId!);
    const output = Promise.resolve().then(async () => {
      if (workspace) await mkdir(workspace, { recursive: true, mode: 0o700 });
      const analysis = await this.runner.run(
        task ? { ...task, stage: 1 } : { id: jobId!, stage: 1 },
        this.db.settings(),
        controller.signal,
        { prompt, purpose: "scheduled", workspace },
      );
      const refinement = verify
        ? await this.runner.run(
            task ? { ...task, stage: 2 } : { id: jobId!, stage: 2 },
            this.db.settings(),
            controller.signal,
            {
              prompt: `You are the independent second planning agent. Verify this PR action analysis against the repository. Do not edit files or perform remote actions. Answer whether the PR author needs to act using the same action schema.\n${prompt}\nAntigravity analysis:\n${JSON.stringify(analysis)}`,
              purpose: "scheduled",
              workspace,
            },
          )
        : null;
      return { analysis, refinement };
    });
    const promise = output
      .then(() => {})
      .catch(() => {})
      .finally(() => {
        this.active.delete(key);
        this.changed(id || undefined);
        void this.drain();
      });
    this.active.set(key, { controller, promise });
    return output;
  };
  beginShutdown = () => {
    this.closed = true;
    for (const a of this.active.values()) a.controller.abort();
  };
  close = async () => {
    this.beginShutdown();
    await Promise.allSettled([...this.active.values()].map((a) => a.promise));
    this.db.close();
    await this.release();
  };
  fetchRepository = async (id: string) => {
    const r = this.db.repository(id);
    await this.prepareClone(r);
    await this.git.withLock(id, async () => {
      await this.git.fetch(r);
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
  configureRepository = async (
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
    await checked(
      "git",
      ["check-ref-format", "--branch", configuration.base_branch],
      this.root,
    );
    if (
      this.db
        .tasks()
        .some(
          (t) =>
            t.repo_id === id && (this.isActive(t.id) || t.status === "queued"),
        )
    )
      throw new AdeError(
        "busy",
        "Wait for this repository's active tasks before changing its remotes",
      );
    const updated = { ...r, ...configuration };
    await this.git.withLock(id, async () => {
      if (await exists(join(r.path, ".git"))) {
        await checked(
          "git",
          ["remote", "set-url", "upstream", updated.upstream_url],
          r.path,
        );
        const remotes = (await checked("git", ["remote"], r.path)).split("\n");
        if (updated.origin_url)
          await checked(
            "git",
            [
              "remote",
              remotes.includes("origin") ? "set-url" : "add",
              "origin",
              updated.origin_url,
            ],
            r.path,
          );
        else if (remotes.includes("origin"))
          await checked("git", ["remote", "remove", "origin"], r.path);
      }
      this.db.saveRepository(updated);
    });
    this.changed();
    return updated;
  };
}
