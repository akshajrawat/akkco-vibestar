import { useEffect, useRef, useState } from "react";
import { MessageSquarePlus, Pencil, Paperclip, X } from "lucide-react";
import type { AgentProfile } from "../../../core/flows/contracts";
import type { ViberInstance } from "../../../core/flows/workspace";
import type { ViberSession } from "../../../core/vibers/contracts";
import { rpc, errorMessage } from "../../lib/api";
import { getTaskView, useTaskView, updateTaskView } from "../../lib/taskView";
import type { Snapshot, Repository } from "../../lib/types";
import { Select } from "../../components/ui/Select";
import { Button } from "../../components/ui/button";
import { Composer, composerContent } from "../chat/Composer";
import { ChatSurface } from "../chat/ChatSurface";
import { ViberModelPicker } from "./ViberModelPicker";
import { ViberFace } from "./ViberFace";
import { ViberSessionChat } from "./ViberSessionChat";
import { RunError } from "../chat/RunError";
import { useProviders } from "../../hooks/useWorkspace";
import { configurationError } from "../../../core/execution/providers/contracts";

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
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [repositoryId, setRepositoryId] = useState("");
  const [instances, setInstances] = useState<ViberInstance[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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

  const repository = repositories.find((repository) => repository.id === repositoryId);

  useEffect(() => {
    let active = true;

    void Promise.all([
      rpc<ViberSession[]>("viber.session.list", { profile_id: profile.id }),
      rpc<ViberInstance[]>("viber.instances"),
      rpc<Snapshot>("snapshot"),
    ])
      .then(([sessions, instances, snapshot]) => {
        if (active) {
          setSessions(sessions);

          setRepositories(
            snapshot.repositories.filter(
              (repo) => repo.connected !== false && repo.clone_status !== "cloning",
            ),
          );

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
        repositoryId,
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
          ...(repositoryId ? { repository_id: repositoryId } : {}),
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
              messageRequest: null,
            });

            request.current = { signature: "", id: "", session: null };
            setRepositoryId("");
            setError("");
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
        {!!(sessions.length || instances.length) && (
          <div className="viber-chat-history">
            <Select
              label="Chat history"
              value={sessionId || ""}
              selectedLabel="Chat history"
              searchable
              disabled={busy}
              options={[
                ...sessions.map((session) => ({ value: session.id, label: session.title })),
                ...instances.map((instance) => ({
                  value: `task:${instance.task_id}:${instance.node_id}`,
                  label: `Task · ${instance.goal.slice(0, 90)}`,
                })),
              ]}
              onChange={(value) => {
                if (value.startsWith("task:")) {
                  openTask(value.split(":")[1]);
                } else {
                  setError("");
                  setSessionId(value);
                }
              }}
            />
          </div>
        )}
      </header>
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
            <div className="chat-welcome viber-chat-welcome">
              <ViberFace profile={profile} className="viber-idle" />
              <h1>Ready when you are.</h1>
            </div>
          }
          composer={
            <>
              <div className="viber-repository-attachment">
                {repository ? (
                  <span className="viber-repository-chip">
                    {repository.owner}/{repository.name}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Remove repository"
                      disabled={busy}
                      onClick={() => setRepositoryId("")}
                    >
                      <X size={13} />
                    </Button>
                  </span>
                ) : (
                  <Select
                    label="Attach repository"
                    selectedLabel={
                      <>
                        <Paperclip size={14} /> Attach repository
                      </>
                    }
                    value={repositoryId}
                    disabled={busy}
                    onChange={setRepositoryId}
                    searchable
                    options={[
                      ...repositories.map((repo) => ({
                        value: repo.id,
                        label: `${repo.owner}/${repo.name}`,
                      })),
                    ]}
                  />
                )}
              </div>
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
                hint="Each chat owns a separate workspace. Repository chats use a dedicated Git worktree."
              />
            </>
          }
        />
      )}
    </section>
  );
};
