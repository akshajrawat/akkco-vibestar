import { useState } from "react";
import type { RepairSession } from "../../../backend/review/repair/contracts";
import { rpc, errorMessage } from "../../lib/api";
import { containDialogFocus } from "../../lib/keyboard";
import { useDialogFocus } from "../../lib/useDialogFocus";
import { Button } from "../ui/button";

export const LocalCommitDialog = ({
  session,
  close,
  refresh,
}: {
  session: RepairSession;
  close: () => void;
  refresh: () => Promise<void>;
}) => {
  const [message, setMessage] = useState(
    `Address review feedback for PR #${session.identity.number}`,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialog = useDialogFocus();
  const commit = async () => {
    setBusy(true);
    setError("");
    try {
      const hash = session.approved_hash || session.review_hash;
      if (session.status !== "ready_to_publish")
        await rpc("repair.approveLocal", {
          id: session.id,
          expected_hash: hash,
          confirmed: true,
        });
      await rpc("repair.commit", {
        id: session.id,
        expected_hash: hash,
        message,
        confirmed: true,
      });
      await rpc("repair.keepLocal", { id: session.id });
      await refresh();
      close();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <section
        className="modal compact-modal"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Confirm local repair commit"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) close();
          containDialogFocus(e);
        }}
      >
        <h2>Commit review repair locally</h2>
        <p>
          Approve the reviewed files in this isolated repair branch and keep the
          result local.
        </p>
        <dl className="repository-facts">
          <dt>Worktree</dt>
          <dd>
            <code>{session.workspace.worktree_path}</code>
          </dd>
          <dt>Local branch</dt>
          <dd>
            <code>{session.workspace.branch_name}</code>
          </dd>
        </dl>
        <label>
          Commit message
          <input
            aria-label="Local-only commit message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>
        {error && (
          <p className="error-box" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <Button variant="secondary" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={busy || !message.trim()}
            onClick={() => void commit()}
          >
            {busy ? "Committing…" : "Confirm Local Commit"}
          </Button>
        </div>
      </section>
    </div>
  );
};
