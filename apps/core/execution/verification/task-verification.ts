import type { Database } from "../../storage/database";
import { verificationSummary, type VerificationCommand } from "./verification";

export const taskVerification = (db: Database, id: string) => {
  const implementation = db.all<{ id: string; started_at: string }>(
    "SELECT id,started_at FROM agent_runs WHERE task_id=? AND stage=3 ORDER BY started_at DESC,rowid DESC LIMIT 1",
    id,
  )[0];

  const artifact = db.all<{ id: string; content: string }>(
    "SELECT id,content FROM task_artifacts WHERE task_id=? AND stage=3 AND kind='plan' ORDER BY created_at DESC,rowid DESC LIMIT 1",
    id,
  )[0];

  const report = artifact
    ? db.records.decode({
        table: "task_artifacts",
        id: artifact.id,
        column: "content",
        source: artifact.content,
      })
    : { verification: "missing implementation report" };

  const reviewer = db.all<{ id: string; content: string }>(
    "SELECT id,content FROM task_artifacts WHERE task_id=? AND stage=5 AND kind='plan' ORDER BY created_at DESC,rowid DESC LIMIT 1",
    id,
  )[0];

  const review = reviewer
    ? db.records.decode({
        table: "task_artifacts",
        id: reviewer.id,
        column: "content",
        source: reviewer.content,
      })
    : null;

  const implementationChecks = Array.isArray(report?.verification) ? report.verification : [];
  const reviewChecks = Array.isArray(review?.verification) ? review.verification : [];
  // Reviewer statements cannot replace implementation requirements. Matching
  // observed executions may settle them; new reviewer requirements are additive.
  if (
    reviewChecks.length &&
    (report?.verification === undefined || Array.isArray(report?.verification))
  )
    report.verification = [
      ...implementationChecks.map((original: Record<string, unknown>) => {
        const protectedReview = reviewChecks.find(
          (check: Record<string, unknown>) =>
            check.name === original.name &&
            check.command === original.command &&
            (check.scope === "repository" || check.scope === "issue"),
        );

        return {
          ...original,
          ...(!(original.scope === "repository" || original.scope === "issue") && protectedReview
            ? { scope: protectedReview.scope }
            : {}),
          required:
            original.required === true ||
            reviewChecks.some(
              (check: Record<string, unknown>) =>
                check.name === original.name &&
                check.command === original.command &&
                check.required === true,
            ),
        };
      }),
      ...reviewChecks.filter(
        (check: Record<string, unknown>) =>
          !implementationChecks.some(
            (original: Record<string, unknown>) =>
              original.name === check.name && original.command === check.command,
          ),
      ),
    ];

  const commands = db.all<VerificationCommand>(
    `SELECT id,run_id,command,status,exit_code,stdout,stderr FROM test_runs WHERE task_id=? AND (run_id=? OR (run_id IS NULL AND started_at>=?) OR run_id IN (SELECT id FROM agent_runs WHERE task_id=? AND stage=5 AND purpose IN ('Review','Antigravity Final Review') AND started_at>=?)) ORDER BY started_at,rowid`,
    id,
    implementation?.id || "",
    implementation?.started_at || "9999",
    id,
    implementation?.started_at || "9999",
  );

  const task = db.task(id);

  const history = db
    .all<{ id: string; output: string | null; status: string }>(
      "SELECT id,output,status FROM agent_runs WHERE task_id=? AND (stage=3 OR (stage=5 AND purpose IN ('Review','Antigravity Final Review'))) AND id!=? ORDER BY started_at,rowid",
      id,
      implementation?.id || "",
    )
    .map((run) => ({
      report:
        run.status === "completed" && run.output
          ? db.records.decode({
              table: "agent_runs",
              id: run.id,
              column: "output",
              source: run.output,
            })
          : {},
      commands: db.all<VerificationCommand>(
        "SELECT id,run_id,command,status,exit_code,stdout,stderr FROM test_runs WHERE task_id=? AND run_id=? ORDER BY started_at,rowid",
        id,
        run.id,
      ),
    }));

  return verificationSummary(report, commands, undefined, history, task.verification_policy);
};
