import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { z } from "zod";

import {
  AdeError,
  FollowupConfigSchema,
  now,
  parseIssue,
  stageStatus,
  type Task,
} from "../../domain";
import { fetchIssue } from "../../workspace/issue";
import { exists } from "../../workspace/paths";
import { taskRuntime } from "../../workspace/runtime";
import type { AgentRunner } from "../agents/agent-runner";
import { redact } from "../runtime/process";
import { taskVerification } from "../verification/task-verification";
import { ChatResponseSchema, StartWorkflowSchema, TaskChatSchema, chatPrompt } from "../workflow";
import type { Engine } from "../engine";
import type { EngineScheduling } from "./scheduling";
import type { ExecutionState } from "./state";
import type { VerificationTransitions } from "./verification";

/** Coordinates explicit workflow startup, read-only chat and the approved stage sequence. */
export class WorkflowOrchestrator {
  constructor(
    private readonly host: Pick<
      Engine,
      | "assertAvailable"
      | "db"
      | "withTaskMaintenance"
      | "taskRepository"
      | "repositoryIndex"
      | "changed"
      | "cleanupBlockers"
      | "prepareClone"
      | "root"
      | "git"
      | "manual"
    >,
    private readonly state: ExecutionState,
    private readonly runner: AgentRunner,
    private readonly operations: {
      withExecutionSlot: EngineScheduling["withExecutionSlot"];
      verificationEvidenceHash: VerificationTransitions["verificationEvidenceHash"];
      savedReviewVerdict: VerificationTransitions["savedReviewVerdict"];
    },
  ) {}

  startWorkflow = async (input: z.input<typeof StartWorkflowSchema>) => {
    this.host.assertAvailable();
    const p = StartWorkflowSchema.parse(input);
    if (new Set(p.message_ids).size !== p.message_ids.length)
      throw new AdeError("invalid_input", "Select each conversation instruction once.");

    const digest = createHash("sha256")
      .update(JSON.stringify({ ...p, message_ids: [...p.message_ids].sort() }))
      .digest("hex");

    const task = this.host.db.task(p.id);
    if (task.status === "preserved")
      throw new AdeError(
        "invalid_state",
        "This task's history was removed while its files were preserved. Open the retained worktree in your editor.",
      );
    if (task.workflow_start) {
      if (task.workflow_start.request_id !== p.request_id || task.workflow_start.digest !== digest)
        throw new AdeError("invalid_state", "This task's workflow has already been authorized.");
      return Promise.resolve(task);
    }

    const starting = this.state.startingWorkflows.get(p.id);
    if (starting) {
      if (starting.digest !== digest)
        throw new AdeError("busy", "Another workflow start is being validated for this task.");
      return starting.promise;
    }

    if (task.status !== "not_started" || task.archived)
      throw new AdeError(
        "invalid_state",
        "Only an unarchived task whose workflow has not started can start.",
      );

    const promise = this.host
      .withTaskMaintenance(
        p.id,
        async () => {
          const repo = this.host.taskRepository(task.repo_id, parseIssue(task.issue_url));
          const repositoryIdentity = JSON.stringify(repo);
          if (await exists(repo.path)) {
            const verified = await this.host.repositoryIndex.verifyLocal(
              { environment: "wsl", path: repo.path },
              repo.source !== "imported",
            );

            if (
              !verified.remotes.some(
                (remote) =>
                  remote.url === repo.upstream_url ||
                  remote.identity?.toLowerCase() === `${repo.owner}/${repo.name}`.toLowerCase(),
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

          await this.runner.validateWorkflow(task, this.state.repositoryController.signal);
          for (const id of p.message_ids) {
            if (
              !this.host.db.all(
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
          const current = this.host.db.task(task.id);
          if (
            JSON.stringify(this.host.taskRepository(task.repo_id, parseIssue(task.issue_url))) !==
            repositoryIdentity
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

          this.host.db.saveTask(started);
          this.host.changed(task.id);
          return started;
        },
        "Checking workflow startup",
      )
      .finally(() => this.state.startingWorkflows.delete(p.id));

    this.state.startingWorkflows.set(p.id, { digest, promise });
    return promise;
  };

  chat = (input: z.input<typeof TaskChatSchema>) => {
    this.host.assertAvailable();
    const p = TaskChatSchema.parse(input);
    const task = this.host.db.task(p.id);
    if (task.status === "preserved")
      throw new AdeError(
        "invalid_state",
        "This task's conversation history was removed. Its retained worktree can be opened in your editor.",
      );
    this.host.taskRepository(task.repo_id, parseIssue(task.issue_url));

    const existing = this.host.db.all<{
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
      this.host.cleanupBlockers(task.id).length ||
      this.state.active.size >= this.host.db.settings().concurrency
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

    this.host.db.run(
      "INSERT INTO task_messages(id,task_id,role,content,created_at,status,configuration,purpose) VALUES(?,?,?,?,?,?,?,'chat')",
      message.id,
      task.id,
      message.role,
      message.content,
      message.created_at,
      message.status,
      JSON.stringify(p.configuration),
    );

    const prompt = chatPrompt(this.host.db, task, p.content);

    void this.operations
      .withExecutionSlot(
        task.id,
        "Read-only conversation",
        this.state.repositoryController.signal,
        async (signal) => {
          if (!task.worktree_path || task.workspace_checkpoint?.state !== "ready")
            await this.prepareTaskWorkspace(task, signal, "chat_preparation");

          const result = ChatResponseSchema.parse(
            await this.runner.run(
              { ...task, stage: 1 },
              task.execution_settings || this.host.db.settings(),
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

          this.host.db.transaction(() => {
            this.host.db.run(
              "UPDATE task_messages SET status='chat_completed' WHERE id=? AND task_id=?",
              message.id,
              task.id,
            );

            this.host.db.run(
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
        this.host.db.run(
          "UPDATE task_messages SET status=? WHERE id=? AND task_id=?",
          (error instanceof AdeError && error.kind === "cancelled") ||
            (error instanceof Error && error.name === "AbortError")
            ? "chat_cancelled"
            : "chat_failed",
          message.id,
          task.id,
        );

        this.host.db.run(
          "INSERT INTO task_activity(task_id,kind,data,timestamp) VALUES(?,'chat_error',?,?)",
          task.id,
          JSON.stringify({
            message_id: message.id,
            error: redact(String(error)),
          }),
          now(),
        );
      })
      .finally(() => this.host.changed(task.id));

    this.host.changed(task.id);
    return { message, disposition: message.status };
  };

  prepareTaskWorkspace = async (t: Task, signal: AbortSignal, kind = "preparation") => {
    const repo = this.host.db.repository(t.repo_id);
    await this.host.prepareClone(repo, signal);
    const logDir = join(this.host.root, "logs", t.id);
    await mkdir(logDir, { recursive: true, mode: 0o700 });

    await this.host.git.prepare(
      repo,
      t,
      signal,
      (checkpoint) => this.host.db.saveTask(checkpoint),
      async (record) => {
        this.host.db.run(
          "INSERT INTO task_activity(task_id,kind,data,timestamp) VALUES(?,?,?,?)",
          t.id,
          kind,
          JSON.stringify(record),
          now(),
        );

        this.host.changed(t.id);

        await appendFile(join(logDir, "preparation.jsonl"), JSON.stringify(record) + "\n", {
          mode: 0o600,
        });
      },
    );

    this.host.db.saveRepository(repo);
    this.host.db.saveTask(t);
  };

  pipeline = async (t: Task, signal: AbortSignal) => {
    for (; t.stage < 6; t.stage++) {
      if (signal.aborted) throw new AdeError("cancelled", "Task cancelled");
      t.status = stageStatus(t.stage);
      t.updated_at = now();
      t.error = null;
      if (t.stage === 0) t.preparation_timing = { started_at: now(), ended_at: null };
      this.host.db.saveTask(t);
      this.host.changed(t.id);
      if (t.stage === 0) {
        await this.prepareTaskWorkspace(t, signal);
        if (t.preparation_timing) t.preparation_timing.ended_at = now();
        this.host.db.saveTask(t);
      } else if (t.stage <= 3 || t.stage === 5) {
        if (t.stage === 5) {
          const verification = taskVerification(this.host.db, t.id);
          if (
            !verification.canReview &&
            !(
              verification.canReviewWithGaps &&
              t.review_gap_acknowledgment &&
              t.review_gap_acknowledgment.evidence_hash ===
                this.operations.verificationEvidenceHash(t.id) &&
              t.review_gap_acknowledgment.fingerprint === (await this.host.git.fingerprint(t))
            )
          )
            throw new AdeError(
              "verification_blocked",
              "Review requires verified checks or a current explicit acknowledgment of environmental gaps.",
            );
        }

        const runtime = await taskRuntime(
          this.host.db.repository(t.repo_id).path,
          t.worktree_path,
          true,
        );

        t.runtime = {
          python: runtime.python,
          dependencies: runtime.dependencies,
          warnings: runtime.warnings,
        };

        this.host.db.saveTask(t);
        // Refresh authored context at each approved stage, never invoke a model to fetch it.
        if (t.issue.context_fetched_at || t.issue.number === t.issue_number) {
          t.issue = await fetchIssue(parseIssue(t.issue_url), this.host.root, signal);
          this.host.db.saveTask(t);
        }

        await this.runner.run(t, t.execution_settings ?? this.host.db.settings(), signal);
      } else {
        const output = await this.host.manual(
          t.id,
          ["git", "diff", "--check", t.base_commit_sha, "--"],
          signal,
          true,
        );

        if (output.code !== 0)
          throw new AdeError("validation", "git diff --check failed. Inspect Tests.");
        const verification = taskVerification(this.host.db, t.id);
        if (!verification.canReview)
          throw new AdeError(
            verification.outcome === "failed" ? "validation" : "verification_blocked",
            verification.summary,
          );
      }

      if (t.stage === 5) {
        t.final_review_hash = await this.host.git.fingerprint(t);
        t.final_review_verdict = this.operations.savedReviewVerdict(t.id);
      }

      const queued =
        t.stage === 4
          ? []
          : this.host.db.all<{ id: string; configuration: string | null }>(
              "SELECT id,configuration FROM task_messages WHERE task_id=? AND status='queued' ORDER BY created_at,rowid",
              t.id,
            );

      if (queued.length) {
        const message = queued.at(-1)!;
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

        this.host.db.run(
          "UPDATE task_messages SET status='delivered' WHERE task_id=? AND status='queued'",
          t.id,
        );

        if (t.stage >= 3) {
          this.host.db.run("DELETE FROM task_artifacts WHERE task_id=? AND stage>=3", t.id);
          t.final_review_hash = undefined;
          t.final_review_verdict = undefined;
          t.review_gap_acknowledgment = undefined;
          t.stage = 2;
          t.continuation = "implementation";
        } else if (t.stage === 1) {
          this.host.db.run("DELETE FROM task_artifacts WHERE task_id=? AND stage>=1", t.id);
          t.stage = 0;
        } else if (t.stage === 2) {
          this.host.db.run("DELETE FROM task_artifacts WHERE task_id=? AND stage>=2", t.id);
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
        this.host.db.saveTask({
          ...t,
          stage: nextStage,
          approval_gate: approvalGate,
          status: "awaiting_approval",
          updated_at: now(),
        });

        this.host.changed(t.id);
        return;
      }

      this.host.db.saveTask({ ...t, stage: nextStage, approval_gate: undefined });
    }

    t.status = "ready_for_review";
    t.updated_at = now();
    this.host.db.saveTask(t);
  };
}
