import { useState } from "react";
import { X } from "lucide-react";

import { defaultAppearance, randomAppearance } from "../../../core/vibers/appearance";
import {
  AgentProfileSchema,
  DEFAULT_VIBER_INSTRUCTIONS,
  type AgentProfile,
} from "../../../core/vibers/contracts";
import { Button } from "../../components/ui/button";
import { rpc, errorMessage } from "../../lib/api";
import { WorkspaceOverlay } from "../../components/ui/WorkspaceOverlay";
import { AvatarBuilder } from "./AvatarBuilder";
import { ViberFace } from "./ViberFace";
import { DiscardChangesDialog } from "../../components/ui/DiscardChangesDialog";

export const CreateViberDialog = ({
  profile,
  renameOnly = false,
  close,
  saved,
}: {
  profile: AgentProfile;
  renameOnly?: boolean;
  close: () => void;
  saved: (profile: AgentProfile) => void;
}) => {
  const editing = profile.revision > 0;
  const title = renameOnly ? "Rename Viber" : editing ? "Edit Viber" : "Create Viber";
  const [draft, setDraft] = useState(profile);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const appearance = draft.appearance || defaultAppearance();
  const [customColor, setCustomColor] = useState(appearance.color);

  const [confirmClose, setConfirmClose] = useState(false);

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
      label={editing ? title : "Create Viber profile"}
      className={`viber-editor-overlay viber-create-overlay ${renameOnly ? "viber-rename-overlay" : ""}`}
      onClose={requestClose}
      dismissOnBackdrop
    >
      <header className="viber-editor-heading flex min-h-13 items-center shrink-0 gap-3">
        {editing && (
          <button
            className="viber-editor-mascot"
            type="button"
            aria-label="Animate Viber"
            onClick={(event) => {
              if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
                event.currentTarget.animate(
                  [
                    { transform: "translateY(0) rotate(0)" },
                    { transform: "translateY(-6px) rotate(-12deg)" },
                    { transform: "translateY(0) rotate(0)" },
                  ],
                  { duration: 420, easing: "ease-in-out" },
                );
              }
            }}
          >
            <ViberFace appearance={appearance} animated />
          </button>
        )}
        <h2>{title}</h2>
        <Button
          className="ml-auto"
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Close ${title.toLowerCase()} dialog`}
          disabled={busy}
          onClick={requestClose}
        >
          <X size={19} />
        </Button>
      </header>
      <form
        className="viber-profile-editor flex flex-col min-h-0"
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
              ...(renameOnly
                ? { ...profile, name: draft.name }
                : {
                    ...draft,
                    instructions: draft.instructions.trim() || DEFAULT_VIBER_INSTRUCTIONS,
                    appearance,
                  }),
              revision: profile.revision + 1,
            });

            await rpc("profile.save", {
              profile: next,
              expected_revision: profile.revision || null,
            });

            saved(next);
            close();
          } catch (reason) {
            setError(errorMessage(reason));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="viber-editor-content min-h-0 px-6 py-1 [@media(max-width:700px)]:px-4">
          <div className="viber-editor-main grid grid-cols-[minmax(0,_1.1fr)_minmax(220px,_1fr)] [@media(max-width:700px)]:grid-cols-[minmax(0,_1fr)] items-center">
            {!renameOnly && (
              <section
                className="viber-live-preview grid place-items-center self-stretch"
                aria-label="Live avatar preview"
              >
                <ViberFace appearance={appearance} animated />
              </section>
            )}
            <div className="viber-identity-fields grid gap-2.5 min-w-0">
              <label>
                <span className="sr-only">Name</span>
                <input
                  className="viber-name-input"
                  placeholder="Name your Viber"
                  autoFocus={editing}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  required
                  maxLength={100}
                />
              </label>
              {editing && !renameOnly && (
                <>
                  <label>
                    Description
                    <input
                      value={draft.description ?? ""}
                      maxLength={2000}
                      onChange={(event) =>
                        setDraft({ ...draft, description: event.currentTarget.value })
                      }
                    />
                  </label>
                  <label>
                    Instructions
                    <textarea
                      value={draft.instructions}
                      maxLength={32000}
                      onChange={(event) =>
                        setDraft({ ...draft, instructions: event.currentTarget.value })
                      }
                    />
                  </label>
                </>
              )}
            </div>
            {!renameOnly && (
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
            )}
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </div>
        <footer className="viber-editor-actions flex shrink-0 justify-end gap-2.5">
          <Button type="button" disabled={busy} onClick={requestClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !draft.name.trim()} variant="default">
            {busy ? "Saving…" : editing ? "Save changes" : "Create Viber"}
          </Button>
        </footer>
      </form>
      {confirmClose && <DiscardChangesDialog keep={() => setConfirmClose(false)} discard={close} />}
    </WorkspaceOverlay>
  );
};
