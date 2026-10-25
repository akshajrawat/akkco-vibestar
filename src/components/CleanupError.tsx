import { useEffect, useState } from "react";
import type { ActivityBlocker } from "../../backend/domain";
import { rpc, errorMessage } from "../lib/api";
import { Button } from "./ui/button";

export const CleanupError = ({
  error,
  taskId,
  title,
  retry,
  busy,
  canRetry = true,
}: {
  error: unknown;
  taskId?: string;
  title: string;
  retry: () => void;
  busy: boolean;
  canRetry?: boolean;
}) => {
  const [blockers, setBlockers] = useState<ActivityBlocker[]>([]);
  const [stopping, setStopping] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [stopError, setStopError] = useState("");
  useEffect(() => {
    let alive = true;
    void rpc<ActivityBlocker[]>("storage.blockers", { task_id: taskId })
      .then((items) => {
        if (alive) setBlockers(items);
      })
      .catch((failure) => {
        if (alive) setStopError(errorMessage(failure));
      });
    return () => {
      alive = false;
    };
  }, [error, taskId]);
  const stop = async () => {
    setStopping(true);
    setStopError("");
    try {
      setBlockers(
        await rpc<ActivityBlocker[]>("storage.stopBlockers", {
          task_id: taskId,
          ids: blockers.filter((b) => b.stoppable).map((b) => b.id),
        }),
      );
      setStopped(true);
    } catch (failure) {
      setStopError(errorMessage(failure));
    } finally {
      setStopping(false);
    }
  };
  const technical =
    error && typeof error === "object" && "technical" in error
      ? String(error.technical)
      : error instanceof Error
        ? error.stack || error.message
        : String(error);
  const permanent =
    !!error &&
    typeof error === "object" &&
    "kind" in error &&
    [
      "git_dirty",
      "git_unpushed",
      "ownership",
      "isolation",
      "task_dependencies",
      "publication_pending",
      "git_operation",
      "git_index",
    ].includes(String(error.kind));
  return (
    <section
      className={`operation-error ${blockers.length ? "operation-blocked" : ""}`}
      role="alert"
    >
      <strong>{title}</strong>
      {blockers.length ? (
        <>
          <p>Finish or stop these operations before continuing:</p>
          <ul>
            {blockers.map((b) => (
              <li key={b.id}>
                {b.label}
                {!b.stoppable && <small> · wait for completion</small>}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>
          {stopped
            ? canRetry
              ? "Blockers stopped. Try again to finish cleanup."
              : "Blockers stopped. Preview the current task contents before continuing."
            : errorMessage(error)}
        </p>
      )}
      {stopError && <p className="failure">{stopError}</p>}
      <div className="actions">
        {blockers.some((b) => b.stoppable) && (
          <Button
            size="sm"
            disabled={busy || stopping}
            onClick={() => void stop()}
          >
            {stopping ? "Stopping…" : "Stop blockers"}
          </Button>
        )}
        {canRetry && !permanent && (!blockers.length || stopped) && (
          <Button size="sm" disabled={busy || stopping} onClick={retry}>
            Try again
          </Button>
        )}
      </div>
      <details>
        <summary>Technical details</summary>
        <pre>{technical}</pre>
      </details>
    </section>
  );
};
