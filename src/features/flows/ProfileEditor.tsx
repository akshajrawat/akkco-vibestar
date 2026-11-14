import { useState } from "react";

import { AgentProfileSchema, type AgentProfile } from "../../../backend/flows/contracts";
import { Button } from "../../components/ui/button";
import { rpc, errorMessage } from "../../lib/api";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { DiscardChangesDialog } from "../../components/ui/DiscardChangesDialog";
import { containDialogFocus } from "../../lib/keyboard";

export const ProfileEditor = ({
  profile,
  close,
  saved,
}: {
  profile: AgentProfile;
  close: () => void;
  saved: () => void;
}) => {
  const [draft, setDraft] = useState(profile);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const focus = useDialogFocus(true);
  const execution = draft.execution;
  const [confirmClose, setConfirmClose] = useState(false);

  const requestClose = () => {
    if (busy) return;
    if (JSON.stringify(draft) !== JSON.stringify(profile)) setConfirmClose(true);
    else close();
  };

  const patch = (value: Partial<AgentProfile["execution"]>) =>
    setDraft({ ...draft, execution: { ...execution, ...value } });

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <section
        ref={focus}
        className="modal viber-profile-editor"
        role="dialog"
        aria-modal="true"
        aria-label={profile.revision ? "Edit Viber profile" : "Create Viber profile"}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            requestClose();
          }

          containDialogFocus(event);
        }}
      >
        <div className="modal-heading">
          <h2>{profile.revision ? "Edit Viber profile" : "Create Viber profile"}</h2>
          <Button disabled={busy} onClick={requestClose}>
            Close
          </Button>
        </div>
        <p className="subtle">
          Saved changes apply to future runs. Started runs keep their captured settings.
        </p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            try {
              const next = AgentProfileSchema.parse({ ...draft, revision: profile.revision + 1 });

              await rpc("profile.save", {
                profile: next,
                expected_revision: profile.revision || null,
              });

              saved();
              close();
            } catch (reason) {
              setError(errorMessage(reason));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Name
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              required
              maxLength={100}
            />
          </label>
          <label>
            Instructions
            <textarea
              value={draft.instructions}
              onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
              rows={5}
              maxLength={32000}
            />
          </label>
          <div className="viber-field-pair">
            <label>
              Provider
              <select
                value={execution.provider}
                onChange={(e) => patch({ provider: e.target.value as typeof execution.provider })}
              >
                <option value="codex">Codex</option>
                <option value="antigravity">Antigravity</option>
              </select>
            </label>
            <label>
              Model
              <input
                value={execution.model}
                placeholder="CLI default"
                onChange={(e) => patch({ model: e.target.value })}
                maxLength={200}
              />
            </label>
            <label>
              Effort
              <input
                value={execution.effort}
                onChange={(e) => patch({ effort: e.target.value })}
                required
                maxLength={30}
              />
            </label>
            <label>
              Timeout (seconds)
              <input
                type="number"
                value={execution.timeout_secs}
                min={10}
                max={86400}
                onChange={(e) => patch({ timeout_secs: Number(e.target.value) })}
              />
            </label>
          </div>
          <label>
            Default access
            <select
              value={execution.access}
              onChange={(e) => patch({ access: e.target.value as typeof execution.access })}
            >
              {draft.supported_access.map((access) => (
                <option key={access}>{access}</option>
              ))}
            </select>
          </label>
          <label className="viber-checkbox">
            <input
              type="checkbox"
              checked={draft.supported_access.includes("workspace-write")}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  supported_access: e.target.checked
                    ? ["read-only", "workspace-write"]
                    : ["read-only"],
                  execution: {
                    ...execution,
                    access: e.target.checked ? execution.access : "read-only",
                  },
                })
              }
            />
            Allow nodes to request workspace writes
          </label>
          <label>
            Output
            <select
              value={execution.output}
              onChange={(e) => patch({ output: e.target.value as typeof execution.output })}
            >
              {["conversation", "summary", "plan", "refinement", "implementation", "review"].map(
                (output) => (
                  <option key={output}>{output}</option>
                ),
              )}
            </select>
          </label>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy} variant="default">
            Save profile
          </Button>
        </form>
      </section>
      {confirmClose && <DiscardChangesDialog keep={() => setConfirmClose(false)} discard={close} />}
    </div>
  );
};
