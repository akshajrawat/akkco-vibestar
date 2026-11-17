import { ChevronRight } from "lucide-react";

import type { Run } from "../../lib/types";
import { duration } from "../../lib/format";

const WorkDuration = ({ run }: { run: Run }) => {
  const running = run.status === "running";
  if (running) return <>Thinking</>;
  if (!running && !run.ended_at) return <>Worked</>;
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
    <details className="work-log" open={(run.status === "running" && hasActivity) || undefined}>
      <summary>
        <WorkDuration run={run} />
        <ChevronRight size={14} />
      </summary>
      <div className="work-log-entries">
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
