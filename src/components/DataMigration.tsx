import { useState } from "react";
import { rpc, errorMessage } from "../lib/api";
import { Button } from "./ui/button";
export const DataMigration = ({
  migration,
  refresh,
}: {
  migration: { old_root: string; new_root: string };
  refresh: () => Promise<void>;
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const choose = async (choice: "migrate" | "old" | "fresh") => {
    setBusy(true);
    setError("");
    try {
      await rpc("storage.chooseRoot", { choice });
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
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
        aria-label="Existing Vibestar data"
      >
        <h2>Existing Vibestar data found</h2>
        <code>{migration.old_root}</code>
        <p>
          Migrate your tasks, settings, PR watches and logs to{" "}
          <code>{migration.new_root}</code>. The old data stays intact. Managed
          worktree metadata is repaired and checked before use.
        </p>
        {error && <p className="error-box">{error}</p>}
        <div className="actions">
          <Button
            disabled={busy}
            variant="default"
            onClick={() => void choose("migrate")}
          >
            {busy ? "Preparing data…" : "Migrate"}
          </Button>
          <Button disabled={busy} onClick={() => void choose("old")}>
            Use old location
          </Button>
          <Button disabled={busy} onClick={() => void choose("fresh")}>
            Start fresh
          </Button>
        </div>
      </section>
    </div>
  );
};
