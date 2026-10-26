import type { Engine } from "../engine";
import type { ExecutionState } from "./state";

import { randomUUID } from "node:crypto";
import { AdeError, FollowupConfigSchema, now, retryTarget, type Task } from "../../domain";
import { continuationStage } from "../agents/continuation";
import { redact } from "../runtime/process";
import { object, validatePlan } from "../providers/contracts";
import { StreamedPlan } from "../agents/streamed-plan";
import { taskVerification } from "../verification/task-verification";
/** Preserves durable approval gates and explicit continuation decisions without starting implicit work. */
export class ApprovalTransitions {
  constructor(
    private readonly host: Pick<
      Engine,
      | "assertAvailable"
      | "db"
      | "isActive"
      | "git"
      | "changed"
      | "drain"
      | "reviewGapsPreview"
      | "isExecuting"
    >,
    private readonly state: ExecutionState,
  ) {}
  retry = async (id: string, stage?: number, restart = false) => {
    this.host.assertAvailable();
    if (this.state.taskMaintenance.has(id))
      throw new AdeError("busy", "Task data cleanup is running");
    const t = this.host.db.task(id);
    if (t.status === "preserved" || (t.workflow_version === 1 && !t.workflow_start))
      throw new AdeError(
        "workflow_not_started",
        "Use Start workflow to explicitly authorize this task's first execution.",
      );
    if (t.status === "awaiting_approval" && stage === undefined && !restart)
      throw new AdeError(
        "approval_required",
        "Review and approve the saved stage before continuing.",
      );
    if (this.host.db.repository(t.repo_id).connected === false)
      throw new AdeError(
        "repository_missing",
        "Reconnect the source repository before resuming this task.",
      );
    if (t.stage === 0 && t.worktree_path && !this.host.isActive(id)) {
      if (
        await this.host.git.recoverTaskPreparation(this.host.db.repository(t.repo_id), t, (value) =>
          this.host.db.saveTask(value),
        )
      )
        t.stage = 1;
    }
    const pending = this.host.db.all<{ id: string; configuration: string | null }>(
      "SELECT id,configuration FROM task_messages WHERE task_id=? AND status='queued' ORDER BY created_at,rowid",
      id,
    );
    const target = restart
      ? t.worktree_path
        ? 1
        : 0
      : (stage ?? (pending.length ? continuationStage(this.host.db, t) : Math.min(t.stage, 5)));
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
    retryTarget(t, target, this.host.isActive(id));
    if (target >= 2) this.host.db.artifact(id, 1);
    if (target >= 3) this.host.db.artifact(id, 2);
    if (target === 5) this.host.db.artifact(id, 3);
    if (target === 5 && !taskVerification(this.host.db, id).canReview)
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
        t.followup_config = this.host.db.records.decode(
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
      this.host.db.run(
        "UPDATE task_messages SET status='delivered' WHERE task_id=? AND status='queued'",
        id,
      );
    if (target <= 3 || target === 5)
      this.host.db.run("DELETE FROM task_artifacts WHERE task_id=? AND stage>=?", id, target);
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
    this.host.db.saveTask(updated);
    this.host.changed(id);
    void this.host.drain();
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
    this.host.assertAvailable();
    const original = this.host.db.task(id);
    const task =
      gapAcknowledgment && original.status === "verification_blocked" && original.stage === 4
        ? ({
            ...original,
            status: "awaiting_approval",
            approval_gate: "implementation",
          } as Task)
        : original;
    if (this.host.isActive(id) || this.state.taskMaintenance.has(id))
      throw new AdeError("busy", "Wait for task activity to finish before approving.");
    if (this.host.db.repository(task.repo_id).connected === false)
      throw new AdeError(
        "repository_missing",
        "Reconnect the source repository before continuing.",
      );
    if (task.status !== "awaiting_approval" || !task.approval_gate)
      throw new AdeError("invalid_state", "This task is not waiting for a pipeline approval.");
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
    const result = validatePlan(completedStage, this.host.db.artifact(id, completedStage));
    if (
      artifactId &&
      this.host.db.all<{ id: string }>(
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
      const verification = taskVerification(this.host.db, id);
      if (!verification.canReview && !gapAcknowledgment)
        throw new AdeError("verification_blocked", verification.summary);
      if (gapAcknowledgment) {
        const preview = await this.host.reviewGapsPreview(id);
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
        taskVerification(this.host.db, id).outcome === "failed" ||
        task.final_review_verdict === "changes_requested")
    )
      throw new AdeError(
        "review_required",
        "Antigravity reported unresolved findings or blocked validation. Request changes or retry the review before completing.",
      );
    if (completedStage === 5 && task.final_review_hash !== (await this.host.git.fingerprint(task)))
      throw new AdeError(
        "stale_review",
        "The worktree changed after Antigravity reviewed it. Run the final review again.",
      );
    const pendingIds = () =>
      this.host.db
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
          pending.some((message) => !instructions.message_ids.includes(message))))
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
    const current = this.host.db.task(id);
    if (
      current.status !== original.status ||
      current.approval_gate !== original.approval_gate ||
      JSON.stringify(pendingIds()) !== JSON.stringify(pending) ||
      this.host.isActive(id)
    )
      throw new AdeError(
        "invalid_state",
        "The task changed while approving. Refresh and review its current state.",
      );
    this.host.db.transaction(() => {
      if (instructions?.disposition === "include_next_stage")
        for (const message of pending)
          this.host.db.run(
            "UPDATE task_messages SET status='delivered' WHERE id=? AND task_id=?",
            message,
            id,
          );
      else
        this.host.db.run(
          "UPDATE task_messages SET status='draft' WHERE task_id=? AND status='queued'",
          id,
        );
      this.host.db.saveTask({
        ...current,
        approval_gate: undefined,
        stage: target,
        status: target === 6 ? "ready_for_review" : "queued",
        ...(target === 6 && !taskVerification(this.host.db, id).canReview
          ? { status: "reviewed_with_gaps" as const }
          : {}),
        ...(target === 6
          ? {
              final_review_verdict: taskVerification(this.host.db, id).canReview
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
    this.host.changed(id);
    if (target < 6) void this.host.drain();
    return this.host.db.task(id);
  };
  acceptDraft = async (id: string, runId: string) => {
    this.host.assertAvailable();
    const task = this.host.db.task(id);
    const runs = this.host.db.all<{
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
      !["pipeline", "Antigravity Plan", "Codex Plan Refinement"].includes(run.purpose) ||
      runs.at(-1)?.id !== runId ||
      (task.approval_gate && task.status === "awaiting_approval")
    )
      throw new AdeError(
        "invalid_state",
        "Only the latest unfinished planning run can supply a draft.",
      );
    if (this.state.interactive.has(id) || this.state.taskMaintenance.has(id))
      throw new AdeError("busy", "Close task activity before using a planning draft.");
    const stored = this.host.db.all<{ id: string; content: string }>(
      "SELECT id,content FROM task_artifacts WHERE task_id=? AND kind=? ORDER BY created_at DESC LIMIT 1",
      id,
      `draft:${runId}`,
    )[0];
    const draft = stored
      ? this.host.db.records.decode({
          table: "task_artifacts",
          id: stored.id,
          column: "content",
          source: stored.content,
        })
      : null;
    let plan: unknown = draft?.plan;
    if (!plan) {
      const stream = new StreamedPlan(run.stage);
      for (const event of this.host.db.all<{ id: number; data: string }>(
        "SELECT id,data FROM agent_events WHERE task_id=? AND run_id=? AND kind='message' ORDER BY id",
        id,
        runId,
      ))
        plan =
          stream.observe(
            this.host.db.records.decode({
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
    const active = this.state.active.get(id);
    if (active) {
      active.controller.abort();
      await active.promise;
    }
    if (!["failed", "cancelled", "interrupted"].includes(this.host.db.task(id).status))
      throw new AdeError(
        "invalid_state",
        "The planning stage finished or changed. Review its current result instead.",
      );
    await this.host.git.assertTask(task);
    if (typeof draft?.source_hash === "string" && draft.source_hash.startsWith("issue-v2:")) {
      if (draft.source_hash !== (await this.host.git.fingerprint(task)))
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
    this.host.db.run(
      "DELETE FROM task_artifacts WHERE task_id=? AND stage>=? AND kind='plan'",
      id,
      run.stage,
    );
    this.host.db.run(
      "INSERT INTO task_artifacts VALUES(?,?,?,'plan',?,?)",
      randomUUID(),
      id,
      run.stage,
      JSON.stringify(result),
      now(),
    );
    this.host.db.saveTask({
      ...task,
      stage: run.stage + 1,
      status: "awaiting_approval",
      approval_gate: run.stage === 1 ? "antigravity_plan" : "codex_plan",
      error: null,
      updated_at: now(),
    });
    this.host.changed(id);
    return this.host.db.task(id);
  };
  followUp = (
    id: string,
    content: string,
    configuration?: Task["followup_config"],
    saveOnly = false,
    requestId: string = randomUUID(),
    sendSaved = false,
  ) => {
    const t = this.host.db.task(id);
    if (t.status === "preserved" || (t.workflow_version === 1 && !t.workflow_start && !saveOnly))
      throw new AdeError(
        "workflow_not_started",
        "Ask a read-only question or choose Start workflow before requesting code changes.",
      );
    if (!content.trim() || content.length > 32000)
      throw new AdeError("invalid_state", "Provide an instruction of 1–32000 characters.");
    const existing = this.host.db.all<{
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
        (existing.configuration !== (configuration ? JSON.stringify(configuration) : null) &&
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
        this.state.interactive.has(id) ||
        this.state.maintenance ||
        this.state.taskMaintenance.has(id) ||
        this.host.db.repository(t.repo_id).connected === false
          ? "draft"
          : this.host.isExecuting(id)
            ? "queued"
            : "delivered",
    };
    const disposition = this.host.db.transaction(() => {
      if (existing)
        this.host.db.run(
          "UPDATE task_messages SET status=?,configuration=? WHERE id=? AND task_id=?",
          message.status,
          configuration ? JSON.stringify(configuration) : null,
          message.id,
          id,
        );
      else
        this.host.db.run(
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
      const target = continuationStage(this.host.db, t);
      this.host.db.run("DELETE FROM task_artifacts WHERE task_id=? AND stage>=?", id, target);
      this.host.db.saveTask({
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
    this.host.changed(id);
    if (message.status === "delivered") void this.host.drain();
    return { message, disposition };
  };
  sendSavedMessage = (id: string, messageId: string, configuration?: Task["followup_config"]) => {
    const message = this.host.db.all<{
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
        ? this.host.db.records.decode(
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
}
