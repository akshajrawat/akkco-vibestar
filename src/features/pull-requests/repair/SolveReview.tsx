import { pipelineConfiguration } from "../../../../backend/domain";
import { useState } from "react";

import type { PRAnalysisSession } from "../../../../backend/review/pr/contracts";
import type { Repository, Settings } from "../../../../backend/domain";
import type { RepairSession } from "../../../../backend/review/repair/contracts";
import { rpc, errorMessage } from "../../../lib/api";
import { Button } from "../../../components/ui/button";
import { Select } from "../../../components/ui/Select";
import { AgentResponse } from "../../chat/AgentResponse";
import { ConnectLocalRepository } from "../../repositories/ConnectLocalRepository";
import { useDialogFocus } from "../../../hooks/useDialogFocus";
import { containDialogFocus } from "../../../lib/keyboard";

export const SolveReview = ({
  analysis,
  repositories,
  settings,
  close,
  refresh,
  open,
}: {
  analysis: PRAnalysisSession;
  repositories: Repository[];
  settings: Settings;
  close: () => void;
  refresh: () => Promise<void>;
  open: (id: string) => void;
}) => {
  const actions =
    analysis.report?.actions.filter(
      (a) =>
        ["required_change", "suggested_change", "question"].includes(a.classification) &&
        a.responseState !== "answered",
    ) || [];

  const upstream = analysis.snapshot?.identity?.baseRepository || "";

  const candidates = repositories.filter(
    (r) =>
      r.connected !== false &&
      r.clone_status !== "cloning" &&
      `${r.owner}/${r.name}`.toLowerCase() === upstream.toLowerCase(),
  );

  const [repository, setRepository] = useState(candidates.length === 1 ? candidates[0].id : "");
  const [selected, setSelected] = useState(actions.map((a) => a.id));
  const [instructions, setInstructions] = useState("");
  const [connect, setConnect] = useState(false);
  const [busy, setBusy] = useState(false);
  const [requestId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState("");
  const dialog = useDialogFocus();

  const solve = async () => {
    setBusy(true);
    setError("");
    try {
      const session = await rpc<RepairSession>("repair.create", {
        request_id: requestId,
        job_id: analysis.job_id,
        repository_id: repository,
        analysis_id: analysis.id,
        action_ids: selected,
        instructions,
      });

      await refresh();
      close();
      open(session.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <section
        className="modal solve-review-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Select review items to solve"
        ref={dialog}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) {
            e.stopPropagation();
            close();
          }

          containDialogFocus(e);
        }}
      >
        <div className="modal-heading">
          <h2>Solve review · {actions.length} observations</h2>
          <Button
            variant="ghost"
            aria-label="Close review selection"
            disabled={busy}
            onClick={close}
          >
            ×
          </Button>
        </div>

        <p className="subtle">
          A dedicated repair worktree starts from the verified PR head and integrates its latest
          upstream base. Codex implements your selection, then Antigravity independently reviews it.
        </p>

        <label>
          Local repository
          <Select
            label="Repair repository"
            value={repository}
            searchable
            onChange={setRepository}
            options={[
              { value: "", label: `Select a connected ${upstream} checkout` },
              ...candidates.map((r) => ({
                value: r.id,
                label: `${r.owner}/${r.name}`,
                description: `${r.environment === "windows" ? "Windows" : "WSL"} · ${r.base_branch} · ${r.source === "imported" ? "Connected checkout" : "Managed clone"}`,
              })),
            ]}
          />
        </label>

        {!candidates.length && (
          <div className="actions">
            <Button disabled={busy} onClick={() => setConnect(true)}>
              Connect local repository
            </Button>

            <Button
              disabled={busy || !upstream}
              onClick={async () => {
                setBusy(true);
                try {
                  await rpc("github.clone", { repository: upstream });
                  await refresh();
                } catch (e) {
                  setError(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Create Vibestar-managed clone
            </Button>
          </div>
        )}

        <div className="repair-item-selection">
          {actions.map((item, index) => (
            <article key={item.id}>
              <label>
                <input
                  type="checkbox"
                  aria-label={`Solve review item ${index + 1}`}
                  checked={selected.includes(item.id)}
                  onChange={(e) =>
                    setSelected((items) =>
                      e.target.checked ? [...items, item.id] : items.filter((id) => id !== item.id),
                    )
                  }
                />
                <strong>
                  {index + 1}. {item.classification.replaceAll("_", " ")}
                </strong>{" "}
                · @{item.reviewer}
              </label>
              <AgentResponse text={item.originalText} />
              <p className="subtle">{item.recommendedAction}</p>
              <small>
                Source {item.sourceId} · action {item.id}
              </small>
            </article>
          ))}
        </div>

        <label>
          Additional instructions
          <textarea
            aria-label="Additional repair instructions"
            rows={3}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
        </label>

        <p className="subtle">
          Implementation: {pipelineConfiguration(settings, 3).provider} ·{" "}
          {pipelineConfiguration(settings, 3).model || "CLI default"} ·{" "}
          {pipelineConfiguration(settings, 3).effort}
          <br />
          Review: {pipelineConfiguration(settings, 5).provider} ·{" "}
          {pipelineConfiguration(settings, 5).model || "CLI default"} ·{" "}
          {pipelineConfiguration(settings, 5).effort}
        </p>

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
            disabled={
              busy ||
              !selected.length ||
              !candidates.some((r) => r.id === repository) ||
              !analysis.report?.complete
            }
            onClick={() => void solve()}
          >
            {busy ? "Verifying PR identity…" : "Solve selected items"}
          </Button>
        </div>
      </section>

      {connect && (
        <ConnectLocalRepository
          distro={candidates[0]?.distro || "Linux"}
          close={() => setConnect(false)}
          connected={async () => {
            await refresh();
            setConnect(false);
          }}
        />
      )}
    </div>
  );
};
