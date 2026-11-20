import { ChevronRight } from "lucide-react";

import type { Run } from "../../lib/types";
import { duration } from "../../lib/format";

const WorkDuration = ({ run }: { run: Run }) => {
  const running = run.status === "running";
  if (running) {
    return (
      <span
        className="working-shimmer inline-block text-ink-secondary animate-[working-shine_2s_linear_infinite] [@media(prefers-reduced-motion:reduce)]:animate-[none]"
        role="status"
      >
        Working…
      </span>
    );
  }

  if (!running && !run.ended_at) {
    return <>Worked</>;
  }

  return <>Worked for {duration(run.started_at, run.ended_at)}</>;
};

export const WorkLog = ({
  run,
  children,
  hasActivity,
}: {
  run: Run;
  children: React.ReactNode;
  hasActivity: boolean;
}) => {
  return (
    <details
      className="work-log my-[24px_12px] text-ink-muted text-[14px]"
      open={(run.status === "running" && hasActivity) || undefined}
    >
      <summary>
        <WorkDuration run={run} />
        <ChevronRight size={14} />
      </summary>
      <div className="work-log-entries mt-3">
        {hasActivity ? (
          children
        ) : (
          <p>
            {run.status === "running"
              ? "Waiting for agent activity…"
              : "No additional activity was reported for this response."}
          </p>
        )}
      </div>
    </details>
  );
};
