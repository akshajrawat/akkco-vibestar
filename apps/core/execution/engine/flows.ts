import { z } from "zod";
import { createHash } from "node:crypto";

import { AdeError, now, type Task } from "../../domain";
import type { ViberChatSchema } from "../../flows/run-contracts";
import {
  ApprovalDecisionSchema,
  FlowStartSchema,
  type ApprovalDecision,
  type FlowRun,
} from "../../flows/run-contracts";
import { FlowDispatchStore, type DispatchRequest } from "../../flows/dispatch-store";
import { resolveNodeInputs } from "../../flows/context";
import { prepareManagedWorkspace } from "../../workspace/managed";
import { taskRuntime } from "../../workspace/runtime";
import type { Engine } from "../engine";
import type { AgentRunner } from "../agents/agent-runner";
import { redact } from "../runtime/process";
import type { ExecutionState } from "./state";
import type { EngineScheduling } from "./scheduling";
import {
  continuationPlan,
  continuationRequestDigest,
  ContinuationApplySchema,
  ContinuationTargetSchema,
  ContinuationPlanSchema,
} from "../../flows/continuation";
import { legacyMigration } from "../../flows/legacy-migration";
import { FlowNodeExecutor } from "./flow-node";
import { ViberConversationRequests } from "./viber-conversations";

const runInput = z.object({ run_id: z.string().uuid(), request_id: z.string().uuid() }).strict();
const nodeInput = runInput.extend({ node_id: z.string().uuid() }).strict();
const retryInput = nodeInput.extend({ attempt_id: z.string().uuid() }).strict();

const message = (error: unknown) =>
  redact(error instanceof Error ? error.message : String(error)).slice(0, 32000);

/** Explicit graph execution uses the same slots, cancellation state, runner and workspace ownership. */
export class FlowExecution {
  readonly dispatches: FlowDispatchStore;

  private readonly nodeExecutor: FlowNodeExecutor;

  private readonly viberConversations: ViberConversationRequests;

  constructor(
    private readonly host: Pick<
      Engine,
      | "db"
      | "root"
      | "git"
      | "prepareClone"
      | "flows"
      | "flowRuns"
      | "changed"
      | "publish"
      | "isActive"
      | "assertAvailable"
      | "drain"
      | "withTaskMaintenance"
      | "manual"
    >,
    private readonly state: ExecutionState,
    runner: AgentRunner,
    private readonly slots: { withExecutionSlot: EngineScheduling["withExecutionSlot"] },
  ) {
    this.dispatches = new FlowDispatchStore(host.db);
    this.nodeExecutor = new FlowNodeExecutor(host, state, runner, this.dispatches);

    this.viberConversations = new ViberConversationRequests(
      host,
      state,
      this.dispatches,
      this.assertTaskOpen,
    );
  }

  previewContinuation = (raw: z.input<typeof ContinuationTargetSchema>) =>
    this.track(async () => {
      this.host.assertAvailable();
      const input = ContinuationTargetSchema.parse(raw);
      const run = this.host.flowRuns.run(input.run_id);
      return this.host.withTaskMaintenance(
        run.task_id,
        async () => {
          const task = this.host.db.task(run.task_id);
          if (task.worktree_path) await this.host.git.assertOwnedTask(task);

          const fingerprint = task.worktree_path
            ? await this.host.git.fingerprint(task)
            : `unprepared:${task.id}`;

          this.state.repositoryController.signal.throwIfAborted();
          return continuationPlan(this.host.db, this.host.flowRuns, input, fingerprint);
        },
        "Checking a continuation preview",
      );
    });

  applyContinuation = (raw: z.input<typeof ContinuationApplySchema>) => {
    const input = ContinuationApplySchema.parse(raw);
    const digest = continuationRequestDigest(input);
    const pending = this.state.flowContinuations.get(input.request_id);
    if (pending) {
      if (pending.digest !== digest)
        throw new AdeError(
          "request_conflict",
          "This continuation request belongs to a different saved revision or preview.",
        );
      return pending.promise;
    }

    const result = this.applyContinuationOnce(input, digest).finally(() =>
      this.state.flowContinuations.delete(input.request_id),
    );

    this.state.flowContinuations.set(input.request_id, { digest, promise: result });
    return result;
  };

  private applyContinuationOnce = (
    input: z.output<typeof ContinuationApplySchema>,
    digest: string,
  ) =>
    this.track(async () => {
      this.host.assertAvailable();

      const previous = this.host.db.all<{ request_digest: string; run_id: string; plan: string }>(
        "SELECT request_digest,run_id,plan FROM flow_continuations WHERE request_id=?",
        input.request_id,
      )[0];

      if (previous) {
        if (previous.request_digest !== digest)
          throw new AdeError(
            "request_conflict",
            "This continuation request belongs to a different saved revision or preview.",
          );

        this.host.db.records.decode(
          {
            table: "flow_continuations",
            id: input.request_id,
            column: "plan",
            source: previous.plan,
          },
          ContinuationPlanSchema.parse,
        );

        return this.host.flowRuns.run(previous.run_id);
      }

      const parent = this.host.flowRuns.run(input.run_id);
      this.assertTaskOpen(parent.task_id);
      return this.host.withTaskMaintenance(
        parent.task_id,
        async () => {
          const task = this.host.db.task(parent.task_id);
          if (task.worktree_path) await this.host.git.assertOwnedTask(task);

          const fingerprint = task.worktree_path
            ? await this.host.git.fingerprint(task)
            : `unprepared:${task.id}`;

          this.state.repositoryController.signal.throwIfAborted();

          const plan = continuationPlan(
            this.host.db,
            this.host.flowRuns,
            { run_id: input.run_id, revision: input.revision },
            fingerprint,
          );

          if (plan.hash !== input.plan_hash)
            throw new AdeError(
              "stale_continuation",
              "The saved settings, inputs or workspace changed after this preview. Inspect a fresh continuation preview.",
            );

          const run = this.host.db.transaction(() => {
            if (
              this.host.db.all("SELECT id FROM flow_runs WHERE request_id=?", input.request_id)
                .length
            )
              throw new AdeError(
                "request_conflict",
                "This request identity already belongs to another flow startup action.",
              );

            const captured = this.host.flowRuns.createRun({
              task_id: task.id,
              flow_id: parent.flow_id,
              revision: input.revision,
              goal: task.goal!,
              parent_run_id: parent.id,
              request_id: input.request_id,
            });

            const captureHash = createHash("sha256")
              .update(JSON.stringify(captured.snapshot))
              .digest("hex");

            if (captureHash !== plan.configuration_hash)
              throw new AdeError(
                "stale_continuation",
                "The captured settings changed. Inspect a fresh preview.",
              );
            for (const node of plan.nodes)
              if (node.status === "reuse" && node.source_attempt_id)
                this.host.flowRuns.linkResult(
                  captured.id,
                  node.node_id,
                  node.source_attempt_id,
                  fingerprint,
                );

            this.host.db.run(
              "INSERT INTO flow_continuations VALUES(?,?,?,?,?,?)",
              input.request_id,
              digest,
              captured.id,
              parent.id,
              JSON.stringify(plan),
              now(),
            );

            this.dispatches.stopRun(parent.id, "cancelled");
            this.dispatches.enqueue({ id: input.request_id, run_id: captured.id, kind: "flow" });
            return captured;
          });

          this.host.changed(task.id);
          return run;
        },
        "Applying a saved flow revision",
      );
    });

  chatViber = (raw: z.input<typeof ViberChatSchema>) => this.viberConversations.chat(raw);

  start = (raw: z.input<typeof FlowStartSchema>) => {
    this.host.assertAvailable();
    const input = FlowStartSchema.parse(raw);

    const run = this.host.db.transaction(() => {
      const existing =
        this.host.db.all("SELECT id FROM flow_runs WHERE request_id=?", input.request_id).length >
        0;

      if (!existing) {
        const task = this.host.db.task(input.task_id);
        if (task.flow_id !== input.flow_id || !task.goal || task.goal !== input.goal)
          throw new AdeError(
            "invalid_state",
            "Use the task's current goal and owned flow before starting execution.",
          );
        if (
          task.archived ||
          ["preserved", "completed"].includes(task.status) ||
          this.state.taskMaintenance.has(task.id)
        )
          throw new AdeError(
            "busy",
            "Reopen this task and finish maintenance before starting a flow.",
          );
      }

      const captured = this.host.flowRuns.createRun(input);

      const request: DispatchRequest = {
        id: captured.request_id,
        run_id: captured.id,
        kind: "flow",
      };

      if (existing && !this.dispatches.replay(request))
        throw new AdeError(
          "request_completed",
          "This startup request already exists without a live dispatch. Submit a new explicit run request.",
        );
      this.dispatches.enqueue(request);
      if (captured.parent_run_id) this.dispatches.stopRun(captured.parent_run_id, "cancelled");
      return captured;
    });

    this.host.changed(run.task_id);
    void this.host.drain();
    return run;
  };

  continue = (input: z.input<typeof runInput>) => {
    const request = runInput.parse(input);
    const run = this.host.flowRuns.run(request.run_id);
    const checkpoint = run.origin === "historical" && !this.host.flowRuns.attempts(run.id).length;
    return this.enqueue(
      { id: request.request_id, run_id: request.run_id, kind: "flow" },
      checkpoint ? ["paused", "waiting", "interrupted", "cancelled", "failed"] : ["paused"],
    );
  };

  runNode = (input: z.input<typeof nodeInput>) => {
    const request = nodeInput.parse(input);
    return this.enqueue(
      { id: request.request_id, run_id: request.run_id, kind: "node", node_id: request.node_id },
      ["paused", "waiting", "failed"],
    );
  };

  retryNode = (input: z.input<typeof retryInput>) => {
    const request = retryInput.parse(input);
    return this.enqueue(
      {
        id: request.request_id,
        run_id: request.run_id,
        kind: "retry",
        node_id: request.node_id,
        retry_of: request.attempt_id,
      },
      ["paused", "waiting", "failed", "interrupted", "cancelled"],
    );
  };

  private enqueue = (request: DispatchRequest, allowed: FlowRun["status"][]) => {
    this.host.assertAvailable();

    const dispatch = this.host.db.transaction(() => {
      const replay = this.dispatches.replay(request);
      if (replay) return replay;
      const run = this.host.flowRuns.run(request.run_id);
      this.assertTaskOpen(run.task_id);
      this.assertGraphAvailable(run);
      if (run.kind === "conversation") {
        const latest = this.host.db.all<{ id: string }>(
          "SELECT id FROM flow_runs WHERE task_id=? AND kind='flow' ORDER BY rowid DESC LIMIT 1",
          run.task_id,
        )[0];

        if ((latest?.id || null) !== run.parent_run_id)
          throw new AdeError(
            "invalid_state",
            "This conversation predates the current graph. Send a new message to capture its current workspace context.",
          );
        if (
          latest &&
          ["queued", "running", "pausing"].includes(this.host.flowRuns.run(latest.id).status)
        )
          throw new AdeError("busy", "Pause the graph before continuing this conversation.");
      }

      if (this.state.taskMaintenance.has(run.task_id) || this.host.isActive(run.task_id))
        throw new AdeError("busy", "Wait for the task's current operation or terminal to stop.");
      if (!allowed.includes(run.status))
        throw new AdeError(
          "invalid_state",
          "This run needs a different explicit execution action.",
        );
      const saved = this.dispatches.enqueue(request);
      if (run.kind === "conversation")
        this.host.db.run(
          "UPDATE task_messages SET status='chat_pending' WHERE id=? AND task_id=? AND purpose='chat'",
          run.request_id,
          run.task_id,
        );
      return saved;
    });

    this.host.changed(this.host.flowRuns.run(dispatch.run_id).task_id);
    void this.host.drain();
    return dispatch;
  };

  pause = (runId: string) => {
    this.host.assertAvailable();
    const run = this.host.flowRuns.run(runId);
    if (["paused", "pausing"].includes(run.status)) return run;

    const updated = this.host.db.transaction(() => {
      if (run.status === "queued") this.dispatches.stopRun(run.id, "cancelled");
      return this.host.flowRuns.setRunStatus(
        run.id,
        run.status,
        run.status === "running" ? "pausing" : "paused",
      );
    });

    this.host.changed(run.task_id);
    return updated;
  };

  cancel = (runId: string) =>
    this.track(async () => {
      this.host.assertAvailable();
      const run = this.host.flowRuns.run(runId);
      if (["completed", "continued", "cancelled", "failed", "interrupted"].includes(run.status))
        return run;
      const control = this.dispatches.latest(run.id);
      if (run.status !== "cancelled") {
        this.host.db.transaction(() => {
          this.host.flowRuns.setRunStatus(run.id, run.status, "cancelled");
          this.dispatches.stopRun(run.id, "cancelled");
        });
      }

      const active = control?.status === "running" ? this.state.active.get(run.task_id) : undefined;
      active?.controller.abort();
      this.host.changed(run.task_id);
      await active?.promise;
      this.nodeExecutor.finishConversationMessage(run.id);
      return this.host.flowRuns.run(run.id);
    });

  approve = (raw: Omit<ApprovalDecision, "created_at">) => {
    const input = ApprovalDecisionSchema.omit({ created_at: true }).parse(raw);
    const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const pending = this.state.flowApprovals.get(input.request_id);
    if (pending) {
      if (pending.digest !== digest)
        throw new AdeError(
          "request_conflict",
          "This approval request is settling a different decision.",
        );
      return pending.promise;
    }

    const result = this.approveOnce(input).finally(() =>
      this.state.flowApprovals.delete(input.request_id),
    );

    this.state.flowApprovals.set(input.request_id, { digest, promise: result });
    return result;
  };

  private approveOnce = (input: Omit<ApprovalDecision, "created_at">) =>
    this.track(async () => {
      this.host.assertAvailable();
      const attempt = this.host.flowRuns.attempt(input.attempt_id);
      const run = this.host.flowRuns.run(attempt.run_id);
      if (
        this.host.db.all(
          "SELECT attempt_id FROM flow_approval_decisions WHERE attempt_id=? OR request_id=?",
          input.attempt_id,
          input.request_id,
        ).length
      )
        return this.host.flowRuns.decideApproval(input, attempt.workspace_fingerprint);
      this.assertTaskOpen(run.task_id);
      this.assertGraphAvailable(run);
      return this.host.withTaskMaintenance(
        run.task_id,
        async () => {
          const fingerprint = await this.host.git.fingerprint(this.host.db.task(run.task_id));
          this.state.repositoryController.signal.throwIfAborted();

          const decision = this.host.db.transaction(() => {
            const previous =
              this.host.db.all(
                "SELECT attempt_id FROM flow_approval_decisions WHERE attempt_id=?",
                attempt.id,
              ).length > 0;

            const saved = this.host.flowRuns.decideApproval(input, fingerprint);
            if (previous) return saved;
            const current = this.host.flowRuns.run(run.id);
            const control = this.dispatches.latest(run.id);
            if (control?.status === "waiting")
              this.dispatches.settle(
                control.id,
                saved.decision === "accepted" ? "completed" : "failed",
              );
            if (saved.decision === "rejected")
              this.host.flowRuns.setRunStatus(
                run.id,
                current.status,
                "failed",
                "A required approval was rejected.",
              );
            else if (current.status !== "paused") {
              if (this.nodeExecutor.complete(run.id))
                this.host.flowRuns.setRunStatus(run.id, current.status, "completed");
              else if (control?.kind === "flow")
                this.dispatches.enqueue({ id: saved.request_id, run_id: run.id, kind: "flow" });
              else this.host.flowRuns.setRunStatus(run.id, current.status, "paused");
            }

            return saved;
          });

          this.host.changed(run.task_id);
          return decision;
        },
        "Flow approval is being checked",
      );
    });

  queuedTasks = () =>
    this.dispatches.queued().flatMap((dispatch) => {
      try {
        return [{ dispatch, run: this.host.flowRuns.run(dispatch.run_id) }];
      } catch (error) {
        if (error instanceof AdeError && error.kind === "corrupt_record") return [];
        throw error;
      }
    });

  drain = () => {
    for (const { dispatch, run } of this.queuedTasks()) {
      if (
        this.state.closed ||
        this.state.maintenance ||
        this.state.active.size >= this.host.db.settings().concurrency
      )
        break;
      if (this.host.isActive(run.task_id) || this.state.taskMaintenance.has(run.task_id)) continue;

      void this.slots
        .withExecutionSlot(
          run.task_id,
          run.kind === "conversation" ? "Viber conversation" : "Viber flow",
          this.state.repositoryController.signal,
          (signal) => this.execute(dispatch.id, signal),
          run.task_id,
        )
        .catch((error) => {
          // Slot refusal starts no process. The request remains queued for the next lease release.
          if (!(error instanceof AdeError && error.kind === "busy"))
            this.host.publish({ event: "core.error", text: message(error) });
        });
    }
  };

  private prepare = async (run: FlowRun, signal: AbortSignal): Promise<Task> => {
    let task = this.host.db.task(run.task_id);
    if (task.workspace_kind === "managed") {
      task = await prepareManagedWorkspace(this.host.root, task);
      this.host.db.saveTask(task);
    } else if (task.workspace_checkpoint?.state !== "ready") {
      const repo = this.host.db.repository(task.repo_id);
      if (repo.connected === false)
        throw new AdeError(
          "repository_missing",
          "Reconnect this repository before executing the flow.",
        );
      await this.host.prepareClone(repo, signal);

      await this.host.git.prepare(
        repo,
        task,
        signal,
        (value) => this.host.db.saveTask(value),
        async (record) => {
          this.host.db.run(
            "INSERT INTO task_activity(task_id,kind,data,timestamp) VALUES(?,'preparation',?,?)",
            task.id,
            JSON.stringify(record),
            now(),
          );
        },
      );

      this.host.db.saveTask(task);
    }

    await this.host.git.assertOwnedTask(task);
    if (task.repo_id) {
      const repo = this.host.db.repository(task.repo_id);

      const { python, dependencies, warnings } = await taskRuntime(
        repo.path,
        task.worktree_path,
        true,
      );

      task = { ...task, runtime: { python, dependencies, warnings } };
      this.host.db.saveTask(task);
    }

    signal.throwIfAborted();
    this.host.changed(task.id);
    return task;
  };

  private execute = async (dispatchId: string, signal: AbortSignal) => {
    const dispatch = this.dispatches.claim(dispatchId);
    if (!dispatch) return;
    const run = this.host.flowRuns.run(dispatch.run_id);
    try {
      const task = await this.prepare(run, signal);
      const previous = this.host.flowRuns.attempts(run.id);
      if (run.kind === "flow" && dispatch.kind === "flow" && previous.length) {
        const last = previous.at(-1)!;
        if (!["completed", "waiting"].includes(last.status))
          throw new AdeError(
            "invalid_state",
            "Retry the stopped node explicitly before continuing this graph.",
          );

        const expected =
          last.status === "completed" ? last.completed_fingerprint : last.workspace_fingerprint;

        if (!expected || expected !== (await this.host.git.fingerprint(task))) {
          const reason =
            "The workspace no longer matches the last captured node. Apply a saved revision or start a fresh graph run; no provider was started.";

          this.host.flowRuns.invalidateWorkspace(run.id, reason);
          throw new AdeError("stale_workspace", reason);
        }
      }

      if (!previous.length) {
        const reused = this.host.db.all<{ workspace_fingerprint: string }>(
          "SELECT workspace_fingerprint FROM flow_result_links WHERE run_id=?",
          run.id,
        );

        if (reused.length) {
          const actual = await this.host.git.fingerprint(task);
          if (reused.some((result) => result.workspace_fingerprint !== actual))
            this.host.flowRuns.invalidateReusedResults(
              run.id,
              "The workspace changed while this continuation was queued.",
            );
          if (this.host.flowRuns.staleResults(run.id).length && dispatch.kind === "flow")
            throw new AdeError(
              "stale_result",
              "The workspace changed while this continuation was queued. Preview a fresh continuation or run an eligible node explicitly to recompute work.",
            );
        }
      }

      while (true) {
        signal.throwIfAborted();
        const current = this.host.flowRuns.run(run.id);
        if (current.status === "pausing") {
          this.host.flowRuns.setRunStatus(run.id, "pausing", "paused");
          this.dispatches.settle(dispatch.id, "completed");
          return;
        }

        if (current.status !== "running") return;
        const attempts = this.host.flowRuns.results(run.id);
        const latest = (id: string) => attempts.filter((attempt) => attempt.node_id === id).at(-1);
        const graph = this.host.flowRuns.definition(run.id);

        const ready = graph.nodes
          .filter((node) => {
            if (dispatch.node_id)
              return (
                node.id === dispatch.node_id &&
                (dispatch.kind === "retry"
                  ? latest(node.id)?.id === dispatch.retry_of
                  : !latest(node.id))
              );
            return (
              !latest(node.id) &&
              graph.edges
                .filter((edge) => edge.target === node.id)
                .every((edge) => latest(edge.source)?.status === "completed")
            );
          })
          .sort((a, b) => Number(a.type === "approval") - Number(b.type === "approval"));

        const node = ready[0];
        if (!node) {
          const complete = this.nodeExecutor.complete(run.id);
          const waiting = attempts.some((attempt) => attempt.status === "waiting");

          const failed = attempts.some(
            (attempt) =>
              ["failed", "rejected", "cancelled", "interrupted"].includes(attempt.status) &&
              latest(attempt.node_id)?.id === attempt.id,
          );

          const status = complete
            ? "completed"
            : waiting
              ? "waiting"
              : dispatch.kind !== "flow" && !failed
                ? "paused"
                : "failed";

          this.host.flowRuns.setRunStatus(
            run.id,
            "running",
            status,
            status === "failed"
              ? "A node failed or its dependencies are blocked. Retry the specific node explicitly."
              : null,
          );

          this.dispatches.settle(
            dispatch.id,
            status === "waiting" ? "waiting" : status === "failed" ? "failed" : "completed",
          );

          return;
        }

        const inputs = resolveNodeInputs(this.host.db, this.host.flowRuns, run.id, node.id);
        await this.host.git.assertOwnedTask(task);
        const fingerprint = await this.host.git.fingerprint(task);
        if (run.origin === "historical" && node.type === "approval") {
          const imported = legacyMigration(this.host.db, task.id);
          const boundary = imported?.nodes.find((slot) => slot.id === node.id);
          if (
            boundary?.stage === 5 &&
            imported?.boundary_node_id === node.id &&
            (!imported.final_review_fingerprint?.startsWith("issue-v2:") ||
              imported.final_review_fingerprint !== fingerprint)
          )
            throw new AdeError(
              "stale_review",
              "The imported final review no longer proves the current workspace. Add a fresh read-only Reviewer and apply the saved revision before accepting it; the original review was preserved.",
            );
        }

        signal.throwIfAborted();
        if (this.host.flowRuns.run(run.id).status === "pausing") continue;

        const attempt = this.host.flowRuns.beginAttempt(
          run.id,
          node.id,
          inputs,
          fingerprint,
          dispatch.retry_of ?? undefined,
          dispatch.id,
        );

        this.host.changed(task.id);
        if (node.type !== "approval") await this.nodeExecutor.execute(task, attempt, signal);
        if (dispatch.node_id) {
          const result = this.host.flowRuns.attempt(attempt.id);
          const state = this.host.flowRuns.run(run.id);
          if (state.status === "running") {
            const status =
              result.status === "waiting"
                ? "waiting"
                : result.status === "failed"
                  ? "failed"
                  : this.nodeExecutor.complete(run.id)
                    ? "completed"
                    : "paused";

            this.host.flowRuns.setRunStatus(run.id, "running", status, result.error);

            this.dispatches.settle(
              dispatch.id,
              status === "waiting" ? "waiting" : status === "failed" ? "failed" : "completed",
            );

            return;
          }
        }
      }
    } catch (error) {
      const current = this.host.flowRuns.run(run.id);
      const status = signal.aborted ? (this.state.closed ? "interrupted" : "cancelled") : "failed";
      if (
        current.status !== status &&
        !["cancelled", "continued", "completed"].includes(current.status)
      )
        this.host.flowRuns.setRunStatus(run.id, current.status, status, message(error));
      this.dispatches.settle(dispatch.id, status, message(error));
    } finally {
      this.nodeExecutor.finishConversationMessage(run.id);
      this.host.changed(run.task_id);
    }
  };

  private assertTaskOpen = (taskId: string) => {
    const task = this.host.db.task(taskId);
    if (task.archived || ["completed", "preserved"].includes(task.status))
      throw new AdeError(
        "invalid_state",
        "Reopen this task before authorizing more flow execution.",
      );
  };

  private track = <T>(operation: () => Promise<T>) => {
    const result = operation();
    this.state.flowRequests.add(result);
    void result.finally(() => this.state.flowRequests.delete(result)).catch(() => {});
    return result;
  };

  private assertGraphAvailable = (run: FlowRun) => {
    if (run.kind !== "flow") return;
    if (this.host.flowRuns.invalidation(run.id))
      throw new AdeError(
        "stale_workspace",
        "A separate Viber changed this workspace. Apply a saved revision or start a fresh graph run.",
      );
    if (
      this.host.db.all(
        "SELECT id FROM flow_runs WHERE task_id=? AND kind='conversation' AND status IN ('queued','running','pausing','paused') LIMIT 1",
        run.task_id,
      ).length
    )
      throw new AdeError(
        "busy",
        "Finish or stop the Viber conversation before continuing the graph.",
      );
  };
}
