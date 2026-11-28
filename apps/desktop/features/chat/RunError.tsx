import { CircleAlert } from "lucide-react";

import type { Run } from "../../lib/types";
import { errorMessage } from "../../lib/api";

const conversationError = (error: string) => {
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
    return "AI context couldn't be resumed. Send /clear to start a new thread.";
  }

  return "The response couldn't finish.";
};

export const RunError = ({ error, run }: { error: string; run?: Run }) => {
  const cancelled =
    run?.status === "cancelled" || (run?.stage !== 4 && /cancelled|stopped|interrupt/i.test(error));

  const reason = errorMessage(error).trim();
  const title = cancelled ? "Response stopped." : conversationError(reason);

  return (
    <section
      className="flex flex-none items-start gap-2 text-[12px] wrap-anywhere"
      aria-label={cancelled ? "Cancelled run" : "Run failure"}
    >
      <CircleAlert
        className={`mt-1 ${cancelled ? "text-ink-secondary" : "text-accent-red"}`}
        size={15}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 space-y-1" aria-live="polite">
        <strong className={cancelled ? "text-foreground" : "text-accent-red"}>{title}</strong>
        {reason && reason !== title && (
          <p className="whitespace-pre-wrap text-ink-secondary">{reason}</p>
        )}
      </div>
    </section>
  );
};
