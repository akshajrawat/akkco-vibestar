import { gitCapture } from "../../workspace/git-command";
import { z } from "zod";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AdeError, now, type WorkspaceAssignment } from "../../domain";
import type { Engine } from "../../execution/engine";
import { execute, redact } from "../../execution/runtime/process";
import { taskRuntime } from "../../workspace/runtime";
import { managedPath, safeFile } from "../../workspace/paths";
import { GitHubClient } from "../../github/client";
import { PRAnalysisSessionSchema } from "../pr/contracts";
import { fileHash } from "../file-hash";
import { PRIdentityReader } from "./identity";
import { RepairStore } from "./store";
import { RepairWorkspaces, repairAssignment } from "./workspace";
import { repairPrompt } from "./prompt";
import { RepairPublisher, PublicationSchema } from "./publication";
import {
  RepairImplementationSchema,
  RepairVerificationSchema,
  type RepairSession,
  type PRIdentity,
} from "./contracts";

const createInput = z
  .object({
    request_id: z.string().uuid(),
    job_id: z.string().uuid(),
    repository_id: z.string().uuid(),
    analysis_id: z.string().uuid(),
    action_ids: z.array(z.string().uuid()).min(1).max(500),
    instructions: z.string().max(16000).default(""),
  })
  .strict()
  .refine(
    (input) => new Set(input.action_ids).size === input.action_ids.length,
    "Select each review item only once.",
  );

export class RepairService {
  readonly store: RepairStore;

  readonly workspaces: RepairWorkspaces;

  readonly publisher: RepairPublisher;

  private readonly active = new Map<
    string,
    { controller: AbortController; promise: Promise<unknown> }
  >();

  private readonly ready: Promise<void>;

  private readonly terminalLeases = new Set<string>();

  private readonly creating = new Map<
    string,
    {
      key: string;
      controller: AbortController;
      promise: Promise<RepairSession>;
    }
  >();

  constructor(
    readonly engine: Engine,
    private readonly readIdentity = new PRIdentityReader(new GitHubClient(engine.root)).read,
    workspaces = new RepairWorkspaces(engine.root, engine.git),
    publicationTransport?: (identity: PRIdentity) => string,
    publicationPush = execute,
  ) {
    this.store = new RepairStore(engine.db);
    this.workspaces = workspaces;

    this.publisher = new RepairPublisher(
      engine,
      this.store,
      workspaces,
      this.readIdentity,
      publicationTransport,
      publicationPush,
    );

    this.ready = this.recover();
  }

  private changed = (session: RepairSession) =>
    this.engine.publish({ event: "changed", repair_id: session.id });

  private transition = (
    session: RepairSession,
    status: RepairSession["status"],
    error: string | null = null,
  ) => {
    this.store.transition(session, status, error);
    this.changed(session);
  };

  private recover = async () => {
    for (const session of this.store.list()) {
      if (session.workspace.preparation === "removing") {
        session.workspace.operation = null;

        session.error =
          "Workspace removal was interrupted. Recover removal explicitly; saved repair and publication history remain intact.";

        this.store.save(session);
        continue;
      }

      if (
        !session.workspace.operation &&
        !["preparing", "codex_implementing", "antigravity_verifying"].includes(session.status)
      )
        continue;
      if (session.workspace.operation)
        this.store.activity(session, "interrupted_git_operation", session.workspace.operation);
      session.workspace.operation = null;
      session.approved_hash = null;
      let state = "pending";
      if (session.workspace.branch_owned) {
        try {
          state = await this.workspaces.inspect(
            session,
            this.engine.db.repository(session.repo_id),
          );
        } catch (error) {
          session.error = redact(String(error));
        }
      }

      this.transition(
        session,
        state === "conflict" ? "merge_conflict" : "interrupted",
        session.error ||
          "Repair interrupted. Inspect the preserved worktree and continue explicitly; no model run or Git operation was replayed.",
      );
    }

    for (const publication of this.engine.db.all<{ id: string; data: string }>(
      "SELECT id,data FROM repair_publications WHERE status='pushing'",
    )) {
      const data = this.engine.db.records.tryDecode(
        {
          table: "repair_publications",
          id: publication.id,
          column: "data",
          source: publication.data,
          identity: "id",
        },
        PublicationSchema.parse,
      );

      if (!data) {
        this.engine.db.run(
          "UPDATE repair_publications SET status='uncertain',updated_at=? WHERE id=?",
          now(),
          publication.id,
        );

        continue;
      }

      this.engine.db.run(
        "UPDATE repair_publications SET status='uncertain',data=?,updated_at=? WHERE id=?",
        JSON.stringify({
          ...data,
          outcome: "uncertain",
          error: "Publication was interrupted. Reconcile the remote read-only before any new push.",
        }),
        now(),
        publication.id,
      );
    }
  };

  private verifyIdentity = async (session: RepairSession, signal: AbortSignal) => {
    const fresh = await this.readIdentity(session.identity.url, signal);
    const old = session.identity;
    if (
      fresh.id !== old.id ||
      fresh.upstream.id !== old.upstream.id ||
      fresh.head.id !== old.head.id ||
      fresh.head.name !== old.head.name ||
      fresh.head.branch !== old.head.branch ||
      fresh.base.branch !== old.base.branch ||
      fresh.upstream.name !== old.upstream.name
    )
      throw new AdeError(
        "pr_identity",
        "The PR or destination identity changed. Import and analyze the current PR explicitly.",
      );
    if (fresh.state !== "open") throw new AdeError("pr_closed", "The PR is no longer open.");
    session.identity = fresh;
    this.store.save(session);
    if (fresh.head.sha !== session.workspace.original_head)
      throw new AdeError(
        "stale_remote_head",
        "The remote PR head changed. Analyze again and create a new repair session.",
      );
    return fresh;
  };

  private exclusive = async <T>(
    id: string,
    label: string,
    operation: (session: RepairSession, signal: AbortSignal) => Promise<T>,
  ) => {
    this.engine.assertAvailable();
    if (this.active.has(id) || this.terminalLeases.has(id))
      throw new AdeError("busy", "This repair workspace is already in use.");
    const session = this.store.get(id);
    for (const row of this.engine.db.all<{ id: string; data: string }>(
      "SELECT id,data FROM repair_publications WHERE repair_id=?",
      id,
    ))
      this.engine.db.records.decode(
        {
          table: "repair_publications",
          id: row.id,
          column: "data",
          source: row.data,
          identity: "id",
        },
        PublicationSchema.parse,
      );
    const controller = new AbortController();
    let releaseActivity = () => {};

    const promise = Promise.resolve()
      .then(async () => {
        const repo = this.engine.db.repository(session.repo_id);

        const releaseDestination = await this.engine.git.acquireWrite(
          repo.path,
          `pr:${session.identity.head.id}:${session.identity.head.branch}`,
        );

        try {
          const releaseWorkspace = await this.engine.git.acquireWrite(
            repo.path,
            `branch:${session.workspace.branch_name}`,
          );

          try {
            return await operation(session, controller.signal);
          } finally {
            await releaseWorkspace();
          }
        } finally {
          await releaseDestination();
        }
      })
      .catch((error) => {
        if (this.engine.db.all("SELECT id FROM pr_repairs WHERE id=?", id).length) {
          const message = redact(String(error));

          this.store.activity(session, "operation_failed", {
            label,
            error: message,
          });

          if (error instanceof AdeError && error.kind === "stale_remote_head")
            this.transition(session, "stale_remote_head", message);
          else {
            session.error = message;
            this.store.save(session);
          }
        }

        throw error;
      })
      .finally(() => {
        this.active.delete(id);
        releaseActivity();
        this.changed(session);
      });

    this.active.set(id, { controller, promise });

    releaseActivity = this.engine.trackActivity(
      { id: `repair:${id}`, kind: "pr_watch", label, stoppable: true },
      async () => {
        controller.abort();
        await promise.catch(() => {});
      },
    );

    return promise;
  };

  create = async (input: unknown) => {
    await this.ready;
    const request = createInput.parse(input);

    const key = JSON.stringify({
      ...request,
      action_ids: [...request.action_ids].sort(),
    });

    const active = this.creating.get(request.request_id);
    if (active) {
      if (active.key !== key)
        throw new AdeError(
          "invalid_input",
          "This request identity already belongs to another repair selection.",
        );
      return active.promise;
    }

    const controller = new AbortController();

    const promise = this.createSession(request, controller).finally(() =>
      this.creating.delete(request.request_id),
    );

    this.creating.set(request.request_id, { key, controller, promise });
    return promise;
  };

  private createSession = async (
    request: z.infer<typeof createInput>,
    controller: AbortController,
  ) => {
    const previous = this.engine.db.all("SELECT id FROM pr_repairs WHERE id=?", request.request_id)
      .length
      ? this.store.get(request.request_id)
      : undefined;

    if (previous) {
      const original = this.engine.db.all<{ id: number; data: string }>(
        "SELECT id,data FROM repair_activity WHERE repair_id=? AND kind='creation_request' ORDER BY id LIMIT 1",
        previous.id,
      )[0];

      const originalInstructions = original
        ? this.engine.db.records.decode(
            {
              table: "repair_activity",
              id: original.id,
              column: "data",
              source: original.data,
            },
            createInput.parse,
          ).instructions
        : previous.instructions;

      if (
        previous.job_id !== request.job_id ||
        previous.repo_id !== request.repository_id ||
        previous.analysis_id !== request.analysis_id ||
        previous.actions
          .map((a) => a.id)
          .sort()
          .join() !== [...request.action_ids].sort().join() ||
        originalInstructions !== request.instructions
      )
        throw new AdeError(
          "invalid_input",
          "This request identity already belongs to another repair selection.",
        );
      return previous;
    }

    this.engine.assertAvailable();

    const row = this.engine.db.all<{ data: string }>(
      "SELECT data FROM pr_analyses WHERE id=? AND job_id=?",
      request.analysis_id,
      request.job_id,
    )[0];

    const context =
      row &&
      this.engine.db.records.decode(
        {
          table: "pr_analyses",
          id: request.analysis_id,
          column: "data",
          source: row.data,
          identity: "id",
        },
        PRAnalysisSessionSchema.parse,
      );

    if (!context?.snapshot?.identity || !context.report?.complete || context.status !== "completed")
      throw new AdeError(
        "analysis_required",
        "Complete an explicit PR analysis before solving selected review items.",
      );

    const actions = request.action_ids.map((id) => {
      const action = context.report!.actions.find((a) => a.id === id);
      if (
        !action ||
        !["required_change", "suggested_change", "question"].includes(action.classification) ||
        action.responseState === "answered"
      )
        throw new AdeError(
          "invalid_input",
          "Select outstanding review observations from this analysis.",
        );
      return action;
    });

    const repo = this.engine.db.repository(request.repository_id);

    const release = this.engine.trackActivity(
      {
        id: `repair-create:${request.request_id}`,
        kind: "pr_watch",
        label: "Verifying PR repair identity",
        stoppable: true,
      },
      async () => {
        controller.abort();
      },
    );

    try {
      const job = this.engine.db.all<{ data: string }>(
        "SELECT data FROM scheduled_jobs WHERE id=?",
        request.job_id,
      )[0];

      if (!job) throw new AdeError("not_found", "Tracked PR no longer exists.");

      const identity = await this.readIdentity(
        this.engine.db.records.decode({
          table: "scheduled_jobs",
          id: request.job_id,
          column: "data",
          source: job.data,
        }).url as string,
        controller.signal,
      );

      const analyzed = context.snapshot.identity;
      if (
        identity.id !== analyzed.prId ||
        identity.upstream.id !== analyzed.baseRepositoryId ||
        identity.head.id !== analyzed.headRepositoryId ||
        identity.head.name !== analyzed.headRepository ||
        identity.head.branch !== analyzed.headBranch ||
        identity.base.branch !== analyzed.baseBranch ||
        identity.head.sha !== context.snapshot.headRefOid ||
        identity.state !== "open"
      )
        throw new AdeError(
          "stale_remote_head",
          "The PR identity or head changed since analysis. Analyze again before repairing.",
        );
      await this.workspaces.validateRepository(repo, identity);
      const settings = this.engine.db.settings();

      const session: RepairSession = {
        id: request.request_id,
        job_id: request.job_id,
        repo_id: repo.id,
        analysis_id: context.id,
        identity,
        context,
        actions,
        instructions: request.instructions,
        configuration: {
          codex: settings.codex_implementation,
          antigravity: settings.antigravity_review || settings.antigravity,
        },
        workspace: {
          branch_name: `akkco/pr-${identity.number}-${request.request_id}`,
          worktree_path: join(
            this.engine.root,
            "worktrees",
            repo.id,
            `pr-${identity.number}-${request.request_id}`,
          ),
          branch_owned: false,
          git_common_dir: "",
          source_worktrees: "",
          original_head: identity.head.sha,
          original_base: context.snapshot.baseRefOid || identity.base.sha,
          fetched_base: null,
          integrated_head: null,
          merge_commit: null,
          merge_state: "not_started",
          conflict_paths: [],
          conflict_index: "",
          preparation: "pending",
          remote_head: identity.head.sha,
          remote_checked_at: now(),
        },
        status: "created",
        error: null,
        created_at: now(),
        updated_at: now(),
        review_hash: null,
        approved_hash: null,
        implementation: null,
        verification: null,
      };

      this.store.save(session);
      this.store.activity(session, "creation_request", request);
      if (request.instructions) this.store.message(session.id, request.instructions);
      this.changed(session);
      await this.start(session.id);
      return this.store.get(session.id);
    } finally {
      release();
    }
  };

  start = async (id: string, instructions = "", requestId?: string) => {
    await this.ready;
    const session = this.store.get(id);
    if (requestId) {
      if (!instructions.trim())
        throw new AdeError("invalid_input", "An instruction request must contain text.");

      const previous = this.engine.db.all<{
        repair_id: string;
        content: string;
      }>("SELECT repair_id,content FROM repair_messages WHERE id=?", requestId)[0];

      if (previous) {
        if (previous.repair_id !== id || previous.content !== instructions)
          throw new AdeError(
            "invalid_input",
            "This repair instruction request already belongs to different content.",
          );
        return session;
      }
    }

    if (session.workspace.preparation === "removed")
      throw new AdeError(
        "invalid_state",
        "This repair workspace was removed. Its saved history remains available.",
      );
    if (["published", "ready_to_publish", "stale_remote_head"].includes(session.status))
      throw new AdeError(
        "invalid_state",
        "This session cannot start another repair in its current state.",
      );
    if (this.active.has(id) || this.terminalLeases.has(id))
      throw new AdeError("busy", "This repair is already running.");
    if (session.workspace.merge_state === "conflict")
      throw new AdeError(
        "merge_conflict",
        "Resolve and recover the preserved merge before starting agents.",
      );
    if (
      !instructions &&
      ["awaiting_manual_review", "verification_blocked"].includes(session.status)
    )
      throw new AdeError(
        "invalid_input",
        "Describe the further fix before requesting another model run.",
      );

    this.engine.db.transaction(() => {
      if (instructions) {
        this.store.message(id, instructions, requestId);
        session.instructions += `\n\nUser-requested follow-up:\n${instructions}`;
        session.implementation = null;
        session.verification = null;
      }

      session.review_hash = null;
      session.approved_hash = null;
      this.transition(session, "preparing");
    });

    void this.exclusive(
      id,
      "PR repair preparation and agents are running",
      async (current, signal) => {
        try {
          await this.pipeline(current, signal);
        } catch (error) {
          this.transition(
            current,
            signal.aborted
              ? "cancelled"
              : error instanceof AdeError && error.kind === "stale_remote_head"
                ? "stale_remote_head"
                : "failed",
            redact(String(error)),
          );
        }
      },
    ).catch((error) => this.transition(this.store.get(id), "failed", redact(String(error))));

    return this.store.get(id);
  };

  private context = async (session: RepairSession) => {
    const path = await managedPath(
      this.engine.root,
      join(this.engine.root, "artifacts", `repair-${session.id}-context`),
    );

    await mkdir(path, { recursive: true, mode: 0o700 });

    const runtime = await taskRuntime(
      this.engine.db.repository(session.repo_id).path,
      session.workspace.worktree_path,
      true,
    );

    const history = this.engine.db.all(
      "SELECT provider,model,effort,purpose,status,output,error FROM agent_runs WHERE repair_id=? ORDER BY started_at,rowid",
      session.id,
    );

    await writeFile(
      await managedPath(this.engine.root, join(path, "review.json")),
      JSON.stringify({
        identity: session.identity,
        snapshot: session.context.snapshot,
        selectedActions: session.actions,
        instructions: session.instructions,
        runtime,
        history,
        implementation: session.implementation,
        verification: session.verification,
      }),
      { mode: 0o600 },
    );

    return path;
  };

  private validateItems = async (
    session: RepairSession,
    items: { actionId: string; files: string[] }[],
  ) => {
    const expected = session.actions.map((a) => a.id).sort();
    if (
      items
        .map((i) => i.actionId)
        .sort()
        .join() !== expected.join()
    )
      throw new AdeError(
        "repair_evidence",
        "The model must return exactly one result for every selected reviewer observation.",
      );
    for (const item of items)
      for (const path of item.files) await safeFile(session.workspace.worktree_path, path);
  };

  private pipeline = async (session: RepairSession, signal: AbortSignal) => {
    await this.verifyIdentity(session, signal);
    const repo = this.engine.db.repository(session.repo_id);

    const checkpoint = () => {
      this.store.save(session);
      this.changed(session);
    };

    const prepared = await this.workspaces.prepare(session, repo, checkpoint, signal);
    if (prepared === "conflict") {
      this.transition(
        session,
        "merge_conflict",
        "Resolve the listed conflicts in the isolated repair worktree, stage them and recover explicitly.",
      );

      return;
    }

    this.transition(session, "ready_to_repair");
    if (!session.implementation) {
      this.transition(session, "codex_implementing");
      const context = await this.context(session);

      const result = RepairImplementationSchema.parse(
        await this.engine.runRepair(
          repairAssignment(session),
          "codex",
          session.configuration.codex,
          repairPrompt(session, context, "codex"),
          RepairImplementationSchema,
          [context],
          signal,
        ),
      );

      await this.validateItems(session, result.items);
      session.implementation = result;
      checkpoint();
    }

    signal.throwIfAborted();
    await this.workspaces.assert(session, repo);
    if (
      (await gitCapture(["rev-parse", "--verify", "MERGE_HEAD"], session.workspace.worktree_path))
        .code === 0
    )
      throw new AdeError("git_merge", "A merge is still pending; no reviewer will start.");
    this.transition(session, "antigravity_verifying");
    const context = await this.context(session);
    const before = await this.engine.git.repairFingerprint(repairAssignment(session));

    const review = RepairVerificationSchema.parse(
      await this.engine.runRepair(
        repairAssignment(session),
        "antigravity",
        session.configuration.antigravity,
        repairPrompt(session, context, "antigravity"),
        RepairVerificationSchema,
        [context],
        signal,
      ),
    );

    await this.validateItems(session, review.items);
    if (before !== (await this.engine.git.repairFingerprint(repairAssignment(session))))
      throw new AdeError(
        "review_changed",
        "Repair workspace changed during independent verification.",
      );
    session.verification = review;
    session.review_hash = before;

    this.transition(
      session,
      review.overall === "blocked" ? "verification_blocked" : "awaiting_manual_review",
    );
  };

  recoverConflict = async (id: string) =>
    this.exclusive(id, "Resolving PR merge checkpoint", async (session, signal) => {
      if (session.workspace.merge_state !== "conflict")
        throw new AdeError("invalid_state", "This repair has no saved merge conflict.");
      await this.verifyIdentity(session, signal);

      await this.workspaces.recoverConflict(
        session,
        this.engine.db.repository(session.repo_id),
        () => this.store.save(session),
        signal,
      );

      this.transition(session, "ready_to_repair");
      return session;
    });

  detail = async (id: string) => {
    await this.ready;
    const session = this.store.get(id);
    const db = this.engine.db;
    return {
      session,
      active: this.active.has(id) || this.terminalLeases.has(id),
      terminal_open: this.terminalLeases.has(id),
      runs: db.all("SELECT * FROM agent_runs WHERE repair_id=? ORDER BY started_at,rowid", id),
      events: db.all(
        "SELECT * FROM (SELECT * FROM agent_events WHERE repair_id=? ORDER BY id DESC LIMIT 2000) ORDER BY id",
        id,
      ),
      messages: db.all(
        "SELECT * FROM repair_messages WHERE repair_id=? ORDER BY created_at,rowid",
        id,
      ),
      activity: db.all("SELECT * FROM repair_activity WHERE repair_id=? ORDER BY id", id),
      tests: db.all("SELECT * FROM test_runs WHERE repair_id=? ORDER BY started_at,rowid", id),
      usage: db.all("SELECT * FROM ai_usage WHERE repair_id=? ORDER BY started_at", id),
      publications: db.all(
        "SELECT * FROM repair_publications WHERE repair_id=? ORDER BY created_at,rowid",
        id,
      ),
    };
  };

  approve = async (id: string, expectedHash: string) => {
    await this.ready;
    return this.exclusive(
      id,
      "Preparing manually approved PR publication",
      async (session, signal) => {
        await this.publisher.approve(session, expectedHash);
        return this.publisher.prepare(session, signal);
      },
    );
  };

  approveLocal = async (id: string, expectedHash: string) => {
    await this.ready;
    return this.exclusive(id, "Approving reviewed local PR commit", async (session) => {
      await this.publisher.approve(session, expectedHash);

      this.store.activity(session, "local_only_approval", {
        timestamp: now(),
      });

      return session;
    });
  };

  commit = async (id: string, expectedHash: string, message: string) => {
    await this.ready;
    return this.exclusive(id, "Creating reviewed local PR commit", (session, signal) =>
      this.publisher.commit(session, expectedHash, message, signal),
    );
  };

  preparePublication = async (id: string) => {
    await this.ready;
    return this.exclusive(id, "Preparing exact PR publication operation", (session, signal) =>
      this.publisher.prepare(session, signal),
    );
  };

  publish = async (id: string, publicationId: string) => {
    await this.ready;
    return this.exclusive(id, "Publishing explicitly confirmed PR repair", (session, signal) =>
      this.publisher.pushConfirmed(session, publicationId, signal),
    );
  };

  reconcilePublication = async (id: string, publicationId: string) => {
    await this.ready;
    return this.exclusive(id, "Reconciling PR publication read-only", (session) =>
      this.publisher.reconcile(session, publicationId),
    );
  };

  keepLocal = async (id: string) => {
    await this.ready;
    return this.exclusive(id, "Keeping PR repair local", async (session) => {
      if (session.status === "ready_to_publish") {
        session.approved_hash = null;
        this.transition(session, "awaiting_manual_review");
      }

      this.store.activity(session, "kept_local", { timestamp: now() });
      return session;
    });
  };

  assignment = (id: string): WorkspaceAssignment => repairAssignment(this.store.get(id));

  openPath = async (id: string) => {
    await this.ready;
    const session = this.store.get(id);
    return this.workspaces.assert(session, this.engine.db.repository(session.repo_id));
  };

  acquireTerminal = async (id: string) => {
    await this.ready;
    this.engine.assertAvailable();
    if (this.active.has(id) || this.terminalLeases.has(id))
      throw new AdeError("busy", "Close the active repair operation before opening its terminal.");
    this.terminalLeases.add(id);
    let releaseDestination: (() => Promise<void>) | undefined;
    try {
      const session = this.store.get(id);
      const cwd = await this.openPath(id);

      releaseDestination = await this.engine.git.acquireWrite(
        cwd,
        `pr:${session.identity.head.id}:${session.identity.head.branch}`,
      );

      const releaseWorkspace = await this.engine.git.acquireWrite(
        cwd,
        `branch:${session.workspace.branch_name}`,
      );

      return async () => {
        await releaseWorkspace();
        await releaseDestination!();
        this.terminalLeases.delete(id);
        this.changed(session);
      };
    } catch (error) {
      await releaseDestination?.();
      this.terminalLeases.delete(id);
      throw error;
    }
  };

  command = async (id: string, argv: string[]) => {
    await this.ready;
    return this.exclusive(
      id,
      "PR repair validation command is running",
      async (session, signal) => {
        await this.openPath(id);
        return this.engine.manual(id, argv, signal, true, repairAssignment(session));
      },
    );
  };

  cleanup = async (id: string, history: boolean) => {
    await this.ready;
    return this.exclusive(id, "Removing owned PR repair workspace", async (session) => {
      const paths = [
        join(this.engine.root, "logs", id),
        join(this.engine.root, "artifacts", `repair-${id}-context`),
      ];

      if (history) for (const path of paths) await managedPath(this.engine.root, path);

      await this.workspaces.cleanup(session, this.engine.db.repository(session.repo_id), () =>
        this.store.save(session),
      );

      this.store.activity(session, "workspace_removed", { timestamp: now() });
      if (history) {
        for (const path of paths)
          await rm(await managedPath(this.engine.root, path), {
            recursive: true,
            force: true,
          });

        this.engine.db.transaction(() => {
          for (const table of [
            "agent_events",
            "test_runs",
            "terminal_sessions",
            "repair_messages",
            "repair_activity",
            "repair_publications",
            "repair_reviewed_files",
            "agent_runs",
          ])
            this.engine.db.run(`DELETE FROM ${table} WHERE repair_id=?`, id);
          this.engine.db.run("DELETE FROM pr_repairs WHERE id=?", id);
        });
      }

      return { removed: true, history_removed: history };
    });
  };

  reviewFiles = async (id: string) => {
    await this.ready;
    const session = this.store.get(id);
    await this.openPath(id);
    const assignment = repairAssignment(session);
    const diff = await this.engine.git.diff(assignment);

    const saved = this.engine.db.all<{ path: string; source_hash: string }>(
      "SELECT path,source_hash FROM repair_reviewed_files WHERE repair_id=?",
      id,
    );

    const result = [];
    for (const file of diff.files) {
      if (file.binary) continue;
      const content = await this.engine.git.file(assignment, file.path, file.old_path);
      const hash = fileHash(content.original, content.modified);

      result.push({
        path: file.path,
        hash,
        reviewed: saved.some((row) => row.path === file.path && row.source_hash === hash),
      });
    }

    return result;
  };

  reviewed = async (
    id: string,
    path: string,
    oldPath: string | null | undefined,
    expectedHash: string,
    reviewed: boolean,
  ) => {
    await this.ready;
    return this.exclusive(id, "Recording reviewed repair file", async (session) => {
      const content = await this.engine.git.file(repairAssignment(session), path, oldPath);
      if (content.binary || fileHash(content.original, content.modified) !== expectedHash)
        throw new AdeError(
          "review_changed",
          "This file changed during review. Refresh before marking it reviewed.",
        );
      if (reviewed)
        this.engine.db.run(
          "INSERT INTO repair_reviewed_files VALUES(?,?,?,?) ON CONFLICT(repair_id,path) DO UPDATE SET source_hash=excluded.source_hash,reviewed_at=excluded.reviewed_at",
          id,
          path,
          expectedHash,
          now(),
        );
      else
        this.engine.db.run(
          "DELETE FROM repair_reviewed_files WHERE repair_id=? AND path=?",
          id,
          path,
        );
      return { reviewed };
    });
  };

  isActive = (id: string) => this.active.has(id) || this.terminalLeases.has(id);

  cancel = async (id: string) => {
    const operation = this.active.get(id);
    if (!operation) throw new AdeError("invalid_state", "This repair has no active operation.");
    operation.controller.abort();
    await operation.promise.catch(() => {});
    return this.store.get(id);
  };

  close = async () => {
    await this.ready;
    for (const creation of this.creating.values()) creation.controller.abort();

    await Promise.all(
      [...this.creating.values()].map((creation) => creation.promise.catch(() => {})),
    );

    for (const operation of this.active.values()) operation.controller.abort();

    await Promise.all(
      [...this.active.values()].map((operation) => operation.promise.catch(() => {})),
    );
  };
}
