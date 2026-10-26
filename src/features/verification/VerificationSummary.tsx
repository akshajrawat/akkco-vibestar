import type { Detail } from "../../lib/types";
import { detailVerification, verificationRoots } from "../../lib/verification";
import { Button } from "../../components/ui/button";

export const VerificationSummary = ({
  detail,
  inspect,
  retry,
  terminal,
}: {
  detail: Detail;
  inspect?: (id: string) => void;
  retry?: () => void;
  terminal?: () => void;
}) => {
  const verification = detailVerification(detail);
  const roots = verificationRoots(detail);
  const observed = verification.checks.filter(
    (check) =>
      check.kind === "check" && check.outcome === "passed" && check.source !== "provider_reported",
  ).length;
  const reported = verification.checks.filter(
    (check) =>
      check.kind === "check" && check.outcome === "passed" && check.source === "provider_reported",
  ).length;
  const failures = verification.checks.filter(
    (check) => check.required && check.outcome === "failed",
  ).length;
  const gaps = verification.checks.filter(
    (check) => check.required && !["passed", "failed"].includes(check.outcome),
  ).length;
  const groups = [
    ["Failed", verification.checks.filter((check) => check.required && check.outcome === "failed")],
    [
      "Needs verification",
      verification.checks.filter(
        (check) =>
          check.required &&
          ["blocked", "interrupted", "unknown", "not_run"].includes(check.outcome),
      ),
    ],
    ["Passed", verification.checks.filter((check) => check.required && check.outcome === "passed")],
  ] as const;
  return (
    <section className="verification-summary" aria-label="Verification evidence">
      <h2>
        {verification.canReview
          ? "Verification complete"
          : failures
            ? "Checks failed"
            : "Verification incomplete"}
      </h2>
      <p>
        {observed} passed · {failures} failed · {gaps} need verification
      </p>
      {roots[0] && <p>{roots[0].reason}</p>}
      <details>
        <summary>Evidence interpretation</summary>
        <p
          className={
            verification.outcome === "failed"
              ? "failure"
              : verification.outcome === "passed" && reported === 0
                ? "success"
                : "warning"
          }
        >
          {failures
            ? `${failures} required checks failed.`
            : gaps
              ? `${gaps} required checks remain unverified.`
              : verification.outcome === "passed"
                ? observed
                  ? "Recorded checks passed. Coverage is limited to the evidence below."
                  : "Provider reports checks passed; no observed check evidence."
                : "Verification outcome unknown. No successful check evidence is available."}
        </p>
        <p className="subtle">
          {observed} observed passes · {reported} provider-reported passes
        </p>
        <small className="subtle">
          Required blocked, interrupted, not-run and unknown checks remain unverified.{" "}
          {verification.canReview
            ? "Required checks are satisfied. Optional unexecuted checks remain recorded below."
            : verification.canReviewWithGaps
              ? "Independent review can start after explicit approval and acknowledgment of environmental gaps."
              : "Resolve failures and ambiguous evidence before independent review."}
        </small>
        <details>
          <summary>Evaluation details</summary>
          <p>{verification.summary}</p>
        </details>
      </details>
      {roots.length > 0 && (
        <div className="verification-blockers" aria-label="Root blockers">
          {roots.map((root, index) => (
            <article key={index}>
              <strong>{root.title}</strong>
              <p>{root.reason}</p>
              <small>
                {root.source.replaceAll("_", " ")} · {root.checks.length} unresolved item
                {root.checks.length === 1 ? "" : "s"}
              </small>
              <details>
                <summary>Affected checks and recovery</summary>
                <ul>
                  {root.checks.map((check, index) => (
                    <li key={index}>{check.name}</li>
                  ))}
                </ul>
                <p>
                  Inspect the original command. Use an already installed toolchain when available,
                  then explicitly rerun the missing checks in a supported environment.
                </p>
              </details>
            </article>
          ))}
        </div>
      )}
      {groups
        .filter(([, checks]) => checks.length)
        .map(([label, checks]) => (
          <details className="verification-group" key={label} open={label === "Failed"}>
            <summary>
              {label} <span>{checks.length}</span>
            </summary>
            <ul>
              {checks.map((check, index) => (
                <li key={index}>
                  <strong
                    className={
                      check.outcome === "passed"
                        ? "success"
                        : check.outcome === "failed"
                          ? "failure"
                          : "warning"
                    }
                  >
                    {check.name} ·{" "}
                    {check.optionalReason && check.outcome !== "passed"
                      ? "skipped (optional)"
                      : check.outcome.replaceAll("_", " ")}
                  </strong>
                  <small>
                    {check.source.replaceAll("_", " ")}
                    {check.legacy ? " · legacy classification" : ""} ·{" "}
                    {check.required ? "required" : "additional evidence"}
                  </small>
                  {check.reportedOutcome && check.reportedOutcome !== check.outcome && (
                    <p className="warning">
                      Provider reported {check.reportedOutcome.replaceAll("_", " ")}; recorded
                      command evidence takes precedence.
                    </p>
                  )}
                  {check.prerequisite && <p>Prerequisite: {check.prerequisite}</p>}
                  {check.priorFailure && (
                    <p className="warning">
                      A prior failure still needs an observed passing repair rerun.
                    </p>
                  )}
                  {check.outcome !== "passed" && <p>{check.detail}</p>}
                  {check.optionalReason && <p>{check.optionalReason}</p>}
                  {check.commandId && inspect && (
                    <Button size="sm" variant="ghost" onClick={() => inspect(check.commandId!)}>
                      Inspect exact command
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </details>
        ))}
      {verification.checks.some((check) => !check.required) && (
        <details>
          <summary>Optional evidence</summary>
          <ul>
            {verification.checks
              .filter((check) => !check.required)
              .map((check, index) => (
                <li key={index}>
                  <strong>
                    {check.name} ·{" "}
                    {check.optionalReason && !["passed", "failed"].includes(check.outcome)
                      ? "skipped (optional)"
                      : check.outcome.replaceAll("_", " ")}
                  </strong>
                  <p>{check.optionalReason || check.detail}</p>
                  <small>Recorded outcome: {check.outcome.replaceAll("_", " ")}</small>
                </li>
              ))}
          </ul>
        </details>
      )}
      <div className="actions">
        {retry && (
          <Button size="sm" onClick={retry}>
            Recheck saved evidence
          </Button>
        )}
        {terminal && (
          <Button size="sm" variant="ghost" onClick={terminal}>
            Diagnose in terminal
          </Button>
        )}
      </div>
      {retry && (
        <small className="subtle">
          Run missing checks using the manual command form, then retry. This rechecks saved evidence
          and diff hygiene without launching an agent. Fixing an implementation defect requires an
          explicit instruction.
        </small>
      )}
    </section>
  );
};
