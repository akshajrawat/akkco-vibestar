import { useEffect, useState } from "react";

import { rpc, errorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { CleanupError } from "../../components/shared/CleanupError";
import type { StorageService } from "../../../backend/storage/service";
import { StorageReset } from "./StorageReset";

const bytes = (value: number) =>
  value >= 1024 ** 3
    ? `${(value / 1024 ** 3).toFixed(2)} GB`
    : value >= 1024 ** 2
      ? `${(value / 1024 ** 2).toFixed(1)} MB`
      : `${(value / 1024).toFixed(1)} KB`;

export const StoragePage = ({ refresh }: { refresh: () => Promise<void> }) => {
  const [info, setInfo] = useState<Awaited<ReturnType<StorageService["info"]>>>();
  const [error, setError] = useState("");
  const [cleanupError, setCleanupError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);

  const [confirmation, setConfirmation] = useState<{
    method: string;
    params: Record<string, unknown>;
    description: string;
  } | null>(null);

  const [reset, setReset] = useState(false);
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
  }, [revision]);

  const execute = async () => {
    if (!confirmation) return;
    setBusy(true);
    setError("");
    setCleanupError(undefined);
    try {
      await rpc(confirmation.method, {
        ...confirmation.params,
        confirmed: true,
      });

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
    <section className="storage-page">
      <div className="page-title">
        <h2>Storage</h2>
        <Button disabled={busy} size="sm" onClick={() => setRevision((v) => v + 1)}>
          Refresh sizes
        </Button>
      </div>
      {error && <p className="error-box">{error}</p>}
      {notice && <p className="notice">{notice}</p>}
      <label>
        Data root<code>{info?.root || "Measuring…"}</code>
      </label>

      {info && (
        <dl className="storage-sizes">
          {[
            ["Database", info.database],
            ["Repositories", info.sizes.repos],
            ["Task worktrees", info.sizes.worktrees],
            ["Logs", info.sizes.logs],
            ["Artifacts / cache", info.sizes.artifacts + info.sizes.cache],
            [
              "Runtime / other state",
              info.sizes.runtime + info.sizes.telemetry + info.sizes.state - info.database,
            ],
            ["Total", info.total],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{bytes(Number(value))}</dd>
            </div>
          ))}
        </dl>
      )}

      <p className="subtle">
        Logical file sizes, measured locally. Imported checkouts stay at their original locations
        and are excluded.
      </p>

      <div className="storage-actions">
        <Button
          disabled={busy}
          onClick={() => void rpc("storage.open").catch((e) => setError(errorMessage(e)))}
        >
          Open data directory
        </Button>

        {[
          [
            "Clear logs",
            "storage.clear",
            { kind: "logs" },
            "Delete Vibestar's raw logs. Conversations, run records and usage remain.",
          ],
          [
            "Clear cache",
            "storage.clear",
            { kind: "cache" },
            "Delete Vibestar's temporary analysis workspaces and cache.",
          ],
          [
            "Clean completed task worktrees",
            "storage.cleanCompleted",
            {},
            "Remove worktrees and owned branches for completed and cancelled tasks. History and logs remain.",
          ],
          [
            "Remove unused managed repositories",
            "storage.removeUnused",
            {},
            "Remove managed clones with no tasks. Imported repositories remain where they are.",
          ],
        ].map(([label, method, params, description]) => (
          <Button
            key={String(method) + String(label)}
            disabled={busy}
            variant="secondary"
            onClick={() => {
              setCleanupError(undefined);

              setConfirmation({
                method: String(method),
                params: params as Record<string, unknown>,
                description: String(description),
              });
            }}
          >
            {String(label)}
          </Button>
        ))}

        <Button variant="destructive" disabled={busy} onClick={() => setReset(true)}>
          Reset Local Test Workspace…
        </Button>
      </div>

      {reset && (
        <StorageReset
          close={() => setReset(false)}
          done={async () => {
            setRevision((value) => value + 1);
            await refresh();
          }}
        />
      )}

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
