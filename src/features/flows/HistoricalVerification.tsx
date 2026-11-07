import type { Detail } from "../../lib/types";
import { verificationSummary } from "../../../backend/execution/verification/verification";
import { Button } from "../../components/ui/button";

const savedVerification = (detail: Detail) => {
  if (detail.validation) return detail.validation;
  const implementation = [...detail.runs].reverse().find((run) => run.stage === 3);

  const artifact = [...detail.artifacts]
    .reverse()
    .find((entry) => entry.stage === 3 && entry.kind === "plan");

  let report: unknown;
  try {
    report = artifact ? JSON.parse(artifact.content) : null;
  } catch {
    report = { verification: "invalid" };
  }

  return verificationSummary(
    report,
    detail.tests.filter(
      (command) =>
        implementation &&
        (command.run_id === implementation.id ||
          (!command.run_id && command.started_at >= implementation.started_at)),
    ),
    undefined,
    [],
    detail.task.verification_policy,
  );
};

/** Renders saved evidence only; no historical result grants authority over current files. */
export const HistoricalVerification = ({
  detail,
  inspect,
}: {
  detail: Detail;
  inspect?: (id: string) => void;
}) => {
  const verification = savedVerification(detail);
  const roots = verification.blockers;

  if (!verification.checks.length)
    return (
      <section className="workspace-empty" aria-label="Agent check results">
        <h2>No recorded verification</h2>
        <p>
          Inspect recorded commands below. Process completion and provider reports do not prove that
          all required checks passed.
        </p>
      </section>
    );

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
            : "Some checks could not run"}
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
          Required blocked, interrupted, not-run and unknown checks remain unverified. These saved
          records do not prove the current files or authorize another run.
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
    </section>
  );
};
