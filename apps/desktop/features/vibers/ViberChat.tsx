import { useEffect, useRef, useState, type CSSProperties } from "react";
import { defaultAppearance } from "../../../core/vibers/appearance";
import type { AgentProfile, ViberSession } from "../../../core/vibers/contracts";
import type { Settings } from "../../lib/types";
import { rpc, errorMessage } from "../../lib/api";
import { getTaskView, useTaskView, updateTaskView } from "../../lib/taskView";
import { Composer, composerContent } from "../chat/Composer";
import { ChatSurface } from "../chat/ChatSurface";
import { ViberModelPicker } from "./ViberModelPicker";
import { ViberFace } from "./ViberFace";
import { ViberSessionChat } from "./ViberSessionChat";
import { SharedWorkspaceDialog } from "./SharedWorkspaceDialog";
import { RunError } from "../chat/RunError";
import { useProviders } from "../../hooks/useWorkspace";
import { configurationError } from "../../../core/execution/providers/contracts";

const messageTextColor = (color: string) => {
  const [red, green, blue] = [1, 3, 5].map((index) => {
    const channel = Number.parseInt(color.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });

  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return luminance > 0.179 ? "#000" : "#fff";
};

export const ViberChat = ({
  profile,
  revision,
  computerSupported = false,
  settings,
}: {
  profile: AgentProfile;
  revision: number;
  computerSupported?: boolean;
  settings?: Settings;
}) => {
  const [sessionId, setSessionId] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sharePrompt, setSharePrompt] = useState<{ content: string }>();
  const request = useRef({ signature: "", id: "", session: null as ViberSession | null });
  const starting = useRef(false);
  const draftId = `viber:${profile.id}:new-chat`;
  const view = useTaskView(draftId);
  const { providers } = useProviders();

  const selection = {
    provider: view.followupProvider || profile.execution.provider,
    model: view.followupModel ?? profile.execution.model,
    effort: view.followupEffort || profile.execution.effort,
  };

  const provider = providers.find((provider) => provider.provider === selection.provider);

  const invalid = provider
    ? !selection.model && !provider.models.some((model) => model.isDefault)
      ? "Choose a model before sending a message."
      : configurationError(provider, { ...profile.execution, ...selection })
    : null;

  useEffect(() => {
    let active = true;

    void rpc<ViberSession[]>("viber.session.list", { profile_id: profile.id })
      .then(([session]) => {
        if (active && session) {
          setSessionId(session.id);
        }
      })
      .catch((reason) => {
        if (active) {
          setError(errorMessage(reason));
        }
      });

    return () => {
      active = false;
    };
  }, [profile.id, revision]);

  const start = async (content = composerContent(getTaskView(draftId)), shareChoice?: boolean) => {
    if (starting.current || invalid) {
      return;
    }

    if (!content.trim() || content.length > 32000) {
      return;
    }

    const signatureFor = (share: boolean) =>
      JSON.stringify({
        content,
        ...(share && content.trim() !== "/clear" ? { shared_computer: true } : {}),
        profile_id: profile.id,
        selection,
        // Preserve the request signature used by existing managed-workspace drafts.
        repositoryId: "",
      });

    const saved = getTaskView(draftId).messageRequest;

    const savedChoice =
      saved?.signature === signatureFor(false)
        ? false
        : saved?.signature === signatureFor(true)
          ? true
          : undefined;

    const canShare = Boolean(
      computerSupported && settings?.allow_viber_communication && content.trim() !== "/clear",
    );

    let share = false;
    if (shareChoice !== undefined) {
      share = canShare && shareChoice;
    } else if (savedChoice !== undefined) {
      share = savedChoice;
    } else if (canShare) {
      if (settings?.viber_workspace_permission === "full-permission") {
        share = true;
      } else {
        setSharePrompt({ content });
        return;
      }
    }

    starting.current = true;
    setBusy(true);
    setError("");
    try {
      const computer = share ? { shared_computer: true as const } : {};
      const signature = signatureFor(share);

      if (request.current.signature !== signature) {
        request.current = {
          signature,
          id: saved?.signature === signature ? saved.id : crypto.randomUUID(),
          session: null,
        };

        updateTaskView(draftId, { messageRequest: { signature, id: request.current.id } });
      }

      const session =
        request.current.session ||
        (await rpc<ViberSession>("viber.session.create", {
          request_id: request.current.id,
          profile_id: profile.id,
          selection,
        }));

      request.current.session = session;

      await rpc("viber.session.send", {
        session_id: session.id,
        profile_id: profile.id,
        request_id: request.current.id,
        content,
        history_ids: [],
        ...computer,
        selection,
      });

      updateTaskView(draftId, {
        draft: "",
        draftContext: [],
        followupProvider: null,
        followupModel: null,
        followupEffort: null,
        messageRequest: null,
      });

      setSessionId(session.id);
      request.current = { signature: "", id: "", session: null };
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      starting.current = false;
      setBusy(false);
    }
  };

  const modelControl = (
    <ViberModelPicker
      execution={{ ...profile.execution, ...selection }}
      disabled={busy}
      change={(execution) => {
        updateTaskView(draftId, {
          followupProvider: execution.provider,
          followupModel: execution.model,
          followupEffort: execution.effort,
        });
      }}
    />
  );

  const color = profile.appearance?.color ?? defaultAppearance().color;

  return (
    <section
      className="viber-chat-page flex flex-1 flex-col min-h-0 min-w-[260px] chat-workspace"
      aria-label={`Chat with ${profile.name}`}
      style={
        {
          "--viber-message-bg": color,
          "--viber-message-ink": messageTextColor(color),
        } as CSSProperties
      }
    >
      {(error || (!sessionId && invalid)) && <RunError error={error || invalid!} conversation />}
      {sessionId ? (
        <ViberSessionChat
          key={sessionId}
          sessionId={sessionId}
          profile={profile}
          revision={revision}
          computerSupported={computerSupported}
          settings={settings}
        />
      ) : (
        <ChatSurface
          id={draftId}
          revision={revision}
          empty
          conversation={
            <div className="chat-welcome py-[0_24px] text-center viber-chat-welcome">
              <ViberFace profile={profile} animated />
              <h1>Ready when you are.</h1>
            </div>
          }
          composer={
            <Composer
              compact
              id={draftId}
              label={`Message ${profile.name}`}
              placeholder={`Ask ${profile.name} anything…`}
              sendLabel="Send message"
              onSend={() => void start()}
              context={[
                {
                  label: "Text",
                  input: "Context text",
                  load: async (text) => ({ label: "Attached text", text }),
                },
              ]}
              busy={busy}
              disabled={!!invalid}
              model={modelControl}
              hint="Each Viber uses its own workspace."
            />
          }
        />
      )}
      {sharePrompt && (
        <SharedWorkspaceDialog
          viberName={profile.name}
          cancel={() => setSharePrompt(undefined)}
          keepIsolated={() => {
            const prompt = sharePrompt;
            setSharePrompt(undefined);
            void start(prompt.content, false);
          }}
          allow={() => {
            const prompt = sharePrompt;
            setSharePrompt(undefined);
            void start(prompt.content, true);
          }}
        />
      )}
    </section>
  );
};
