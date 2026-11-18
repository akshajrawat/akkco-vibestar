import { useState } from "react";
import { Bot, X } from "lucide-react";

import { defaultAppearance, randomAppearance } from "../../../core/vibers/appearance";
import { AgentProfileSchema, type AgentProfile } from "../../../core/vibers/contracts";
import { Button } from "../../components/ui/button";
import { rpc, computerRpc, errorMessage } from "../../lib/api";
import { WorkspaceOverlay } from "../../components/ui/WorkspaceOverlay";
import { AvatarBuilder } from "./AvatarBuilder";
import { ViberFace } from "./ViberFace";
import { DiscardChangesDialog } from "../../components/ui/DiscardChangesDialog";

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
  const appearance = draft.appearance || defaultAppearance();
  const [customColor, setCustomColor] = useState(appearance.color);

  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const requestClose = () => {
    if (busy) {
      return;
    }

    if (JSON.stringify(draft) !== JSON.stringify(profile) || customColor !== appearance.color) {
      setConfirmClose(true);
    } else {
      close();
    }
  };

  return (
    <WorkspaceOverlay
      label={profile.revision ? "Edit Viber profile" : "Create Viber profile"}
      className="viber-editor-overlay"
      onClose={requestClose}
    >
      <header className="viber-editor-heading">
        <Bot size={28} aria-hidden="true" />
        <div>
          <h2>{profile.revision ? "Edit Viber" : "Create Viber"}</h2>
          <p>Design a Viber with its own name and appearance.</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Close Viber editor"
          disabled={busy}
          onClick={requestClose}
        >
          <X size={19} />
        </Button>
      </header>
      <form
        className="viber-profile-editor"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!/^#[0-9a-fA-F]{6}$/.test(customColor)) {
            setError("Enter a valid six-digit custom HEX color before saving.");
            return;
          }

          setBusy(true);
          setError("");
          try {
            const next = AgentProfileSchema.parse({
              ...draft,
              appearance,
              revision: profile.revision + 1,
            });

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
        <div className="viber-editor-content">
          <div className="viber-editor-main">
            <div className="viber-identity-fields">
              <label>
                Name
                <input
                  placeholder="Name your Viber"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  required
                  maxLength={100}
                />
              </label>
            </div>
            <section className="viber-live-preview" aria-label="Live avatar preview">
              <ViberFace appearance={appearance} />
            </section>
            <AvatarBuilder
              appearance={appearance}
              change={(appearance) => setDraft({ ...draft, appearance })}
              customColor={customColor}
              setCustomColor={setCustomColor}
              randomize={() => {
                const appearance = randomAppearance();
                setDraft({ ...draft, appearance });
                setCustomColor(appearance.color);
              }}
            />
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </div>
        <footer className="viber-editor-actions">
          {!!profile.revision && (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              Delete Viber
            </Button>
          )}
          <Button type="button" disabled={busy} onClick={requestClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !draft.name.trim()} variant="default">
            {busy ? "Saving…" : profile.revision ? "Save Viber" : "Create Viber"}
          </Button>
        </footer>
      </form>
      {confirmClose && <DiscardChangesDialog keep={() => setConfirmClose(false)} discard={close} />}
      {confirmDelete && (
        <WorkspaceOverlay
          label="Delete Viber"
          onClose={() => setConfirmDelete(false)}
          className="computer-confirmation"
        >
          <h2>Delete {profile.name}?</h2>
          <p>
            This permanently deletes this Viber's computer storage, installed dependencies, account
            sessions, conversations, and all workspace files, including unsaved or unpublished work.
            Stop active turns and close its terminal first.
          </p>
          <footer>
            <Button disabled={busy} onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError("");

                void computerRpc("profile.delete", { profile_id: profile.id, confirmed: true })
                  .then(() => {
                    saved();
                    close();
                  })
                  .catch((reason) => {
                    setError(errorMessage(reason));
                    setConfirmDelete(false);
                  })
                  .finally(() => setBusy(false));
              }}
            >
              Delete permanently
            </Button>
          </footer>
        </WorkspaceOverlay>
      )}
    </WorkspaceOverlay>
  );
};
