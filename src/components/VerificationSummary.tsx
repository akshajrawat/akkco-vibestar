import type { Detail } from "../lib/types";
import { detailVerification } from "../lib/verification";
import { Button } from "./ui/button";

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
  return (
    <section
      className="verification-summary"
      aria-label="Verification evidence"
    >
      <p
        className={
          verification.outcome === "failed"
            ? "failure"
            : verification.outcome === "passed"
              ? "success"
              : "warning"
        }
      >
        {verification.summary}
      </p>
      <small className="subtle">
        Required blocked, interrupted, not-run and unknown checks remain
        unverified. Review cannot start until they are resolved.
      </small>
      <ul>
        {verification.checks.map((check, index) => (
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
              {check.name} · {check.outcome.replaceAll("_", " ")}
            </strong>
            <small>
              {check.source.replaceAll("_", " ")}
              {check.legacy ? " · legacy classification" : ""} ·{" "}
              {check.required ? "required" : "additional evidence"}
            </small>
            {check.reportedOutcome &&
              check.reportedOutcome !== check.outcome && (
                <p className="warning">
                  Provider reported {check.reportedOutcome.replaceAll("_", " ")}
                  ; recorded command evidence takes precedence.
                </p>
              )}
            {check.prerequisite && <p>Prerequisite: {check.prerequisite}</p>}
            {check.outcome !== "passed" && <p>{check.detail}</p>}
            {check.commandId && inspect && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => inspect(check.commandId!)}
              >
                Inspect exact command
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div className="actions">
        {retry && (
          <Button size="sm" onClick={retry}>
            Retry validation only
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
          Run missing checks using the manual command form, then retry. This
          rechecks saved evidence and diff hygiene without launching an agent.
          Fixing an implementation defect requires an explicit instruction.
        </small>
      )}
    </section>
  );
};
