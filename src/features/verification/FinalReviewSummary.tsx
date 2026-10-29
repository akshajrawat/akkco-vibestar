import type { Detail } from "../../lib/types";
import { detailVerification } from "../../lib/verification";
import { AgentResponse } from "../chat/AgentResponse";
import { Button } from "../../components/ui/button";
import { planSchemas } from "../../../backend/execution/providers/contracts";
import { ClipboardCheck, LoaderCircle } from "lucide-react";

export const FinalReviewSummary = ({
  detail,
  changes,
  tests,
  fix,
}: {
  detail: Detail;
  changes: () => void;
  tests: () => void;
  fix?: () => void;
}) => {
  const artifact = [...detail.artifacts]
    .reverse()
    .find((entry) => entry.stage === 5 && entry.kind === "plan");

  let value: unknown;
  try {
    value = artifact && JSON.parse(artifact.content);
  } catch {
    /* Preserve invalid reports in Logs. */
  }

  const parsed = planSchemas[5].safeParse(value);
  if (!parsed.success) {
    const running = detail.runs.some((run) => run.stage === 5 && run.status === "running");
    const attempted = detail.runs.some((run) => run.stage === 5);
    return (
      <section className="workspace-empty">
        {running ? <LoaderCircle size={24} className="spinning" /> : <ClipboardCheck size={24} />}
        <h2>
          {running
            ? "Independent review in progress"
            : attempted
              ? "Review needs attention"
              : "Independent review"}
        </h2>
        <p>
          {running
            ? "The reviewer is inspecting the changes and running checks. Its report will appear here."
            : attempted
              ? "The last review did not produce a complete report. Inspect the run details before retrying."
              : "After implementation, approve the review from Workflow. The reviewer will inspect the changes and independently run the applicable checks."}
        </p>
        <Button size="sm" variant="ghost" onClick={changes}>
          Inspect changes
        </Button>
      </section>
    );
  }

  const review = parsed.data;
  const verification = detailVerification(detail);

  const passed = verification.checks.filter(
    (check) => check.kind === "check" && check.outcome === "passed",
  ).length;

  const unverified = verification.checks.filter(
    (check) =>
      check.kind === "check" && check.required && !["passed", "failed"].includes(check.outcome),
  );

  const failed = verification.checks.filter(
    (check) => check.required && check.outcome === "failed",
  ).length;

  const skipped = verification.checks.filter(
    (check) =>
      check.kind === "check" &&
      check.optionalReason &&
      !["passed", "failed"].includes(check.outcome),
  ).length;

  const approved =
    review.approval === "approved" &&
    !failed &&
    !review.issues?.length &&
    !review.implementationConcerns?.length;

  return (
    <section className="final-review-summary" aria-label="Independent review result">
      <strong
        className={
          approved && verification.canReview
            ? "success"
            : failed || review.approval === "changes_requested"
              ? "failure"
              : "warning"
        }
      >
        Code review:{" "}
        {approved
          ? "Approved"
          : review.approval === "changes_requested" || failed
            ? "Changes requested"
            : "Review blocked — insufficient evidence"}
      </strong>

      <p>
        Tests: {passed} passed, {unverified.length} unverified
        {failed ? `, ${failed} failed` : ""}
      </p>

      {unverified.length > 0 && (
        <p className="warning">Unverified: {unverified.map((check) => check.name).join(", ")}</p>
      )}
      {skipped > 0 && <p className="subtle">Optional manual browser checks: {skipped} skipped.</p>}
      <p>
        Next step:{" "}
        {approved
          ? verification.canReview
            ? detail.task.approval_gate
              ? "Manual review and acceptance"
              : "Review changes / open terminal"
            : "Keep reviewed changes locally / additional verification"
          : "Inspect findings and request fixes"}
      </p>

      {review.issues?.map((issue, index) => (
        <article key={index}>
          <strong>
            {issue.severity} · {issue.summary}
          </strong>
          {issue.file && <code>{issue.file}</code>}
          <p>{issue.evidence}</p>
        </article>
      ))}

      <div className="actions">
        <Button size="sm" variant="ghost" onClick={changes}>
          Open Changes
        </Button>

        <Button size="sm" variant="ghost" onClick={tests}>
          Open Checks
        </Button>

        {fix && (
          <Button size="sm" variant="ghost" onClick={fix}>
            Request Codex fixes
          </Button>
        )}
      </div>
      <AgentResponse text={artifact!.content} />
    </section>
  );
};
