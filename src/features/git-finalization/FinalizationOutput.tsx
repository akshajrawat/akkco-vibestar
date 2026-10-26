import { Button } from "../../components/ui/button";
import { errorMessage, rpc } from "../../lib/api";
import { duration } from "../../lib/format";
import type { FinalizationController, GitFinalizationProps } from "./useGitFinalization";

/** Renders the output portion without owning operation authority or duplicating wizard state. */
export const FinalizationOutput = ({
  controller,
  snapshot,
  task,
}: {
  controller: Pick<
    FinalizationController,
    | "busy"
    | "executing"
    | "operationStarted"
    | "setError"
    | "detail"
    | "setBeforeEvent"
    | "beforeEvent"
    | "record"
    | "locked"
    | "setRecord"
    | "setSelection"
    | "setMessage"
    | "setPreset"
    | "setConfirmPush"
    | "setConfirmMessage"
    | "confirmRemoval"
    | "unresolved"
    | "setConfirmRemoval"
    | "setBusy"
    | "setDetail"
    | "load"
    | "setNotice"
  >;
  snapshot: NonNullable<FinalizationController["snapshot"]>;
} & Pick<GitFinalizationProps, "task">) => {
  const {
    busy,
    executing,
    operationStarted,
    setError,
    detail,
    setBeforeEvent,
    beforeEvent,
    record,
    locked,
    setRecord,
    setSelection,
    setMessage,
    setPreset,
    setConfirmPush,
    setConfirmMessage,
    confirmRemoval,
    unresolved,
    setConfirmRemoval,
    setBusy,
    setDetail,
    load,
    setNotice,
  } = controller;

  return (
    <section className="git-operation-panel" aria-label="Git operation output">
      <header>
        <h3>Operation output</h3>
        {busy && (
          <span role="status">
            {busy}
            {executing && operationStarted ? ` · ${duration(operationStarted)}` : ""}
          </span>
        )}

        {(executing || (!busy && snapshot.active)) && (
          <Button
            size="sm"
            variant="destructive"
            onClick={() =>
              void rpc("git.cancel", { id: task.id }).catch((error) =>
                setError(errorMessage(error)),
              )
            }
          >
            Cancel Git operation
          </Button>
        )}
      </header>

      <details className="git-operation-log">
        <summary>Saved operation log and recovery</summary>
        {detail?.events.length ? (
          <>
            <ol>
              {detail.events
                .filter(
                  (event) =>
                    !event.phase.startsWith("git ") && !/(?:stdout|stderr)$/.test(event.phase),
                )
                .map((event) => (
                  <li key={event.id}>
                    <strong>{event.phase}</strong>
                    {event.exit_code !== null && <small> · exit {event.exit_code}</small>}
                  </li>
                ))}
            </ol>

            <details>
              <summary>Exact redacted stdout / stderr</summary>
              <div className="actions">
                <Button
                  size="sm"
                  disabled={!detail.events_older}
                  onClick={() => setBeforeEvent(detail.events[0]?.id)}
                >
                  Earlier output
                </Button>

                <Button size="sm" disabled={!beforeEvent} onClick={() => setBeforeEvent(undefined)}>
                  Latest output
                </Button>

                <small>
                  Up to 200 saved events per page. Oversized events show an explicit truncation
                  marker.
                </small>
              </div>

              <pre>
                {detail.events
                  .map(
                    (event) =>
                      `${event.timestamp} ${event.phase}${event.exit_code === null ? "" : ` [exit ${event.exit_code}]`}\n${event.output}`,
                  )
                  .join("\n")}
              </pre>
            </details>
          </>
        ) : (
          <p className="muted">
            Real Git output and exit codes appear here when an operation runs.
          </p>
        )}

        {!!snapshot.history.length && (
          <label>
            Saved operation history
            <select
              aria-label="Saved Git operation history"
              value={record?.id || ""}
              disabled={locked}
              onChange={(event) => {
                const item = snapshot.history.find((item) => item.id === event.target.value);
                setRecord(item);
                if (item) {
                  setSelection(item.paths);
                  setMessage(item.message || "");
                  setPreset(item.preset);
                }

                setConfirmPush(false);
                setConfirmMessage(false);
              }}
            >
              <option value="">New selection</option>
              {snapshot.history.map((item) => (
                <option key={item.id} value={item.id}>
                  {new Date(item.created_at).toLocaleString()} ·{" "}
                  {(item.id === record?.id ? record.status : item.status).replaceAll("_", " ")} ·{" "}
                  {item.paths.length} paths
                </option>
              ))}
            </select>
          </label>
        )}

        {record && (
          <details className="git-remove-preview">
            <summary>Remove this review preview</summary>
            <p className="muted">
              This removes the isolated review worktree and its saved operation history. Your task
              branch and local commit are retained.
            </p>

            <label className="inline-check">
              <input
                type="checkbox"
                checked={confirmRemoval}
                disabled={locked || !!unresolved}
                onChange={(event) => setConfirmRemoval(event.target.checked)}
              />
              Remove this owned preview and its saved history.
            </label>

            <Button
              variant="destructive"
              size="sm"
              disabled={locked || !!unresolved || !confirmRemoval}
              onClick={async () => {
                setBusy("Removing owned review preview…");
                setError("");
                try {
                  await rpc("git.remove", {
                    id: task.id,
                    operation_id: record.id,
                    confirmed: true,
                  });

                  setRecord(undefined);
                  setDetail(undefined);
                  setConfirmRemoval(false);
                  await load();

                  setNotice(
                    "Review preview removed. The task branch and local commit are retained.",
                  );
                } catch (error) {
                  setError(errorMessage(error));
                } finally {
                  setBusy("");
                }
              }}
            >
              Remove review preview and history
            </Button>
          </details>
        )}
      </details>
    </section>
  );
};
