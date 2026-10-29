import { useEffect, useState } from "react";

import { rpc, errorMessage } from "../../lib/api";
import type { StorageService } from "../../../backend/storage/service";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { containDialogFocus } from "../../lib/keyboard";
import { Button } from "../../components/ui/button";

export const StorageReset = ({ close, done }: { close: () => void; done: () => Promise<void> }) => {
  const dialog = useDialogFocus();
  const [preview, setPreview] = useState<Awaited<ReturnType<StorageService["previewReset"]>>>();
  const [result, setResult] = useState<Awaited<ReturnType<StorageService["reset"]>>>();
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let alive = true;

    void rpc<typeof preview>("storage.resetPreview", {})
      .then((value) => {
        if (alive) setPreview(value);
      })
      .catch((error) => {
        if (alive) setError(errorMessage(error));
      });

    return () => {
      alive = false;
    };
  }, [revision]);

  const act = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <section
        ref={dialog}
        className="modal verification-recovery-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Reset Local Test Workspace"
        onKeyDown={(event) => {
          containDialogFocus(event);
          if (event.key === "Escape" && !busy) {
            event.stopPropagation();
            close();
          }
        }}
      >
        <h2>Reset Local Test Workspace</h2>
        <p>
          Review the exact task data selected for removal. A validated SQLite backup and metadata
          copy are created before cleanup.
        </p>

        {error && (
          <p role="alert" className="failure">
            {error}
          </p>
        )}

        {result ? (
          <>
            <p>
              {result.removed.length} tasks removed. {result.preserved.length} tasks preserved.
            </p>

            <p>
              Recoverable backup: <code>{result.backup}</code>
            </p>

            {result.preserved.map((task) => (
              <p className="warning" key={task.id}>
                {task.id}: {task.reason}
              </p>
            ))}

            <p>
              Provider connections and source repositories remain available. No agent was started.
            </p>
          </>
        ) : preview ? (
          <>
            <p>
              Data root: <code>{preview.root}</code>
            </p>

            <p>
              {preview.tasks.filter((task) => task.eligible).length} eligible tasks ·{" "}
              {preview.tasks.filter((task) => !task.eligible).length} protected tasks ·{" "}
              {preview.repairs.length} retained repair sessions · {preview.finalizations.length}{" "}
              retained Git records
            </p>

            {preview.tasks.map((task) => (
              <details key={task.id} open={!task.eligible}>
                <summary>
                  {task.eligible ? "Remove" : "Preserve"}: {task.title}
                  {task.archived ? " (archived)" : ""}
                </summary>

                {!task.eligible ? (
                  <p className="warning">{task.reason}</p>
                ) : (
                  <ul>
                    {task.remove.map((path) => (
                      <li key={path}>
                        <code>{path}</code>
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            ))}

            <details>
              <summary>Preserved resources and connections</summary>
              <ul>
                {[...preview.preserved, ...preview.retained].map((resource) => (
                  <li key={resource}>{resource}</li>
                ))}
              </ul>
            </details>

            {preview.blockers.length > 0 && (
              <>
                <p className="warning">Stop active agents and terminals before resetting.</p>
                <ul>
                  {preview.blockers.map((blocker) => (
                    <li key={blocker.id}>{blocker.label}</li>
                  ))}
                </ul>

                <Button
                  disabled={busy || preview.blockers.every((blocker) => !blocker.stoppable)}
                  onClick={() =>
                    void act(async () => {
                      await rpc("storage.stopBlockers", {
                        ids: preview.blockers
                          .filter((blocker) => blocker.stoppable)
                          .map((blocker) => blocker.id),
                      });

                      setRevision((value) => value + 1);
                    })
                  }
                >
                  Stop listed agents and terminals
                </Button>
              </>
            )}

            {preview.sensitive.length > 0 && (
              <p className="warning">
                Resolve pending sensitive Git operations before reset:{" "}
                {preview.sensitive.map((operation) => operation.id).join(", ")}
              </p>
            )}

            <label>
              Type RESET LOCAL TEST WORKSPACE
              <input
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </label>

            <Button
              variant="destructive"
              disabled={
                busy ||
                confirmation !== "RESET LOCAL TEST WORKSPACE" ||
                !!preview.blockers.length ||
                !!preview.sensitive.length ||
                !preview.tasks.some((task) => task.eligible)
              }
              onClick={() =>
                void act(async () => {
                  const value = await rpc<NonNullable<typeof result>>("storage.reset", {
                    confirmed: true,
                    confirmation,
                    preview_token: preview.token,
                  });

                  setResult(value);
                  await done();
                })
              }
            >
              Back up & reset eligible task data
            </Button>

            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setConfirmation("");
                setRevision((value) => value + 1);
              }}
            >
              Refresh preview
            </Button>
          </>
        ) : (
          <p>Inspecting owned local resources…</p>
        )}

        <div className="actions">
          <Button disabled={busy} onClick={close}>
            Close
          </Button>
        </div>
      </section>
    </div>
  );
};
