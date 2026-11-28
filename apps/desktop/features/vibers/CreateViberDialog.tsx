import { useMemo, useState } from "react";
import { Shuffle, X } from "lucide-react";

import { pixelAppearance, randomAppearance } from "../../../core/vibers/appearance";
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

  const appearance = useMemo(
    () => pixelAppearance(draft.appearance, profile.id),
    [draft.appearance, profile.id],
  );

  const [confirmClose, setConfirmClose] = useState(false);

  const requestClose = () => {
    if (busy) {
      return;
    }

    if (JSON.stringify(draft) !== JSON.stringify(profile)) {
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
                    { transform: "translateY(0)" },
                    { transform: "translateY(-4px)" },
                    { transform: "translateY(0)" },
                  ],
                  { duration: 360, easing: "steps(4, end)" },
                );
              }
            }}
          >
            <ViberFace appearance={appearance} />
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
          setBusy(true);
          setError("");
          try {
            const next = AgentProfileSchema.parse({
              ...(renameOnly
                ? { ...profile, name: draft.name }
                : {
                    ...draft,
                    instructions: draft.instructions.trim() || DEFAULT_VIBER_INSTRUCTIONS,
                    ...(editing ? {} : { appearance }),
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
          <div className="viber-editor-main">
            <div className="viber-profile-fields">
              {!renameOnly && (
                <section
                  className="viber-live-preview grid place-items-center self-stretch"
                  aria-label="Live avatar preview"
                >
                  <ViberFace
                    appearance={appearance}
                    label={[
                      `${appearance.color} ${appearance.shape.replaceAll("-", " ")}`,
                      appearance.eyes === "none" ? "no eyes" : `${appearance.eyes} eyes`,
                      appearance.mouth !== "none" && `${appearance.mouth} mouth`,
                      ...[
                        appearance.headwear,
                        appearance.eyewear,
                        appearance.neckwear,
                        appearance.extra,
                      ]
                        .filter((part) => part !== "none")
                        .map((part) => part.replaceAll("-", " ")),
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  />
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
                {!renameOnly && (
                  <Button
                    className="justify-self-center"
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setDraft((current) => ({ ...current, appearance: randomAppearance() }))
                    }
                  >
                    <Shuffle size={14} aria-hidden="true" />
                    Random
                  </Button>
                )}
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
            </div>
            {!renameOnly && (
              <AvatarBuilder
                appearance={appearance}
                change={(appearance) => setDraft((current) => ({ ...current, appearance }))}
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
