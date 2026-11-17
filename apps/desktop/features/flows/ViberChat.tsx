import { useEffect, useRef, useState } from "react";
import { MessageSquarePlus, Pencil } from "lucide-react";
import type { AgentProfile } from "../../../core/flows/contracts";
import type { ViberInstance } from "../../../core/flows/workspace";
import type { ViberSession } from "../../../core/vibers/contracts";
import { rpc, errorMessage } from "../../lib/api";
import { getTaskView, useTaskView, updateTaskView } from "../../lib/taskView";
import { Button } from "../../components/ui/button";
import { Composer, composerContent } from "../chat/Composer";
import { ChatSurface } from "../chat/ChatSurface";
import { ViberModelPicker } from "./ViberModelPicker";
import { ViberFace } from "./ViberFace";
import { ViberSessionChat } from "./ViberSessionChat";

export const ViberChat = ({
  profile,
  revision,
  edit,
  openTask,
}: {
  profile: AgentProfile;
  revision: number;
  edit: (profile: AgentProfile) => void;
  openTask: (taskId: string) => void;
}) => {
  const [sessionId, setSessionId] = useState<string>();
  const [sessions, setSessions] = useState<ViberSession[]>([]);
  const [instances, setInstances] = useState<ViberInstance[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef({ signature: "", id: "", session: null as ViberSession | null });
  const starting = useRef(false);
  const draftId = `viber:${profile.id}:new-chat`;
  const view = useTaskView(draftId);

  const selection = {
    provider: view.followupProvider || profile.execution.provider,
    model: view.followupModel ?? profile.execution.model,
    effort: view.followupEffort || profile.execution.effort,
  };

  useEffect(() => {
    let active = true;

    void Promise.all([
      rpc<ViberSession[]>("viber.session.list", { profile_id: profile.id }),
      rpc<ViberInstance[]>("viber.instances"),
    ])
      .then(([sessions, instances]) => {
        if (active) {
          setSessions(sessions);
          setInstances(instances.filter((instance) => instance.profile_id === profile.id));
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
  }, [profile.id, revision, sessionId]);

  const start = async () => {
    if (starting.current) {
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
      const signature = JSON.stringify({ content, profile_id: profile.id, selection });
      if (request.current.signature !== signature) {
        request.current = { signature, id: crypto.randomUUID(), session: null };
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
    <section className="viber-chat-page chat-workspace" aria-label={`Chat with ${profile.name}`}>
      <header className="viber-chat-page-header">
        <ViberFace profile={profile} />
        <div>
          <strong>{profile.name}</strong>
          <small title={profile.description}>
            {profile.description ||
              `${profile.execution.provider} · ${profile.execution.model || "CLI default"}`}
          </small>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="New chat"
          title="New chat"
          disabled={busy}
          onClick={() => {
            updateTaskView(draftId, {
              followupProvider: null,
              followupModel: null,
              followupEffort: null,
            });

            request.current = { signature: "", id: "", session: null };
            setSessionId(undefined);
          }}
        >
          <MessageSquarePlus size={15} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Edit Viber"
          title="Edit Viber"
          onClick={() => edit(profile)}
        >
          <Pencil size={14} />
        </Button>
      </header>
      {!!(sessions.length || instances.length) && (
        <details className="viber-chat-history">
          <summary>Conversations</summary>
          {sessions.map((session) => (
            <Button
              key={session.id}
              variant="ghost"
              size="sm"
              onClick={(event) => {
                setSessionId(session.id);
                event.currentTarget.closest("details")!.open = false;
              }}
            >
              {session.title}
            </Button>
          ))}
          {instances.map((instance) => (
            <Button
              key={`${instance.task_id}:${instance.node_id}`}
              variant="ghost"
              size="sm"
              onClick={() => openTask(instance.task_id)}
            >
              Task · {instance.goal.slice(0, 90)}
            </Button>
          ))}
        </details>
      )}
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
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
            <div className="chat-welcome viber-chat-welcome">
              <ViberFace profile={profile} className="viber-idle" />
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
              model={modelControl}
              hint="Enter to send · Shift+Enter for a new line"
            />
          }
        />
      )}
    </section>
  );
};
