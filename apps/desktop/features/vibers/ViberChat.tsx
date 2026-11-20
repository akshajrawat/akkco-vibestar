import { useEffect, useRef, useState } from "react";
import type { AgentProfile } from "../../../core/vibers/contracts";
import type { ViberSession } from "../../../core/vibers/contracts";
import { rpc, errorMessage } from "../../lib/api";
import { getTaskView, useTaskView, updateTaskView } from "../../lib/taskView";
import { Composer, composerContent } from "../chat/Composer";
import { ChatSurface } from "../chat/ChatSurface";
import { ViberModelPicker } from "./ViberModelPicker";
import { ViberFace } from "./ViberFace";
import { ViberSessionChat } from "./ViberSessionChat";
import { RunError } from "../chat/RunError";
import { useProviders } from "../../hooks/useWorkspace";
import { ComputerPanel } from "../computer/ComputerPanel";
import { ResizeHandle } from "../../components/shared/ResizeHandle";
import { usePaneSize } from "../../hooks/usePaneSize";
import { configurationError } from "../../../core/execution/providers/contracts";

export const ViberChat = ({
  profile,
  revision,
  computerOpen = false,
  hideComputer = () => {},
}: {
  profile: AgentProfile;
  revision: number;
  computerOpen?: boolean;
  hideComputer?: () => void;
}) => {
  const [sessionId, setSessionId] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef({ signature: "", id: "", session: null as ViberSession | null });
  const starting = useRef(false);
  const draftId = `viber:${profile.id}:new-chat`;
  const view = useTaskView(draftId);
  const { providers, refresh: refreshProviders } = useProviders(profile.id);
  const [computerWidth, setComputerWidth] = usePaneSize("computerWidth", 410, 300, 720);

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

  const start = async () => {
    if (starting.current || invalid) {
      return;
    }

    const content = composerContent(getTaskView(draftId));
    if (!content.trim() || content.length > 32000) {
      return;
    }

    starting.current = true;
    setBusy(true);
    setError("");
    try {
      const signature = JSON.stringify({
        content,
        profile_id: profile.id,
        selection,
        // Preserve the request signature used by existing managed-workspace drafts.
        repositoryId: "",
      });

      if (request.current.signature !== signature) {
        const saved = getTaskView(draftId).messageRequest;

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
      profileId={profile.id}
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

  return (
    <div className="computer-workspace overflow-hidden flex flex-1 min-h-0 min-w-0">
      <section
        className="viber-chat-page flex flex-1 flex-col min-h-0 min-w-[260px] chat-workspace"
        aria-label={`Chat with ${profile.name}`}
      >
        {(error || (!sessionId && invalid)) && <RunError error={error || invalid!} conversation />}
        {sessionId ? (
          <ViberSessionChat
            key={sessionId}
            sessionId={sessionId}
            profile={profile}
            revision={revision}
          />
        ) : (
          <ChatSurface
            id={draftId}
            revision={revision}
            empty
            activity={null}
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
      </section>
      {computerOpen && (
        <ResizeHandle
          label="Resize computer panel"
          value={computerWidth}
          onChange={setComputerWidth}
          min={300}
          max={720}
          reverse
        />
      )}
      <div
        className="shrink-0 max-w-[calc(100%_-_265px)] min-w-[280px]"
        hidden={!computerOpen}
        style={{ width: computerWidth }}
      >
        {computerOpen && (
          <ComputerPanel
            profileId={profile.id}
            sessionId={sessionId}
            visible={computerOpen}
            hide={hideComputer}
            refreshProviders={refreshProviders}
          />
        )}
      </div>
    </div>
  );
};
