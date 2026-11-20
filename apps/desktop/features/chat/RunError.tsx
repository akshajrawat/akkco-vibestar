import type { Run } from "../../lib/types";
import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "../../components/ui/button";

export const conversationError = (error: string) => {
  if (error.startsWith("Choose a model before sending")) {
    return "Choose a model before sending a message.";
  }

  const effort =
    error.match(/does not support ['"]([^'"]+)['"] effort/i) ||
    error.match(/--effort.*?not supported/i);

  if (effort) {
    const level = effort[1] || error.match(/--effort\\?['"]?\s+\\?['"]?(\w+)/)?.[1];
    return level
      ? `This model doesn't support ${level[0].toUpperCase()}${level.slice(1)} reasoning.`
      : "This model doesn't support that reasoning level.";
  }

  if (/model .*not available|invalid model/i.test(error)) {
    return "This model is unavailable. Choose another model.";
  }

  if (/authentication|sign in|connect .*providers/i.test(error)) {
    return "Connect your AI provider in Settings to continue.";
  }

  if (/thread.*(not found|changed|different)|native thread/i.test(error)) {
    return "AI context couldn't be resumed. Reset AI context to continue.";
  }

  if (/cancelled|stopped|interrupt/i.test(error)) {
    return "Response stopped.";
  }

  return "The response couldn't finish. Review the details and try again.";
};

export const RunError = ({
  error,
  run,
  stage = run?.stage ?? 0,
  retry,
  logs,
  blocked = false,
  conversation = false,
}: {
  error: string;
  run?: Run;
  stage?: number;
  retry?: () => void;
  logs?: () => void;
  blocked?: boolean;
  conversation?: boolean;
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
          : "Viber";

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

  if (dismissed === identity) {
    return null;
  }

  return (
    <section
      className={`flex items-baseline flex-wrap gap-[8px_16px] flex-none px-5 py-2 border-b border-b-border text-[12px] wrap-anywhere ${cancelled || blocked ? "run-error-cancelled" : "run-error-failed"}`}
      aria-label={cancelled ? "Cancelled run" : "Run failure"}
    >
      <div className="flex items-baseline flex-wrap gap-2 min-w-0">
        <span className={cancelled || blocked ? "warning" : "failure"} aria-hidden="true">
          {cancelled || blocked ? "●" : "×"}
        </span>

        <strong>
          {conversation
            ? conversationError(error)
            : validation
              ? "Verification needs attention"
              : cancelled
                ? "Run cancelled"
                : `${provider} ${stageName} failed`}
        </strong>

        {!conversation && (
          <span className="subtle">
            {validation
              ? error
              : cancelled
                ? `${provider} ${stageName} was stopped.`
                : "This stage couldn't finish. Review the technical details before retrying."}
          </span>
        )}
      </div>

      {retry && !cancelled && (
        <Button size="sm" onClick={retry}>
          Retry
        </Button>
      )}

      <details className="run-error-details min-w-0 ml-auto [&[open]]:basis-full">
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
