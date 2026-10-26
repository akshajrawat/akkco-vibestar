import { useState } from "react";

import { useDialogFocus } from "../../../hooks/useDialogFocus";
import { containDialogFocus } from "../../../lib/keyboard";
import { Button } from "../../../components/ui/button";
import { rpc, errorMessage } from "../../../lib/api";
import type { RepairPublication } from "./types";

export const PublicationDialog = ({
  publication,
  close,
  refresh,
}: {
  publication: RepairPublication;
  close: () => void;
  refresh: () => Promise<void>;
}) => {
  const [plan, setPlan] = useState(publication);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialog = useDialogFocus();

  const action = async (operation: "commit" | "push" | "keep") => {
    setBusy(true);
    setError("");
    try {
      if (operation === "keep") {
        await rpc("repair.keepLocal", { id: plan.repair_id });
        await refresh();
        close();
        return;
      } else if (operation === "commit") {
        await rpc("repair.commit", {
          id: plan.repair_id,
          expected_hash: plan.fingerprint,
          message,
          confirmed: true,
        });

        setPlan(
          await rpc<RepairPublication>("repair.preparePublication", {
            id: plan.repair_id,
          }),
        );
      } else {
        const result = await rpc<RepairPublication>("repair.publish", {
          id: plan.repair_id,
          publication_id: plan.id,
          confirmed: true,
        });

        setPlan(result);
        if (result.outcome === "published") close();
        else
          setError(
            result.error ||
              `Publication ${result.outcome.replaceAll("_", " ")}. Review history before retrying.`,
          );
      }

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
        className="modal publication-dialog"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Confirm PR publication"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) close();
          containDialogFocus(event);
        }}
      >
        <div className="modal-heading">
          <h2>Prepare existing PR update</h2>
          <Button variant="ghost" disabled={busy} aria-label="Close publication" onClick={close}>
            ×
          </Button>
        </div>

        <dl className="repository-facts">
          <dt>Pull request</dt>
          <dd>{plan.pr_url.replace("https://github.com/", "").replace("/pull/", " #")}</dd>
          <dt>Destination fork</dt>
          <dd>
            <strong>{plan.destination.repository}</strong>
          </dd>
          <dt>Branch</dt>
          <dd>
            <code>{plan.destination.branch}</code>
          </dd>
          <dt>Expected remote head</dt>
          <dd>
            <code>{plan.expected_remote_head}</code>
          </dd>
          <dt>Prepared local head</dt>
          <dd>
            <code>{plan.local_head}</code>
          </dd>
          <dt>Upstream base</dt>
          <dd>
            {plan.upstream_base.branch} · <code>{plan.upstream_base.sha}</code>
          </dd>
          <dt>Changes</dt>
          <dd>
            {plan.changes.files} files · <span className="success">+{plan.changes.additions}</span>{" "}
            / <span className="failure">−{plan.changes.deletions}</span>
          </dd>
          <dt>Validation evidence</dt>
          <dd>
            {plan.validation.observed_passed} observed commands passed ·{" "}
            {plan.validation.observed_failed} failed · {plan.validation.reported_blocked} checks
            reported blocked/not run
          </dd>
          <dt>Approved by</dt>
          <dd>
            @{plan.confirmation.viewer} · {new Date(plan.confirmation.approved_at).toLocaleString()}
          </dd>
        </dl>

        <details>
          <summary>Local commits ({plan.commits.length})</summary>
          {plan.commits.map((commit) => (
            <p key={commit.sha}>
              <code>{commit.sha.slice(0, 12)}</code> {commit.subject}
            </p>
          ))}
        </details>

        {plan.dirty && (
          <label>
            Local commit message
            <textarea
              aria-label="Local commit message"
              rows={5}
              disabled={busy}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </label>
        )}

        <p className="subtle">
          {plan.dirty
            ? "Commit the reviewed files locally before confirming publication."
            : "Confirm Push updates this exact existing PR branch through a normal fast-forward push."}
        </p>

        {error && (
          <p className="error-box" role="alert">
            {error}
          </p>
        )}

        <div className="actions">
          <Button variant="secondary" disabled={busy} onClick={() => void action("keep")}>
            Keep Local
          </Button>

          {plan.dirty && (
            <Button disabled={busy || !message.length} onClick={() => void action("commit")}>
              Commit Locally
            </Button>
          )}

          <Button
            disabled={busy || plan.dirty || plan.outcome !== "prepared"}
            onClick={() => void action("push")}
          >
            {busy ? "Preparing…" : "Confirm Push"}
          </Button>
        </div>
      </section>
    </div>
  );
};
