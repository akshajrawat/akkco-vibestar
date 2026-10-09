import { useState } from "react";
import { rpc } from "../lib/api";
import { CleanupError } from "./CleanupError";
import { Button } from "./ui/button";
export const TaskCleanup = ({
  id,
  close,
  done,
}: {
  id: string;
  close: () => void;
  done: () => void;
}) => {
  const [options, setOptions] = useState({
    worktree: true,
    logs: true,
    artifacts: true,
    history: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const remove = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await rpc("task.cleanup", { id, ...options, confirmed: true });
      done();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <section
        className="modal compact-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Delete task data"
      >
        <h2>Delete task data</h2>
        <p>
          Choose which Vibestar data to remove. Imported source repositories and
          provider accounts remain. Removed data cannot be recovered.
        </p>
        {(
          [
            ["worktree", "Remove Vibestar worktree and owned branch"],
            ["logs", "Remove raw logs"],
            ["artifacts", "Remove saved plans and artifacts"],
            ["history", "Remove task history, worktree and owned local branch"],
          ] as const
        ).map(([key, label]) => (
          <label className="checkbox-label" key={key}>
            <input
              type="checkbox"
              checked={
                key === "worktree"
                  ? options.worktree || options.history
                  : options[key]
              }
              disabled={key === "worktree" && options.history}
              onChange={(e) =>
                setOptions({ ...options, [key]: e.target.checked })
              }
            />
            {label}
          </label>
        ))}
        {options.history && (
          <p className="subtle">
            Deleting task history also deletes its Vibestar worktree and local
            branch. Other local branches are preserved.
          </p>
        )}
        {!!error && (
          <CleanupError
            error={error}
            taskId={id}
            title="Can't delete task data right now"
            retry={() => void remove()}
            busy={busy}
          />
        )}
        <div className="actions">
          <Button disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={busy || !Object.values(options).some(Boolean)}
            variant="destructive"
            onClick={() => void remove()}
          >
            {busy ? "Removing…" : "Delete selected data"}
          </Button>
        </div>
      </section>
    </div>
  );
};
