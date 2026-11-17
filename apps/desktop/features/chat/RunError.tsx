import type { Run } from "../../lib/types";
import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "../../components/ui/button";

export const RunError = ({
  error,
  run,
  stage = run?.stage ?? 0,
  retry,
  logs,
  blocked = false,
}: {
  error: string;
  run?: Run;
  stage?: number;
  retry?: () => void;
  logs?: () => void;
  blocked?: boolean;
}) => {
  const identity = `${run?.id || ""}:${stage}:${run?.status || ""}:${error}`;
  const [dismissed, setDismissed] = useState<string>();

  const cancelled =
    run?.status === "cancelled" || (stage !== 4 && /cancelled|stopped|interrupt/i.test(error));

  const validation = stage === 4;

  const provider =
    run?.provider === "antigravity"
      ? "Antigravity"
      : run?.provider === "codex"
        ? "Codex"
        : stage === 0
          ? "Repository"
          : "Task";

  const stageName =
    run?.purpose === "Read-only conversation"
      ? "conversation"
      : run?.purpose === "Code Review Ask AI"
        ? "code review"
        : stage === 5
          ? "final review"
          : stage === 1
            ? "planning"
            : stage === 2
              ? "plan refinement"
              : stage === 3
                ? "implementation"
                : stage === 0
                  ? "preparation"
                  : "validation";

  if (dismissed === identity) return null;
  return (
    <section
      className={`run-error ${cancelled || blocked ? "run-error-cancelled" : "run-error-failed"}`}
      aria-label={cancelled ? "Cancelled run" : "Run failure"}
    >
      <div className="run-error-status">
        <span className={cancelled || blocked ? "warning" : "failure"} aria-hidden="true">
          {cancelled || blocked ? "●" : "×"}
        </span>

        <strong>
          {validation
            ? "Verification needs attention"
            : cancelled
              ? "Run cancelled"
              : `${provider} ${stageName} failed`}
        </strong>

        <span className="subtle">
          {validation
            ? error
            : cancelled
              ? `${provider} ${stageName} was stopped.`
              : "This stage couldn't finish. Review the technical details before retrying."}
        </span>
      </div>

      {retry && !cancelled && (
        <Button size="sm" onClick={retry}>
          Retry
        </Button>
      )}

      <details className="run-error-details">
        <summary>Technical details</summary>
        <p>
          {validation ? (
            "Host validation · no provider process is launched"
          ) : (
            <>
              Provider: {run?.provider || provider} · Stage: {stage} · Exit:{" "}
              {run?.exit_code ?? "unavailable"}
            </>
          )}
        </p>
        {run?.id && <code>Run {run.id}</code>}
        <pre>{error}</pre>
        {logs && (
          <Button size="sm" onClick={logs}>
            Open logs
          </Button>
        )}
      </details>

      <Button
        size="icon"
        variant="ghost"
        aria-label="Dismiss run notice"
        onClick={() => setDismissed(identity)}
      >
        <X size={12} />
      </Button>
    </section>
  );
};
