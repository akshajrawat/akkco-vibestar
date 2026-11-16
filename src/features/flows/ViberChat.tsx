import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquarePlus, Pencil } from "lucide-react";

import type { AgentProfile } from "../../../backend/flows/contracts";
import type { FlowWorkspace, ViberInstance } from "../../../backend/flows/workspace";
import type { Detail, Task } from "../../lib/types";
import { rpc, errorMessage } from "../../lib/api";
import { getTaskView, updateTaskView } from "../../lib/taskView";
import { Button } from "../../components/ui/button";
import { Composer, composerContent } from "../chat/Composer";
import { ChatSurface } from "../chat/ChatSurface";
import { ViberModelPicker } from "./ViberModelPicker";
import { ViberFace } from "./ViberFace";
import { ViberConversation } from "./ViberConversation";

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
  const [overrideProfile, setOverrideProfile] = useState<AgentProfile | null>(null);

  const configuration =
    overrideProfile &&
    overrideProfile.id === profile.id &&
    overrideProfile.revision >= profile.revision
      ? overrideProfile
      : profile;

  const [session, setSession] = useState<{ task_id: string; node_id: string }>();
  const [instances, setInstances] = useState<ViberInstance[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef({ signature: "", id: "", task: null as Task | null });
  const starting = useRef(false);
  const draftId = `viber:${profile.id}:new-chat`;

  useEffect(() => {
    let active = true;

    void rpc<ViberInstance[]>("viber.instances")
      .then((instances) => {
        if (active)
          setInstances(instances.filter((instance) => instance.profile_id === profile.id));
      })
      .catch((reason) => {
        if (active) setError(errorMessage(reason));
      });

    return () => {
      active = false;
    };
  }, [profile.id, revision, session]);

  const start = async () => {
    if (starting.current) return;
    const content = composerContent(getTaskView(draftId));
    if (!content.trim() || content.length > 32000) return;
    starting.current = true;
    setBusy(true);
    setError("");
    try {
      const signature = JSON.stringify({ content, profile_id: profile.id });
      if (request.current.signature !== signature)
        request.current = { signature, id: crypto.randomUUID(), task: null };

      const task =
        request.current.task ||
        (await rpc<Task>("task.createGeneral", {
          request_id: request.current.id,
          goal: content,
          repository_id: null,
          profile_id: profile.id,
        }));

      request.current.task = task;
      const workspace = await rpc<FlowWorkspace>("flow.workspace", { task_id: task.id });
      if (workspace.capabilities?.conversations !== 1)
        throw new Error("This core does not support Viber conversations.");

      const node = workspace.revision.definition.nodes.find(
        (node) => node.type === "agent" && node.profile_id === profile.id,
      );

      if (!node || node.type !== "agent")
        throw new Error("The saved Viber conversation is unavailable.");

      await rpc("viber.chat", {
        task_id: task.id,
        node_id: node.id,
        profile_id: profile.id,
        expected_revision: workspace.revision.revision,
        history_ids: [],
        inputs: node.inputs,
        request_id: request.current.id,
        content,
      });

      updateTaskView(draftId, { draft: "", draftContext: [] });
      setSession({ task_id: task.id, node_id: node.id });
      request.current = { signature: "", id: "", task: null };
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      starting.current = false;
      setBusy(false);
    }
  };

  const modelControl = (
    <ViberModelPicker
      execution={configuration.execution}
      change={(execution) => {
        void rpc<AgentProfile>("profile.save", {
          profile: { ...configuration, execution, revision: configuration.revision + 1 },
          expected_revision: configuration.revision,
        })
          .then(setOverrideProfile)
          .catch((reason) => setError(errorMessage(reason)));
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
          onClick={() => setSession(undefined)}
        >
          <MessageSquarePlus size={15} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Edit Viber"
          title="Edit Viber"
          onClick={() => edit(configuration)}
        >
          <Pencil size={14} />
        </Button>
      </header>
      {!!instances.length && (
        <details className="viber-chat-history">
          <summary>Conversations</summary>
          {instances.map((instance) => (
            <Button
              key={`${instance.task_id}:${instance.node_id}`}
              variant="ghost"
              size="sm"
              onClick={(event) => {
                setSession(instance);
                event.currentTarget.closest("details")!.open = false;
              }}
            >
              {instance.goal.slice(0, 90)}
            </Button>
          ))}
        </details>
      )}
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      {session ? (
        <SavedViberChat
          key={`${session.task_id}:${session.node_id}`}
          session={session}
          profile={profile}
          revision={revision}
          openTask={openTask}
          modelControl={modelControl}
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

const SavedViberChat = ({
  session,
  profile,
  revision,
  openTask,
  modelControl,
}: {
  modelControl: React.ReactNode;
  session: { task_id: string; node_id: string };
  profile: AgentProfile;
  revision: number;
  openTask: (taskId: string) => void;
}) => {
  const [data, setData] = useState<{ detail: Detail; workspace: FlowWorkspace }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [detail, workspace] = await Promise.all([
      rpc<Detail>("task.detail", { id: session.task_id }),
      rpc<FlowWorkspace>("flow.workspace", { task_id: session.task_id }),
    ]);

    return { detail, workspace };
  }, [session.task_id]);

  useEffect(() => {
    let active = true;

    void load()
      .then((data) => {
        if (active) setData(data);
      })
      .catch((reason) => {
        if (active) setError(errorMessage(reason));
      });

    return () => {
      active = false;
    };
  }, [load, revision]);

  const node = data?.workspace.revision.definition.nodes.find(
    (node) => node.id === session.node_id,
  );

  const activeFlow = data?.workspace.runs.some((run) =>
    ["queued", "running", "pausing"].includes(run.status),
  );

  const conversationActive = data?.workspace.conversations.some((run) =>
    ["queued", "running", "pausing", "paused"].includes(run.status),
  );

  return (
    <>
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      {data && node?.type === "agent" && data.workspace.capabilities?.conversations === 1 ? (
        <ViberConversation
          compact
          modelControl={modelControl}
          detail={data.detail}
          workspace={data.workspace}
          node={node}
          profile={profile}
          revision={revision}
          busy={busy}
          disabled={
            !!activeFlow ||
            data.detail.task.archived ||
            data.detail.task.status === "completed" ||
            (!!data.detail.active && !conversationActive)
          }
          output={() => openTask(session.task_id)}
          action={async (method, params) => {
            setBusy(true);
            setError("");
            try {
              await rpc(method, params);
              setData(await load());
              return true;
            } catch (reason) {
              setError(errorMessage(reason));
              return false;
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : (
        <p className="empty-row">
          {data ? "This saved conversation is unavailable." : "Opening conversation…"}
        </p>
      )}
    </>
  );
};
