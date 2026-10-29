import { CheckCheck, CircleAlert, LoaderCircle, Square } from "lucide-react";

import type { PRWatchState } from "../../../backend/review/pr/watch-contracts";
import { Button } from "../../components/ui/button";
import { duration } from "../../lib/format";

export const WatchProgress = ({
  watch,
  clock,
  stopping,
  stop,
}: {
  watch: PRWatchState;
  clock: number;
  stopping: boolean;
  stop: () => void;
}) => {
  const running = ["running", "cancelling"].includes(watch.status);
  const reviewing = watch.items.filter((item) => item.status === "review").length;
  const unknown = watch.items.filter((item) => item.status === "unknown").length;
  const waiting = watch.items.filter((item) => item.status === "waiting").length;
  return (
    <section className="pr-batch-progress" aria-label="PR watch progress" role="status">
      <div className="pr-check-summary">
        {running ? (
          <LoaderCircle size={16} className="spinning" />
        ) : watch.status === "completed" ? (
          <CheckCheck size={16} />
        ) : (
          <CircleAlert size={16} />
        )}
        <strong>
          {stopping ? "Stopping PR check…" : running ? "Checking open PRs" : watch.phase}
        </strong>
        {reviewing > 0 && <span className="warning">{reviewing} need review</span>}
        {waiting > 0 && <span className="subtle">{waiting} waiting for reviewers</span>}
        {unknown > 0 && <span className="warning">{unknown} need a closer look</span>}
        {running && (
          <Button
            size="sm"
            variant="ghost"
            aria-label="Stop PR check"
            disabled={stopping}
            onClick={stop}
          >
            <Square size={12} />
            {stopping ? "Stopping…" : "Stop"}
          </Button>
        )}
      </div>
      {running && (
        <p className="pr-current-check">
          {watch.phase} · {duration(watch.started_at, new Date(clock).toISOString())} elapsed
        </p>
      )}
      {watch.error && <p className="warning">{watch.error}</p>}
      {watch.items.length > 0 && (
        <details>
          <summary>Results by pull request</summary>
          {watch.items.map((item) => (
            <p key={item.url}>
              {item.title} · {item.status === "checking" ? "Checking conversation" : item.reason}
            </p>
          ))}
        </details>
      )}
    </section>
  );
};
