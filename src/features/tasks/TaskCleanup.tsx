import { useState } from "react";
import type { TaskDisposalPreview } from "../../../backend/storage/disposal";
import { rpc } from "../../lib/api";
import { CleanupError } from "../../components/shared/CleanupError";
import { Button } from "../../components/ui/button";
import { containDialogFocus } from "../../lib/keyboard";
import { useDialogFocus } from "../../hooks/useDialogFocus";

export const TaskCleanup = ({
  id,
  close,
  done,
}: {
  id: string;
  close: () => void;
  done: () => void;
}) => {
  const [choice, setChoice] = useState<"archive" | "preserve" | "discard">("archive");
  const [preview, setPreview] = useState<TaskDisposalPreview>();
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const dialog = useDialogFocus();
  const perform = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (choice === "archive") {
        await rpc("task.archive", { id, archived: true });
      } else if (choice === "preserve") {
        await rpc("task.disposal.preserve", { id, confirmed: true });
      } else if (!preview) {
        setPreview(await rpc<TaskDisposalPreview>("task.disposal.preview", { id }));
        setAcknowledged(false);
        return;
      } else {
        await rpc("task.disposal.discard", {
          id,
          fingerprint: preview.fingerprint,
          confirmed: true,
          acknowledge_unpublished: acknowledged,
        });
      }
      done();
    } catch (failure) {
      setError(failure);
      setPreview(undefined);
      setAcknowledged(false);
    } finally {
      setBusy(false);
    }
  };
  const dependencies =
    !!preview && (preview.dependencies.finalizations > 0 || preview.dependencies.repairs > 0);
  return (
    <div className="modal-backdrop">
      <section
        ref={dialog}
        className="modal compact-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Manage task"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.stopPropagation();
            close();
          }
          containDialogFocus(event);
        }}
      >
        <h2>{preview ? "Discard task and delete" : "Manage task"}</h2>
        {!preview ? (
          <>
            <p>Choose what to keep. Your imported source checkout stays protected.</p>
            <fieldset disabled={busy} className="task-disposal-choices">
              {(
                [
                  [
                    "archive",
                    "Archive",
                    "Hide the task and keep its conversation, files and branch.",
                  ],
                  [
                    "preserve",
                    "Remove task history, preserve work",
                    "Delete conversation, runs, logs and plans. Keep files, branch and a minimal ownership record.",
                  ],
                  [
                    "discard",
                    "Discard task and delete",
                    "Preview the owned worktree, branch and history that will be permanently removed.",
                  ],
                ] as const
              ).map(([value, title, description]) => (
                <label className="checkbox-label" key={value}>
                  <input
                    type="radio"
                    name="task-disposal"
                    value={value}
                    checked={choice === value}
                    onChange={() => {
                      setChoice(value);
                      setError(undefined);
                    }}
                  />
                  <span>
                    <strong>{title}</strong>
                    <small>{description}</small>
                  </span>
                </label>
              ))}
            </fieldset>
          </>
        ) : (
          <>
            <p>
              <strong>{preview.title}</strong>
              <br />
              {preview.repository} · {preview.branch || "No branch prepared"}
            </p>
            <p className="warning">
              The owned worktree and branch, conversation, plans and run history will be lost.
            </p>
            <p>
              {preview.modified.length} modified · {preview.untracked.length} untracked ·{" "}
              {preview.ignored.length} ignored files
            </p>
            <p>{preview.unpublished_commits} unique commits not known in local remote refs</p>
            <p>Active operation: {preview.active_operation || "None"}</p>
            <p>
              Dependencies: {preview.dependencies.finalizations} Git Finalization ·{" "}
              {preview.dependencies.repairs} PR repair
            </p>
            <details>
              <summary>Files to discard</summary>
              {(
                [
                  ["Modified", preview.modified],
                  ["Untracked", preview.untracked],
                  ["Ignored", preview.ignored],
                ] as const
              ).map(([title, files]) => (
                <section key={title}>
                  <h3>{title}</h3>
                  {files.length ? (
                    <ul>
                      {files.map((file) => (
                        <li key={file}>
                          <code>{file}</code>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="subtle">None</p>
                  )}
                </section>
              ))}
            </details>
            {!!preview.unpublished_commits && (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                I explicitly accept losing these {preview.unpublished_commits} unique unpublished
                commits.
              </label>
            )}
            {dependencies && (
              <p className="error-box">
                Remove dependent finalization previews and repair sessions explicitly before
                discarding.
              </p>
            )}
          </>
        )}
        {!!error && (
          <CleanupError
            error={error}
            taskId={id}
            title="Task choice could not complete"
            retry={() => void perform()}
            busy={busy}
            canRetry={false}
          />
        )}
        {busy && (
          <p role="status">
            {choice === "discard" && !preview
              ? "Verifying ownership and collecting a discard preview…"
              : "Applying your task choice…"}
          </p>
        )}
        <div className="modal-actions">
          {preview && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setPreview(undefined);
                setAcknowledged(false);
              }}
            >
              Back
            </Button>
          )}
          <Button disabled={busy} variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={busy || dependencies || !!(preview?.unpublished_commits && !acknowledged)}
            variant={
              choice === "archive" || (!preview && choice === "discard") ? "default" : "destructive"
            }
            onClick={() => void perform()}
          >
            {busy
              ? "Working…"
              : preview
                ? "Confirm discard and delete"
                : choice === "discard"
                  ? "Preview discard"
                  : choice === "preserve"
                    ? "Remove history and preserve work"
                    : "Archive task"}
          </Button>
        </div>
      </section>
    </div>
  );
};
