import { useEffect, useState } from "react";
import { rpc, errorMessage } from "../../lib/api";
import type { StorageService } from "../../../core/storage/service";
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
        if (alive) {
          setPreview(value);
        }
      })
      .catch((error) => {
        if (alive) {
          setError(errorMessage(error));
        }
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
    <div className="dialog-scrim" onKeyDown={(event) => containDialogFocus(event)}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="storage-reset-title"
        className="dialog-card storage-reset"
        ref={dialog}
      >
        <header>
          <h2 id="storage-reset-title">Reset Local Data</h2>
        </header>

        <p className="warning">
          Resetting creates an SQLite backup before clearing temporary caches, logs, and unowned
          workspaces. Viber profiles, source repositories, and configurations remain preserved.
        </p>

        {error && (
          <p role="alert" className="failure">
            {error}
          </p>
        )}

        {result ? (
          <>
            <p>Data reset complete.</p>
            <p>
              Recoverable backup: <code>{result.backup}</code>
            </p>
            <p>Provider connections, Viber profiles, and source repositories remain available.</p>
          </>
        ) : preview ? (
          <>
            <p>
              Data root: <code>{preview.root}</code>
            </p>

            <p>{preview.sessions.length} active Viber conversations recorded.</p>

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
                <p className="warning">Stop active agents before resetting.</p>
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
                  Stop listed agents
                </Button>
              </>
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
                busy || confirmation !== "RESET LOCAL TEST WORKSPACE" || !!preview.blockers.length
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
              Back up & reset temporary data
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
