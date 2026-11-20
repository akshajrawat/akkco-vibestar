import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { rpc, errorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { CleanupError } from "../../components/shared/CleanupError";
import type { StorageInfo } from "../../../core/storage/contracts";

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
  const [info, setInfo] = useState<StorageInfo>();
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
        if (alive) {
          setInfo(r);
        }
      })
      .catch((e) => {
        if (alive) {
          setError(errorMessage(e));
        }
      });

    return () => {
      alive = false;
    };
  }, [revision, refreshKey]);

  const execute = async () => {
    if (!confirmation) {
      return;
    }

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
    <section className="settings-section p-[8px_0_24px] storage-page">
      <div className="settings-section-header flex items-center justify-between m-[28px_0_14px_20px]">
        <h2>Storage</h2>
        <button
          type="button"
          className="ghost-action-button inline-flex items-center gap-1.5 [border:0] px-2.5 py-1.5 text-[12px] font-medium [transition:background_var(--motion-fast),_color_var(--motion-fast)] disabled:opacity-50 focus-visible:[outline:1px_solid_var(--focus-ring)] focus-visible:outline-offset-[2px]"
          disabled={busy}
          onClick={() => setRevision((v) => v + 1)}
          aria-label="Refresh sizes"
        >
          <RefreshCw size={13} className={busy ? "spinning" : ""} aria-hidden="true" />
          <span>Refresh sizes</span>
        </button>
      </div>
      {error && (
        <p className="error-box px-3 py-2 mx-0 my-2 text-[12px] whitespace-pre-wrap wrap-anywhere">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice px-3 py-2 mx-0 my-2 text-[12px] whitespace-pre-wrap wrap-anywhere">
          {notice}
        </p>
      )}

      <div className="settings-card storage-card px-4 py-0 border border-border-subtle mb-5">
        <div className="storage-row flex items-center justify-between gap-4 px-0 py-3.5 text-[13px] text-foreground">
          <span className="storage-label text-ink-secondary">Data root</span>
          <code className="storage-value [font-variant-numeric:tabular-nums] font-medium">
            {info?.root || "Measuring…"}
          </code>
        </div>
        {info &&
          [
            ["Database", info.database],
            ["Repositories", info.sizes.repos],
            ["Viber worktrees", info.sizes.worktrees],
            ["Managed Viber files", info.sizes.workspaces],
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
              <div
                key={label}
                className={`storage-row flex items-center justify-between gap-4 px-0 py-3.5 text-[13px] text-foreground${isTotal ? " storage-total-row font-semibold" : ""}`}
              >
                <span className="storage-label text-ink-secondary">{label}</span>
                <span className="storage-value [font-variant-numeric:tabular-nums] font-medium">
                  {bytes(Number(value))}
                </span>
              </div>
            );
          })}
      </div>

      <div className="storage-actions max-w-[700px]">
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
                "Clear cache, logs, completed session worktrees, and unused managed repositories.",
            });
          }}
        >
          Clear all
        </Button>
      </div>

      {confirmation && (
        <div className="modal-backdrop fixed inset-[var(--titlebar-height)_0_0] flex items-center justify-center z-[50]">
          <section
            className="modal border border-border-strong p-6 max-w-[94vw] max-h-[90%] overflow-auto [box-shadow:0_12px_45px_var(--overlay)] animate-[surface-enter_var(--motion-enter)_ease-out] compact-dialog"
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

            <div className="actions flex gap-1.5">
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
