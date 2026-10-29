import type { Engine } from "../engine";
import type { ExecutionState } from "./state";

import { createHash } from "node:crypto";
import { AdeError, now, pipelineConfiguration } from "../../domain";
import { CommandExecutions } from "../verification/command-executions";
import { object } from "../providers/contracts";
import { taskVerification } from "../verification/task-verification";
import { missingVerificationChecks } from "../verification/verification-recovery";

/** Binds verification recovery and review authority to retained evidence and current content. */
export class VerificationTransitions {
  constructor(
    private readonly host: Pick<
      Engine,
      | "db"
      | "assertAvailable"
      | "isActive"
      | "git"
      | "withTaskMaintenance"
      | "retry"
      | "manual"
      | "runCommand"
      | "followUp"
    >,
    private readonly state: ExecutionState,
  ) {}

  verificationEvidenceHash = (id: string) =>
    createHash("sha256")
      .update(
        JSON.stringify({
          checks: taskVerification(this.host.db, id).checks,
          commands: this.host.db.all(
            "SELECT id,command,status,exit_code,stdout,stderr FROM test_runs WHERE task_id=? ORDER BY started_at,rowid",
            id,
          ),
          implementation: this.host.db.artifact(id, 3),
        }),
      )
      .digest("hex");

  reviewGapsPreview = async (id: string) => {
    this.host.assertAvailable();
    const task = this.host.db.task(id);
    if (this.host.isActive(id) || this.state.taskMaintenance.has(id))
      throw new AdeError("busy", "Wait for task activity to finish before reviewing gaps.");
    if (
      !(task.stage === 4 && task.status === "verification_blocked") &&
      !(task.status === "awaiting_approval" && task.approval_gate === "implementation")
    )
      throw new AdeError("invalid_state", "Review gaps at the implementation approval boundary.");
    const verification = taskVerification(this.host.db, id);
    return {
      eligible: verification.canReviewWithGaps,
      fingerprint: await this.host.git.fingerprint(task),
      evidence_hash: this.verificationEvidenceHash(id),
      checks: verification.checks.filter((check) => check.required && check.outcome !== "passed"),
    };
  };

  savedReviewVerdict = (id: string) => {
    const review = object(this.host.db.artifact(id, 5));
    const verification = taskVerification(this.host.db, id);
    return review.approval === "changes_requested" ||
      verification.outcome === "failed" ||
      (Array.isArray(review.issues) && review.issues.length > 0) ||
      (Array.isArray(review.implementationConcerns) && review.implementationConcerns.length > 0)
      ? ("changes_requested" as const)
      : review.approval !== "approved"
        ? ("blocked" as const)
        : verification.canReview
          ? ("verified" as const)
          : ("code_approved_incomplete" as const);
  };

  recheckEvidence = async (id: string) => {
    await this.host.withTaskMaintenance(id, async () => {
      new CommandExecutions(this.host.db).recoverToolExits(id);
    });

    const task = this.host.db.task(id);
    if (task.stage < 5 || !task.final_review_hash) return this.host.retry(id, 4);
    return this.host.withTaskMaintenance(id, async () => {
      if (task.final_review_hash !== (await this.host.git.fingerprint(task)))
        throw new AdeError(
          "stale_review",
          "The worktree changed since independent review. Review the changed implementation before accepting it.",
        );

      const output = await this.host.manual(
        id,
        ["git", "diff", "--check", task.base_commit_sha, "--"],
        undefined,
        true,
      );

      if (output.code !== 0)
        throw new AdeError("validation", "git diff --check failed. Inspect Tests.");
      const verdict = this.savedReviewVerdict(id);
      const current = this.host.db.task(id);
      if (current.final_review_hash !== (await this.host.git.fingerprint(current)))
        throw new AdeError(
          "stale_review",
          "The worktree changed during validation. Review the changed implementation before accepting it.",
        );

      const updated = {
        ...current,
        final_review_verdict: verdict,
        status: ["reviewed_with_gaps", "ready_for_review"].includes(current.status)
          ? verdict === "verified"
            ? ("ready_for_review" as const)
            : ("reviewed_with_gaps" as const)
          : current.status,
        updated_at: now(),
      };

      this.host.db.saveTask(updated);
      return updated;
    });
  };

  setVerificationPolicy = async (id: string, policy: "repository" | "extended_browser") => {
    await this.host.withTaskMaintenance(id, async () => {
      const task = this.host.db.task(id);
      if (task.stage < 4)
        throw new AdeError(
          "invalid_state",
          "Wait for implementation before changing verification policy.",
        );
      await this.host.git.assertTask(task);

      this.host.db.transaction(() => {
        this.host.db.saveTask({
          ...this.host.db.task(id),
          verification_policy: policy,
          updated_at: now(),
        });

        this.host.db.run(
          "INSERT INTO task_activity(task_id,kind,data,timestamp) VALUES(?,'verification_policy',?,?)",
          id,
          JSON.stringify({ policy, source: "user" }),
          now(),
        );
      });
    });

    return this.recheckEvidence(id);
  };

  runMissingCheck = async (id: string, command: string) => {
    const task = this.host.db.task(id);

    const candidate = missingVerificationChecks(taskVerification(this.host.db, id), {
      selected: task.verification_environment,
      report: task.browser_environment_report,
    }).find((check) => check.command === command);

    if (!candidate)
      throw new AdeError(
        "invalid_input",
        "Select an executable recorded check with resolved prerequisites. Setup and arbitrary prose are never executed by this action.",
      );
    return this.host.runCommand(id, candidate.argv);
  };

  fixVerification = (id: string, requestId: string) => {
    this.host.assertAvailable();

    const existing = this.host.db.all<{
      task_id: string;
      content: string;
      configuration: string;
    }>("SELECT task_id,content,configuration FROM task_messages WHERE id=?", requestId)[0];

    if (existing) {
      if (existing.task_id !== id)
        throw new AdeError("invalid_input", "Repair request belongs to another task.");
      return { disposition: "already_requested" };
    }

    if (this.host.isActive(id) || this.state.taskMaintenance.has(id))
      throw new AdeError(
        "busy",
        "Wait for task activity to finish before requesting verification fixes.",
      );
    const task = this.host.db.task(id);
    if (task.stage < 4)
      throw new AdeError(
        "invalid_state",
        "Implementation must finish before requesting verification fixes.",
      );
    const evidence = taskVerification(this.host.db, id);
    const settings = task.execution_settings || this.host.db.settings();
    const { provider, ...config } = pipelineConfiguration(settings, 3, task.stage_settings);

    const review = this.host.db.all<{ output: string }>(
      "SELECT output FROM agent_runs WHERE task_id=? AND stage=5 ORDER BY started_at DESC,rowid DESC LIMIT 1",
      id,
    )[0]?.output;

    const context = JSON.stringify({
      verification: evidence,
      review,
      commands: this.host.db.all(
        "SELECT command,status,exit_code,stdout,stderr FROM test_runs WHERE task_id=? ORDER BY started_at,rowid",
        id,
      ),
    });

    this.host.db.run(
      "INSERT INTO task_activity(task_id,kind,data,timestamp) VALUES(?,'verification_repair',?,?)",
      id,
      context,
      now(),
    );

    return this.host.followUp(
      id,
      "Fix the demonstrated implementation failures and rerun affected checks in this original worktree. Read the saved verification repair evidence in TASK CONTEXT. For required checks without an executable recorded command, prepare repeatable test scripts using the project's existing tooling, run feasible checks and report their exact commands, outcomes and prerequisites. Prefer supported check-only npm scripts, node --test, pytest or npx --offline --no-install playwright test. Use stable check names to preserve requirements; never claim unexecuted checks passed. Do not install or download dependencies, browsers or toolchains. Report unavailable prerequisites. One implementation iteration is authorized; further iterations require a new explicit request.",
      {
        provider,
        config,
      },
      false,
      requestId,
    );
  };
}
