import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { rpc, errorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { CleanupError } from "../../components/shared/CleanupError";
import type { StorageService } from "../../../backend/storage/service";

const bytes = (value: number) =>
  value >= 1024 ** 3
    ? `${(value / 1024 ** 3).toFixed(2)} GB`
    : value >= 1024 ** 2
      ? `${(value / 1024 ** 2).toFixed(1)} MB`
      : `${(value / 1024).toFixed(1)} KB`;

export const StoragePage = ({
  refresh,
  refreshKey = 0,
}: {
  refresh: () => Promise<void>;
  refreshKey?: number;
}) => {
  const [info, setInfo] = useState<Awaited<ReturnType<StorageService["info"]>>>();
  const [error, setError] = useState("");
  const [cleanupError, setCleanupError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);

  const [confirmation, setConfirmation] = useState<{
    action: () => Promise<void>;
    description: string;
  } | null>(null);

  const [notice, setNotice] = useState("");

  useEffect(() => {
    let alive = true;

    void rpc<typeof info>("storage.info")
      .then((r) => {
        if (alive) setInfo(r);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });

    return () => {
      alive = false;
    };
  }, [revision, refreshKey]);

  const execute = async () => {
    if (!confirmation) return;
    setBusy(true);
    setError("");
    setCleanupError(undefined);
    try {
      await confirmation.action();
      setNotice("Cleanup completed.");
      setConfirmation(null);
      setRevision((v) => v + 1);
      await refresh();
    } catch (e) {
      setCleanupError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section storage-page">
      <div className="settings-section-header">
        <h2>Storage</h2>
        <button
          type="button"
          className="ghost-action-button"
          disabled={busy}
          onClick={() => setRevision((v) => v + 1)}
          aria-label="Refresh sizes"
        >
          <RefreshCw size={13} className={busy ? "spinning" : ""} aria-hidden="true" />
          <span>Refresh sizes</span>
        </button>
      </div>
      {error && <p className="error-box">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <div className="settings-card storage-card">
        <div className="storage-row">
          <span className="storage-label">Data root</span>
          <code className="storage-value">{info?.root || "Measuring…"}</code>
        </div>
        {info &&
          [
            ["Database", info.database],
            ["Repositories", info.sizes.repos],
            ["Task worktrees", info.sizes.worktrees],
            ["Managed task files", info.sizes.workspaces],
            ["Logs", info.sizes.logs],
            ["Artifacts / cache", info.sizes.artifacts + info.sizes.cache],
            [
              "Runtime / other state",
              info.sizes.runtime + info.sizes.telemetry + info.sizes.state - info.database,
            ],
            ["Total", info.total],
          ].map(([label, value]) => {
            const isTotal = label === "Total";
            return (
              <div key={label} className={`storage-row${isTotal ? " storage-total-row" : ""}`}>
                <span className="storage-label">{label}</span>
                <span className="storage-value">{bytes(Number(value))}</span>
              </div>
            );
          })}
      </div>

      <div className="storage-actions">
        <Button
          disabled={busy}
          variant="secondary"
          onClick={() => {
            setCleanupError(undefined);

            setConfirmation({
              action: async () => {
                await rpc("storage.clear", { kind: "cache", confirmed: true });
              },
              description: "Delete Vibestar's temporary analysis workspaces and cache.",
            });
          }}
        >
          Clear cache
        </Button>

        <Button
          disabled={busy}
          variant="secondary"
          onClick={() => {
            setCleanupError(undefined);

            setConfirmation({
              action: async () => {
                await rpc("storage.clear", { kind: "cache", confirmed: true });
                await rpc("storage.clear", { kind: "logs", confirmed: true });
                await rpc("storage.cleanCompleted", { confirmed: true });
                await rpc("storage.removeUnused", { confirmed: true });
              },
              description:
                "Clear cache, logs, completed task worktrees, and unused managed repositories.",
            });
          }}
        >
          Clear all
        </Button>
      </div>

      {confirmation && (
        <div className="modal-backdrop">
          <section
            className="modal compact-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Confirm storage cleanup"
          >
            <h2>Confirm cleanup</h2>
            <p>{confirmation.description}</p>
            {!!cleanupError && (
              <CleanupError
                error={cleanupError}
                title="Can't clean storage right now"
                retry={() => void execute()}
                busy={busy}
              />
            )}

            <div className="actions">
              <Button disabled={busy} onClick={() => setConfirmation(null)}>
                Cancel
              </Button>

              <Button disabled={busy} variant="destructive" onClick={() => void execute()}>
                {busy ? "Cleaning…" : "Confirm"}
              </Button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
};
