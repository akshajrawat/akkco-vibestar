import { z } from "zod";

import {
  AdeError,
  FollowupConfigSchema,
  SettingsSchema,
  StageConfigSchema,
  now,
  parseIssue,
} from "../domain";
import {
  BrowserEnvironmentReportSchema,
  VerificationEnvironmentSchema,
} from "../execution/verification/browser/contracts";
import { browserEnvironmentProbe } from "../execution/verification/browser/probe";
import { taskVerification } from "../execution/verification/task-verification";
import { StartWorkflowSchema, TaskChatSchema } from "../execution/workflow";
import { fetchIssue } from "../workspace/issue";
import type { RpcServices } from "./services";
import { idInput } from "./validation";

export const tasksMethods = [
  "task.message.retry",
  "task.message.send",
  "task.configure",
  "task.configureStage",
  "task.browser.configure",
  "task.browser.inspect",
  "task.detail",
  "task.preview",
  "task.create",
  "task.cancel",
  "task.startWorkflow",
  "task.chat",
  "task.retry",
  "task.verification.recheck",
  "task.verification.policy",
  "task.verification.run",
  "task.verification.fix",
  "task.verification.reviewPreview",
  "task.verification.continueReview",
  "task.approve",
  "task.acceptDraft",
  "task.followup",
  "task.complete",
  "task.diff",
  "task.file",
  "task.discard",
  "task.command",
] as const;

/** Validates and dispatches tasks requests through their existing domain services. */
export const callTasks = async (
  services: Pick<RpcServices, "engine" | "terminals">,
  method: string,
  input: unknown,
) => {
  const e = services.engine;
  switch (method) {
    case "task.message.retry": {
      const p = idInput
        .extend({
          message_id: z.string().uuid(),
          content: z.string().min(1).max(32000).optional(),
          request_id: z.string().uuid().optional(),
        })
        .parse(input);

      const message = e.db.all<{
        content: string;
        configuration: string | null;
        status: string;
      }>(
        "SELECT content,configuration,status FROM task_messages WHERE id=? AND task_id=?",
        p.message_id,
        p.id,
      )[0];

      if (!message) throw new AdeError("not_found", "Message not found");
      if (message.status !== "delivered" && (!p.content || p.content === message.content))
        return e.sendSavedMessage(p.id, p.message_id);
      return e.followUp(
        p.id,
        p.content || message.content,
        message.configuration
          ? e.db.records.decode(
              {
                table: "task_messages",
                id: p.message_id,
                column: "configuration",
                source: message.configuration,
              },
              FollowupConfigSchema.parse,
            )
          : undefined,
        false,
        p.request_id,
      );
    }

    case "task.message.send": {
      const p = idInput
        .extend({
          message_id: z.string().uuid(),
          configuration: FollowupConfigSchema.optional(),
        })
        .strict()
        .parse(input);

      return e.sendSavedMessage(p.id, p.message_id, p.configuration);
    }

    case "task.configure": {
      const p = idInput.extend({ settings: SettingsSchema }).parse(input);
      if (e.isActive(p.id))
        throw new AdeError(
          "busy",
          "Stop this task's active run or terminal before changing its models",
        );
      const task = e.db.task(p.id);

      e.db.saveTask({
        ...task,
        execution_settings: p.settings,
        updated_at: now(),
      });

      e.changed(p.id);
      return p.settings;
    }

    case "task.configureStage": {
      const p = idInput
        .extend({
          stage: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(5)]),
          config: StageConfigSchema.strict(),
        })
        .strict()
        .parse(input);

      const task = e.db.task(p.id);
      if (e.cleanupBlockers(p.id).length || task.status === "queued")
        throw new AdeError(
          "busy",
          "Wait for execution and terminals to finish before editing a future stage.",
        );
      if (
        task.stage > p.stage ||
        e.db.all(
          "SELECT id FROM agent_runs WHERE task_id=? AND stage=? AND purpose!='Read-only conversation' LIMIT 1",
          p.id,
          p.stage,
        ).length
      )
        throw new AdeError(
          "invalid_state",
          "Only stages that have never started can change their saved model configuration.",
        );

      e.db.saveTask({
        ...task,
        stage_settings: { ...task.stage_settings, [p.stage]: p.config },
        updated_at: now(),
      });

      e.changed(p.id);
      return p.config;
    }

    case "task.browser.configure": {
      const p = idInput
        .extend({
          environment: VerificationEnvironmentSchema,
          confirmed: z.literal(true),
        })
        .strict()
        .parse(input);

      e.assertAvailable();
      const task = e.db.task(p.id);
      if (e.isActive(p.id) || task.status === "queued")
        throw new AdeError(
          "busy",
          "Wait for this task's run and terminal to stop before changing verification environments.",
        );
      await e.git.assertTask(task);
      const latest = e.db.task(p.id);
      if (e.isActive(p.id) || latest.status === "queued")
        throw new AdeError(
          "busy",
          "This task became active while its verification environment was being checked.",
        );

      e.db.saveTask({
        ...latest,
        verification_environment: p.environment,
        browser_environment_report: undefined,
        updated_at: now(),
      });

      e.changed(p.id);
      return { environment: p.environment };
    }

    case "task.browser.inspect": {
      const p = idInput.strict().parse(input);
      const task = e.db.task(p.id);
      await e.git.assertTask(task);

      const result = await e.runCommand(
        p.id,
        [
          process.execPath,
          "-e",
          browserEnvironmentProbe,
          e.db.task(p.id).verification_environment || "isolated",
        ],
        true,
      );

      if (result.code !== 0)
        throw new AdeError(
          "browser_environment",
          result.stderr || "Browser environment probe failed. Inspect the saved command evidence.",
        );
      const report = BrowserEnvironmentReportSchema.parse(JSON.parse(result.stdout));
      const latest = e.db.task(p.id);
      if ((latest.verification_environment || "isolated") !== report.environment)
        throw new AdeError(
          "stale_environment",
          "The verification environment changed. Inspect it again explicitly.",
        );

      e.db.saveTask({
        ...latest,
        browser_environment_report: report,
        updated_at: now(),
      });

      e.changed(p.id);
      return report;
    }

    case "task.detail": {
      const id = idInput.parse(input).id;
      const detail = e.db.detail(id);
      return {
        ...detail,
        validation: taskVerification(e.db, id),
        task: {
          ...detail.task,
          execution_settings: detail.task.execution_settings ?? e.db.settings(),
        },
        active: e.isActive(id),
        executing: e.isExecuting(id),
      };
    }

    case "task.preview": {
      const p = z
        .object({
          repository_id: z.string().uuid(),
          issue_url: z.string().max(2000),
        })
        .strict()
        .parse(input);

      const reference = parseIssue(p.issue_url);
      const repository = e.taskRepository(p.repository_id, reference);
      const issue = await fetchIssue(reference, e.root);
      return {
        reference,
        issue,
        repository,
      };
    }

    case "task.create": {
      const p = z
        .object({
          request_id: z.string().uuid().optional(),
          repository_id: z.string().uuid(),
          issue_url: z.string(),
          scope_mode: z.enum(["whole_issue", "partial"]).default("partial"),
          claimed_scope: z.string().max(1000).default(""),
          notes: z.string().max(32000).default(""),
          settings: SettingsSchema.optional(),
        })
        .strict()
        .parse(input);

      if (p.scope_mode === "partial" && !p.claimed_scope.trim())
        throw new AdeError("invalid_input", "Claimed scope is required for a partial task");
      return e.createTask(
        p.repository_id,
        p.issue_url,
        p.claimed_scope,
        p.notes,
        p.scope_mode,
        p.settings,
        p.request_id,
      );
    }

    case "task.cancel": {
      const id = idInput.parse(input).id;
      await services.terminals.close(id);
      e.cancel(id);
      return null;
    }

    case "task.startWorkflow":
      return e.startWorkflow(StartWorkflowSchema.parse(input));

    case "task.chat":
      return e.chat(TaskChatSchema.parse(input));

    case "task.retry": {
      const p = idInput
        .extend({
          stage: z.number().int().min(0).max(5).optional(),
          restart: z.boolean().optional(),
        })
        .parse(input);

      return e.retry(p.id, p.stage, p.restart);
    }

    case "task.verification.recheck":
      return e.recheckEvidence(idInput.strict().parse(input).id);

    case "task.verification.policy": {
      const p = idInput
        .extend({
          policy: z.enum(["repository", "extended_browser"]),
          confirmed: z.literal(true),
        })
        .strict()
        .parse(input);

      return e.setVerificationPolicy(p.id, p.policy);
    }

    case "task.verification.run": {
      const p = idInput
        .extend({ command: z.string().min(1).max(16000) })
        .strict()
        .parse(input);

      return e.runMissingCheck(p.id, p.command);
    }

    case "task.verification.fix": {
      const p = idInput.extend({ request_id: z.string().uuid() }).strict().parse(input);
      return e.fixWithCodex(p.id, p.request_id);
    }

    case "task.verification.reviewPreview":
      return e.reviewGapsPreview(idInput.strict().parse(input).id);

    case "task.verification.continueReview": {
      const p = idInput
        .extend({
          artifact_id: z.string().uuid(),
          acknowledge_gaps: z.literal(true),
          fingerprint: z.string().min(1),
          evidence_hash: z.string().min(1),
          instructions: z
            .object({
              disposition: z.enum(["keep_saved", "include_next_stage"]),
              message_ids: z.array(z.string().uuid()).max(1000),
            })
            .strict()
            .optional(),
        })
        .strict()
        .parse(input);

      return e.approveStage(p.id, p.instructions, p.artifact_id, {
        fingerprint: p.fingerprint,
        evidence_hash: p.evidence_hash,
      });
    }

    case "task.approve": {
      const p = idInput
        .extend({
          artifact_id: z.string().uuid().optional(),
          instructions: z
            .object({
              disposition: z.enum(["keep_saved", "include_next_stage"]),
              message_ids: z.array(z.string().uuid()).max(1000),
            })
            .strict()
            .optional(),
        })
        .strict()
        .parse(input);

      return e.approveStage(p.id, p.instructions, p.artifact_id);
    }

    case "task.acceptDraft": {
      const p = idInput.extend({ run_id: z.string().uuid() }).strict().parse(input);
      return e.acceptDraft(p.id, p.run_id);
    }

    case "task.followup": {
      const p = idInput
        .extend({
          content: z.string().max(32000),
          save_only: z.boolean().default(false),
          configuration: FollowupConfigSchema.optional(),
          request_id: z.string().uuid().optional(),
        })
        .parse(input);

      return e.followUp(p.id, p.content, p.configuration, p.save_only, p.request_id);
    }

    case "task.complete": {
      const t = e.db.task(idInput.parse(input).id);
      if (e.isActive(t.id) || t.status !== "ready_for_review")
        throw new AdeError("invalid_state", "Only Ready for Review tasks can be completed");
      if (
        !t.final_review_hash?.startsWith("issue-v2:") ||
        t.final_review_hash !== (await e.git.fingerprint(t))
      )
        throw new AdeError(
          "stale_review",
          "The worktree changed or its final review uses an older integrity method. Retry Antigravity review before completing.",
        );
      const verification = taskVerification(e.db, t.id);
      if (!verification.canReview) throw new AdeError("verification_blocked", verification.summary);
      e.db.saveTask({ ...t, status: "completed", updated_at: now() });
      e.changed(t.id);
      return null;
    }

    case "task.diff":
      return e.git.diff(e.db.task(idInput.parse(input).id));

    case "task.file": {
      const p = idInput
        .extend({
          path: z.string(),
          old_path: z.string().nullable().optional(),
        })
        .parse(input);

      return e.git.file(e.db.task(p.id), p.path, p.old_path);
    }

    case "task.discard": {
      const p = idInput
        .extend({ path: z.string().optional(), confirmed: z.literal(true) })
        .parse(input);

      if (e.isActive(p.id))
        throw new AdeError("invalid_state", "Stop the task before discarding changes");
      await e.git.discard(e.db.task(p.id), p.path);
      e.changed(p.id);
      return null;
    }

    case "task.command": {
      const p = idInput.extend({ argv: z.array(z.string()).min(1).max(100) }).parse(input);
      return e.runCommand(p.id, p.argv);
    }

    default:
      throw new AdeError("invalid_method", `Unknown method: ${method}`);
  }
};
