import type { AgentProfile, FlowDefinition } from "../../../backend/flows/contracts";
import type { FlowWorkspace as Workspace } from "../../../backend/flows/workspace";
import type { Detail, Diff } from "../../lib/types";
import { Button } from "../../components/ui/button";
import { ChangesView } from "../../components/shared/ChangesView";
import { AgentTimeline } from "../chat/AgentTimeline";
import { LogView } from "../chat/LogView";
import { UsageView } from "../usage/UsageView";
import type { FlowWorkspaceSection } from "../../lib/taskView";
import { FlowCanvas } from "./FlowCanvas";
import { ViberConversation, viberConversationKey } from "./ViberConversation";
import { ManagedFiles } from "./ManagedFiles";
import { ImportedHistory } from "./ImportedHistory";
import type { FlowInputChoice } from "./FlowInspector";
import { CommandRuns } from "../verification/CommandRuns";
import { BrowserEnvironment } from "../verification/BrowserEnvironment";

interface FlowWorkspacePanelProps {
  tab: FlowWorkspaceSection;
  detail: Detail;
  workspace: Workspace;
  profiles: AgentProfile[];
  draft: FlowDefinition;
  revision: number;
  selected?: string;
  setSelected: (nodeId: string) => void;
  setTab: (section: FlowWorkspaceSection) => void;
  active: boolean;
  busy: boolean;
  dirty: boolean;
  conversationActive: boolean;
  diff: Diff | null;
  onError: (error: string) => void;
  action: (method: string, params: unknown) => Promise<boolean>;
  change: (definition: FlowDefinition) => void;
  saveLayout: Parameters<typeof FlowCanvas>[0]["layout"];
  editProfile: (profile: AgentProfile) => void;
}

export const FlowWorkspacePanel = ({
  tab,
  detail,
  workspace,
  profiles,
  draft,
  revision,
  selected,
  setSelected,
  setTab,
  active,
  busy,
  dirty,
  conversationActive,
  diff,
  onError,
  action,
  change,
  saveLayout,
  editProfile,
}: FlowWorkspacePanelProps) => {
  const task = detail.task;
  const run = workspace.runs[0];

  const selectedAttempts = [...workspace.attempts, ...workspace.conversation_attempts]
    .filter((attempt) => attempt.node_id === selected)
    .sort((a, b) => a.started_at.localeCompare(b.started_at));

  const selectedRunIds = new Set(selectedAttempts.map((attempt) => attempt.agent_run_id));
  const selectedRuns = detail.runs.filter((run) => selectedRunIds.has(run.id));
  const agentNodes = workspace.revision.definition.nodes.filter((node) => node.type === "agent");
  const chatNode = agentNodes.find((node) => node.id === selected) || agentNodes[0];
  const messages = detail.messages.filter((message) => message.purpose === "chat");

  return (
    <div className="viber-workspace-body">
      {tab === "canvas" ? (
        <FlowCanvas
          contextChoices={[
            ...detail.artifacts.map((artifact): FlowInputChoice => ({
              binding: { kind: "artifact", artifact_id: artifact.id },
              title: `${artifact.kind} · saved stage ${artifact.stage} · ${artifact.created_at}`,
            })),
            ...detail.messages.map((message): FlowInputChoice => ({
              binding: { kind: "message", message_id: message.id },
              title: `${message.purpose || "instruction"} · ${message.status || "historical"} · ${message.content.slice(0, 120)}`,
            })),
            ...detail.runs
              .filter((run) => detail.tests.some((test) => test.run_id === run.id))
              .map((run): FlowInputChoice => ({
                binding: { kind: "command-evidence", run_id: run.id },
                title: `Observed commands · ${run.purpose} · ${run.started_at}`,
              })),
            ...(detail.tests.some((test) => !test.run_id)
              ? [
                  {
                    binding: { kind: "command-evidence" as const, run_id: null },
                    title: "Observed manual commands",
                  },
                ]
              : []),
          ]}
          controlsDisabled={
            dirty ||
            busy ||
            conversationActive ||
            (!!run && !!workspace.invalidations[run.id]) ||
            task.status === "completed"
          }
          key={task.flow_id}
          workspace={workspace}
          profiles={profiles}
          draft={draft}
          change={change}
          layout={saveLayout}
          selected={selected}
          select={setSelected}
          action={(method, params) => {
            void action(method, params);
          }}
          activity={() => setTab("activity")}
          chat={() => setTab("chat")}
          editProfile={editProfile}
          activityFor={(attempt) => (
            <AgentTimeline
              compact
              expandResults={false}
              runs={detail.runs.filter((run) => run.id === attempt.agent_run_id)}
              events={detail.events
                .filter((event) => event.run_id === attempt.agent_run_id)
                .slice(-5)}
            />
          )}
        />
      ) : tab === "history" ? (
        <ImportedHistory history={workspace.history} detail={detail} />
      ) : tab === "chat" ? (
        <div className="viber-conversation-pane">
          <div className="viber-chat-heading">
            <label>
              Chat with
              <select
                aria-label="Chat with Viber"
                value={chatNode?.id || ""}
                onChange={(event) => setSelected(event.target.value)}
              >
                {agentNodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.name}
                  </option>
                ))}
              </select>
            </label>
            <span className="subtle">{run ? `Graph: ${run.status}` : "Graph: draft"}</span>
            {chatNode && (
              <Button
                size="sm"
                onClick={() => {
                  setSelected(chatNode.id);
                  setTab("canvas");
                }}
              >
                Open in flow
              </Button>
            )}
          </div>
          {workspace.capabilities?.conversations === 1 && chatNode ? (
            <ViberConversation
              key={viberConversationKey(task.id, chatNode.id, chatNode.profile_id)}
              detail={detail}
              workspace={workspace}
              node={chatNode}
              profile={profiles.find((profile) => profile.id === chatNode.profile_id)}
              revision={revision}
              disabled={
                active ||
                dirty ||
                task.status === "completed" ||
                (!!detail.active && !conversationActive)
              }
              busy={busy}
              action={action}
              output={() => setTab("logs")}
            />
          ) : (
            <p className="empty-row">
              {!chatNode
                ? "Add a Viber to this flow to start its conversation."
                : "Update the execution helper to chat with individual Vibers."}
            </p>
          )}
        </div>
      ) : tab === "files" ? (
        task.workspace_kind === "managed" ? (
          <ManagedFiles taskId={task.id} revision={revision} />
        ) : (
          <ChangesView task={task} diff={diff} revision={revision} onError={onError} />
        )
      ) : tab === "usage" ? (
        <UsageView taskId={task.id} records={detail.usage} />
      ) : tab === "logs" ? (
        <LogView taskId={task.id} runs={detail.runs} events={detail.events} />
      ) : tab === "activity" ? (
        <div className="flow-activity">
          <h2>{draft.nodes.find((node) => node.id === selected)?.name || "Node"} activity</h2>
          <AgentTimeline
            runs={selectedRuns}
            events={detail.events.filter((event) => selectedRunIds.has(event.run_id))}
            messages={messages.filter(
              (message) => message.run_id && selectedRunIds.has(message.run_id),
            )}
            compact
          />
          {selectedAttempts.map((attempt) => (
            <details key={attempt.id}>
              <summary>
                {workspace.conversations.some((run) => run.id === attempt.run_id)
                  ? "Conversation turn"
                  : "Graph attempt"}{" "}
                {attempt.ordinal} · {attempt.status} · checks {attempt.verification}
              </summary>
              <pre>{JSON.stringify(attempt, null, 2)}</pre>
            </details>
          ))}
        </div>
      ) : (
        <div className="flow-activity">
          <h2>Checks and observed commands</h2>
          <p>
            Process completion and recorded passing checks are separate. Missing, failed and stale
            checks remain visible in each node attempt.
          </p>
          {task.repo_id && task.worktree_path && (
            <BrowserEnvironment
              task={task}
              unavailable={busy || active || !!detail.active}
              onError={onError}
            />
          )}
          <CommandRuns
            detail={detail}
            attempts={[...workspace.attempts, ...workspace.conversation_attempts]}
          />
        </div>
      )}
    </div>
  );
};
