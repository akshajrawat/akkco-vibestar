import { useRef, useState } from "react";

import type { AgentProfile, FlowNode, InputBindingSchema } from "../../../backend/flows/contracts";
import type { FlowWorkspace } from "../../../backend/flows/workspace";
import type { z } from "zod";
import type { Detail } from "../../lib/types";
import { getTaskView, updateTaskView, useTaskView } from "../../lib/taskView";
import { Button } from "../../components/ui/button";
import { ChatSurface } from "../chat/ChatSurface";
import { Composer, composerContent } from "../chat/Composer";
import { AgentTimeline } from "../chat/AgentTimeline";
import { CurrentRun } from "../chat/CurrentRun";
import { useOptimisticMessages } from "../chat/useOptimisticMessages";
import { ViberFace } from "./ViberFace";

type Binding = z.infer<typeof InputBindingSchema>;

type AgentNode = Extract<FlowNode, { type: "agent" }>;

/** Local drafts and scroll positions follow the task instance, never the reusable profile alone. */
export const viberConversationKey = (taskId: string, nodeId: string, profileId: string) =>
  `${taskId}:viber:${nodeId}:${profileId}`;

export const ViberConversation = ({
  detail,
  workspace,
  node,
  profile,
  revision,
  disabled,
  busy,
  action,
  output,
}: {
  detail: Detail;
  workspace: FlowWorkspace;
  node: AgentNode;
  profile?: AgentProfile;
  revision: number;
  disabled: boolean;
  busy: boolean;
  action: (method: string, params: unknown) => Promise<boolean>;
  output: () => void;
}) => {
  const taskId = detail.task.id;
  const id = viberConversationKey(taskId, node.id, node.profile_id);
  const view = useTaskView(id);
  const sending = useRef(false);
  const [selectedHistory, setHistory] = useState<string[] | null>(null);

  const [inputs, setInputs] = useState<Binding[]>(() =>
    node.inputs.filter((binding) =>
      ["task-goal", "task-brief", "repository", "issue"].includes(binding.kind),
    ),
  );

  const { messages, upsert, remove } = useOptimisticMessages(
    id,
    detail.messages.filter(
      (message) =>
        message.purpose === "chat" &&
        message.flow_node_id === node.id &&
        message.viber_profile_id === node.profile_id,
    ),
  );

  const completedMessages = messages.filter((message) => message.status === "chat_completed");

  const history = completedMessages
    .filter((message) => selectedHistory === null || selectedHistory.includes(message.id))
    .map((message) => message.id);

  const historyTooLarge = history.length > 50;

  const conversations = workspace.conversations.filter(
    (run) =>
      run.snapshot.conversation?.node_id === node.id &&
      run.snapshot.agents[node.id]?.profile.id === node.profile_id,
  );

  const turn = conversations[0];
  const active = !!turn && ["queued", "running", "pausing", "paused"].includes(turn.status);
  const turnIds = new Set(conversations.map((run) => run.id));

  const anotherConversation = workspace.conversations.some(
    (run) =>
      !turnIds.has(run.id) && ["queued", "running", "pausing", "paused"].includes(run.status),
  );

  const attempts = workspace.conversation_attempts.filter((attempt) => turnIds.has(attempt.run_id));

  const agentIds = new Set([
    ...attempts.map((attempt) => attempt.agent_run_id),
    ...messages.map((message) => message.run_id),
  ]);

  const runs = detail.runs.filter((run) => agentIds.has(run.id));
  const events = detail.events.filter((event) => agentIds.has(event.run_id));
  const stopped = attempts.filter((attempt) => attempt.run_id === turn?.id).at(-1);
  const execution = profile ? { ...profile.execution, ...node.overrides } : undefined;

  const choices: { binding: Binding; title: string }[] = [
    { binding: { kind: "task-goal" }, title: "Task goal" },
    { binding: { kind: "task-brief" }, title: "Task brief" },
    ...(detail.task.repo_id
      ? [{ binding: { kind: "repository" as const }, title: "Repository" }]
      : []),
    ...(detail.task.issue_url ? [{ binding: { kind: "issue" as const }, title: "Issue" }] : []),
    ...detail.artifacts.map((artifact) => ({
      binding: { kind: "artifact" as const, artifact_id: artifact.id },
      title: `${artifact.kind} · ${artifact.created_at}`,
    })),
    ...[...workspace.attempts, ...workspace.conversation_attempts]
      .filter((attempt) => attempt.status === "completed")
      .flatMap((attempt) => [
        {
          binding: { kind: "attempt-output" as const, attempt_id: attempt.id },
          title: `${attempt.configuration.node.name} · retained output · ${attempt.ended_at}`,
        },
        {
          binding: { kind: "attempt-verification" as const, attempt_id: attempt.id },
          title: `${attempt.configuration.node.name} · observed checks · ${attempt.verification}`,
        },
      ]),
  ];

  const send = async () => {
    if (sending.current || disabled || active || anotherConversation || busy || historyTooLarge)
      return;
    const content = composerContent(view);
    if (!content.trim() || content.length > 32000) return;

    const configuration = {
      task_id: taskId,
      node_id: node.id,
      profile_id: node.profile_id,
      expected_revision: workspace.revision.revision,
      history_ids: history,
      inputs,
    };

    const signature = JSON.stringify({ content, ...configuration });

    const request_id =
      view.messageRequest?.signature === signature ? view.messageRequest.id : crypto.randomUUID();

    const draft = { draft: view.draft, draftContext: view.draftContext };

    updateTaskView(id, {
      messageRequest: { id: request_id, signature },
      draft: "",
      draftContext: [],
      chatFollow: true,
    });

    upsert({
      id: request_id,
      role: "user",
      content,
      purpose: "chat",
      status: "chat_pending",
      flow_node_id: node.id,
      viber_profile_id: node.profile_id,
      created_at: new Date().toISOString(),
    });

    sending.current = true;
    try {
      if (await action("viber.chat", { ...configuration, request_id, content })) {
        updateTaskView(id, { messageRequest: null });
      } else {
        remove(request_id);
        const current = getTaskView(id);
        if (!current.draft && !current.draftContext.length) updateTaskView(id, draft);
      }
    } finally {
      sending.current = false;
    }
  };

  return (
    <ChatSurface
      id={id}
      revision={revision}
      empty={!messages.length && !runs.length}
      activity={
        <>
          {active && (
            <p className="flow-draft-notice">
              {node.name} · {turn.status}
            </p>
          )}
          {turn?.error && <p className="flow-inline-error">{turn.error}</p>}
          <CurrentRun
            detail={{ runs, events, usage: detail.usage, status: turn?.status }}
            output={output}
            stop={() => {
              if (turn) void action("flow.cancel", { run_id: turn.id });
            }}
          />
        </>
      }
      conversation={
        <>
          {!messages.length && !runs.length && (
            <div className="chat-welcome">
              <ViberFace />
              <h1>Hey, I’m {node.name}.</h1>
              <p>
                This conversation belongs to this Viber in this task. Select the context to share.
              </p>
            </div>
          )}
          <AgentTimeline
            runs={runs}
            events={events}
            messages={messages}
            compact
            expandResults={false}
          />
        </>
      }
      composer={
        <>
          <details className="flow-history">
            <summary>
              Context · {inputs.length} sources · {history.length} messages
            </summary>
            <p>
              This Viber’s completed conversation is included by default. Choose specific messages
              below to limit context. Retained outputs do not complete graph nodes.
            </p>
            {choices.map(({ binding, title }) => {
              const key = JSON.stringify(binding);
              const checked = inputs.some((item) => JSON.stringify(item) === key);
              return (
                <label className="viber-checkbox" key={key}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!checked && inputs.length >= 49}
                    onChange={() =>
                      setInputs(
                        checked
                          ? inputs.filter((item) => JSON.stringify(item) !== key)
                          : [...inputs, binding],
                      )
                    }
                  />
                  {title}
                </label>
              );
            })}
            {selectedHistory !== null && (
              <Button onClick={() => setHistory(null)}>Include this conversation</Button>
            )}
            {completedMessages.map((message) => (
              <label className="viber-checkbox" key={message.id}>
                <input
                  type="checkbox"
                  checked={history.includes(message.id)}
                  disabled={!history.includes(message.id) && history.length >= 50}
                  onChange={(event) =>
                    setHistory(
                      event.target.checked
                        ? [...history, message.id]
                        : history.filter((value) => value !== message.id),
                    )
                  }
                />
                {message.role}: {message.content.slice(0, 160)}
              </label>
            ))}
          </details>
          {historyTooLarge && (
            <p className="flow-inline-error" role="alert">
              This conversation exceeds 50 context messages. Choose fewer messages in Context before
              sending; none were silently omitted.
            </p>
          )}
          {turn?.status === "paused" && (
            <Button
              disabled={busy || disabled}
              onClick={() =>
                void action("flow.continue", { run_id: turn.id, request_id: crypto.randomUUID() })
              }
            >
              Continue conversation
            </Button>
          )}
          {turn && stopped && ["failed", "interrupted", "cancelled"].includes(turn.status) && (
            <Button
              disabled={busy || disabled}
              onClick={() =>
                void action("flow.node.retry", {
                  run_id: turn.id,
                  node_id: node.id,
                  attempt_id: stopped.id,
                  request_id: crypto.randomUUID(),
                })
              }
            >
              Retry captured turn
            </Button>
          )}
          <Composer
            id={id}
            label="Viber conversation"
            placeholder={`Message ${node.name}…`}
            sendLabel="Send message"
            onSend={() => void send()}
            model={
              <span>
                {profile?.name || node.name} · {execution?.access} ·{" "}
                {execution?.model || "CLI default"}
              </span>
            }
            context={[]}
            busy={busy}
            disabled={disabled || active || anotherConversation || historyTooLarge}
            stop={
              active
                ? () => {
                    void action("flow.cancel", { run_id: turn.id });
                  }
                : undefined
            }
            hint="This Viber uses its saved instructions and access. Conversations share the task’s files."
          />
        </>
      }
    />
  );
};
