import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Pause, Square, ArrowLeft, Save, TerminalSquare } from "lucide-react";

import type {
  AgentProfile,
  CanvasLayoutSchema,
  FlowDefinition,
} from "../../../backend/flows/contracts";
import type { FlowWorkspace as Workspace } from "../../../backend/rpc/flows";
import type { z } from "zod";
import type { Detail, Diff, Repository } from "../../lib/types";
import { rpc, errorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { OpenInEditor } from "../../components/shared/OpenInEditor";
import { TaskTerminal } from "../../components/shared/TaskTerminal";
import { ChangesView } from "../../components/shared/ChangesView";
import { AgentTimeline } from "../chat/AgentTimeline";
import { LogView } from "../chat/LogView";
import { UsageView } from "../usage/UsageView";
import {
  useTaskView,
  updateTaskView,
  flowWorkspaceSections,
  type FlowWorkspaceSection,
} from "../../lib/taskView";
import { FlowCanvas } from "./FlowCanvas";
import { ViberConversation, viberConversationKey } from "./ViberConversation";
import { graphError } from "./graph";
import type { ContinuationPlan } from "../../../backend/flows/continuation";
import { ContinuationDialog } from "./ContinuationDialog";
import { ProfileEditor } from "./ProfileEditor";
import { ManagedFiles } from "./ManagedFiles";
import { ImportedHistory } from "./ImportedHistory";
import type { FlowInputChoice } from "./FlowInspector";
import { CommandRuns } from "../verification/CommandRuns";
import { BrowserEnvironment } from "../verification/BrowserEnvironment";
import { BottomDock } from "../../components/shared/BottomDock";
import { useWorkspaceKeys } from "../../hooks/useWorkspaceKeys";

export const FlowWorkspace = ({
  detail,
  repository,
  revision,
  onError,
  back,
}: {
  detail: Detail;
  repository?: Repository;
  revision: number;
  onError: (error: string) => void;
  back: () => void;
}) => {
  const task = detail.task;
  const view = useTaskView(task.id);
  useWorkspaceKeys(task.id);
  const [workspace, setWorkspace] = useState<Workspace>();
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [draft, setDraft] = useState<FlowDefinition>();
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const baseRevision = useRef(0);
  const tab = view.flowSection;
  const setTab = (flowSection: FlowWorkspaceSection) => updateTaskView(task.id, { flowSection });
  const selected = view.flowNode || undefined;
  const setSelected = (flowNode: string) => updateTaskView(task.id, { flowNode });
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [edit, setEdit] = useState<AgentProfile>();
  const [continuation, setContinuation] = useState<ContinuationPlan>();
  const continuationRequest = useRef<string | undefined>(undefined);
  const [localError, setLocalError] = useState("");
  const pendingLayout = useRef<z.infer<typeof CanvasLayoutSchema> | undefined>(undefined);
  const request = useRef({ signature: "", id: "" });

  const load = useCallback(async () => {
    const [next, savedProfiles] = await Promise.all([
      rpc<Workspace>("flow.workspace", { task_id: task.id }),
      rpc<AgentProfile[]>("profile.list"),
    ]);

    setWorkspace(next);
    setProfiles(savedProfiles);
    if (!dirtyRef.current) {
      setDraft(next.revision.definition);
      baseRevision.current = next.revision.revision;
    }
  }, [task.id]);

  useEffect(() => {
    let alive = true;

    void Promise.all([
      rpc<Workspace>("flow.workspace", { task_id: task.id }),
      rpc<AgentProfile[]>("profile.list"),
    ])
      .then(([next, savedProfiles]) => {
        if (!alive) return;
        setWorkspace(next);
        setProfiles(savedProfiles);
        if (!dirtyRef.current) {
          setDraft(next.revision.definition);
          baseRevision.current = next.revision.revision;
        }
      })
      .catch((reason) => {
        if (alive) setLocalError(errorMessage(reason));
      });

    return () => {
      alive = false;
    };
  }, [task.id, revision]);

  useEffect(() => {
    if (task.workspace_kind === "managed" || !task.worktree_path || tab !== "files") return;
    let alive = true;

    void rpc<Diff>("task.diff", { id: task.id })
      .then((value) => {
        if (alive) setDiff(value);
      })
      .catch((reason) => {
        if (alive) setLocalError(errorMessage(reason));
      });

    return () => {
      alive = false;
    };
  }, [task.id, task.workspace_kind, task.worktree_path, revision, tab]);

  const action = async (method: string, params: unknown) => {
    setBusy(true);
    setLocalError("");
    try {
      await rpc(method, params);
      await load();
      return true;
    } catch (reason) {
      setLocalError(errorMessage(reason));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!workspace || !draft)
    return <div className="empty-row">{localError || "Opening Viber workspace…"}</div>;
  const run = workspace.runs[0];
  const active = !!run && ["queued", "running", "pausing"].includes(run.status);

  const checkpoint =
    run?.origin === "historical" &&
    !workspace.attempts.some((attempt) => attempt.run_id === run.id);

  const change = (next: FlowDefinition) => {
    dirtyRef.current = true;
    setDirty(true);
    setDraft(next);
  };

  const validation = graphError(draft);

  const selectedAttempts = [...workspace.attempts, ...workspace.conversation_attempts]
    .filter((attempt) => attempt.node_id === selected)
    .sort((a, b) => a.started_at.localeCompare(b.started_at));

  const selectedRunIds = new Set(selectedAttempts.map((attempt) => attempt.agent_run_id));
  const selectedRuns = detail.runs.filter((run) => selectedRunIds.has(run.id));
  const agentNodes = workspace.revision.definition.nodes.filter((node) => node.type === "agent");
  const chatNode = agentNodes.find((node) => node.id === selected) || agentNodes[0];

  const conversationActive = workspace.conversations.some((turn) =>
    ["queued", "running", "pausing", "paused"].includes(turn.status),
  );

  const messages = detail.messages.filter((message) => message.purpose === "chat");

  const saveLayout = (layout: z.infer<typeof CanvasLayoutSchema>) => {
    pendingLayout.current = layout;
    const savedNodes = new Set(workspace.revision.definition.nodes.map((node) => node.id));

    void rpc("flow.layout", {
      task_id: task.id,
      layout: {
        ...layout,
        positions: Object.fromEntries(
          Object.entries(layout.positions).filter(([id]) => savedNodes.has(id)),
        ),
      },
    }).catch((reason) => setLocalError(errorMessage(reason)));
  };

  const save = async () => {
    if (validation) {
      setLocalError(validation);
      return;
    }

    setBusy(true);
    setLocalError("");
    try {
      await rpc("flow.save", {
        task_id: task.id,
        definition: draft,
        expected_revision: baseRevision.current,
      });

      dirtyRef.current = false;
      setDirty(false);
      if (pendingLayout.current)
        await rpc("flow.layout", { task_id: task.id, layout: pendingLayout.current });
      await load();
    } catch (reason) {
      setLocalError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const explicitStart = () => {
    const params = {
      flow_id: task.flow_id,
      task_id: task.id,
      revision: workspace.revision.revision,
      goal: task.goal,
      ...(run && ["paused", "failed", "interrupted", "cancelled"].includes(run.status)
        ? { parent_run_id: run.id }
        : {}),
    };

    const signature = JSON.stringify(params);
    if (request.current.signature !== signature)
      request.current = { signature, id: crypto.randomUUID() };

    void action("flow.start", { ...params, request_id: request.current.id }).then((success) => {
      if (success) request.current = { signature: "", id: "" };
    });
  };

  const previewContinuation = async () => {
    if (!run) return;
    setBusy(true);
    setLocalError("");
    try {
      const plan = await rpc<ContinuationPlan>("flow.continuation.preview", {
        run_id: run.id,
        revision: workspace.revision.revision,
      });

      continuationRequest.current = crypto.randomUUID();
      setContinuation(plan);
    } catch (reason) {
      setLocalError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`workspace viber-workspace ${view.terminalDock && view.dockMaximized ? "dock-maximized" : ""}`}
    >
      <header className="viber-workspace-header">
        <Button size="icon" variant="ghost" aria-label="Back to tasks" onClick={back}>
          <ArrowLeft size={16} />
        </Button>
        <div>
          <strong title={task.goal}>{task.goal}</strong>
          <small>
            {repository ? `${repository.owner}/${repository.name}` : "Managed workspace"} ·{" "}
            {run ? `Run ${run.status} · captured revision ${run.revision}` : "Draft"} · saved
            revision {workspace.revision.revision}
          </small>
        </div>
        <span className="spacer" />
        <OpenInEditor
          id={task.id}
          kind="task"
          path={task.worktree_path}
          disabled={!task.worktree_path}
        />
        <Button
          disabled={busy || active || conversationActive || run?.status === "waiting"}
          size="sm"
          onClick={() =>
            void action("task.lifecycle", {
              task_id: task.id,
              action: task.status === "completed" ? "reopen" : "finish",
            })
          }
        >
          {task.status === "completed" ? "Reopen task" : "Finish task"}
        </Button>
      </header>
      <div className="flow-toolbar">
        <nav aria-label="Viber workspace views">
          {["canvas", "chat", "files", "checks", "usage", "logs", "history"].map((value) => (
            <button
              key={value}
              aria-current={tab === value ? "page" : undefined}
              onClick={() => setTab(value as FlowWorkspaceSection)}
            >
              {flowWorkspaceSections[value as FlowWorkspaceSection]}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        {dirty && (
          <Button size="sm" disabled={busy || !!validation} onClick={() => void save()}>
            <Save size={13} />
            Save draft
          </Button>
        )}
        {run &&
          (run.status === "paused" ||
            (checkpoint &&
              ["waiting", "interrupted", "failed", "cancelled"].includes(run.status))) && (
            <Button
              size="sm"
              disabled={busy || dirty || conversationActive || task.status === "completed"}
              onClick={() =>
                void action("flow.continue", { run_id: run.id, request_id: crypto.randomUUID() })
              }
            >
              <Play size={13} />
              {checkpoint ? "Inspect / continue historical checkpoint" : "Continue captured run"}
            </Button>
          )}
        {workspace.capabilities?.continuations === 1 &&
          run &&
          ["paused", "failed", "interrupted", "cancelled", "completed"].includes(run.status) && (
            <Button
              size="sm"
              disabled={busy || dirty || conversationActive || task.status === "completed"}
              onClick={() => void previewContinuation()}
            >
              Apply saved revision…
            </Button>
          )}
        {(active || run?.status === "waiting") && run && (
          <Button
            size="sm"
            disabled={busy || run.status === "pausing"}
            onClick={() => void action("flow.pause", { run_id: run.id })}
          >
            <Pause size={13} />
            {run.status === "pausing" ? "Pausing…" : "Pause"}
          </Button>
        )}
        {run && ["queued", "running", "pausing", "paused", "waiting"].includes(run.status) && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void action("flow.cancel", { run_id: run.id })}
          >
            <Square size={12} />
            Stop
          </Button>
        )}
        <Button
          variant="default"
          size="sm"
          disabled={
            busy ||
            active ||
            conversationActive ||
            dirty ||
            !draft.nodes.length ||
            run?.status === "waiting" ||
            task.status === "completed"
          }
          onClick={explicitStart}
        >
          <Play size={13} />
          {run?.status === "paused" ? "Run saved revision anew" : "Run flow"}
        </Button>
      </div>
      {(localError || validation) && (
        <p className="flow-inline-error" role="alert">
          {localError || validation}
        </p>
      )}
      {dirty && (
        <p className="flow-draft-notice">
          Unsaved draft · started attempts keep their captured settings. Save, pause and run the
          saved revision to apply execution changes.
        </p>
      )}
      {run?.error && <p className="flow-inline-error">{run.error}</p>}
      {workspace.history && (
        <p className="flow-draft-notice">
          Imported from {workspace.history.migration.original_status}. Earlier results remain in
          History. Continuing captures current inputs for a new attempt; past approval decisions are
          unknown.
        </p>
      )}
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
            editProfile={setEdit}
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
      <footer className="viber-workspace-footer">
        <span>
          {task.worktree_path
            ? task.branch_name || "Owned managed files"
            : "Workspace will prepare on execution"}
        </span>
        <span className="spacer" />
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            updateTaskView(task.id, {
              terminalDock: !(view.terminalDock && view.dockTab === "Terminal"),
              dockTab: "Terminal",
            })
          }
          aria-expanded={view.terminalDock && view.dockTab === "Terminal"}
        >
          <TerminalSquare size={13} />
          Terminal
        </Button>
      </footer>
      <BottomDock
        id={task.id}
        terminal={(active, focusRequest) => (
          <TaskTerminal task={task} onError={onError} active={active} focusRequest={focusRequest} />
        )}
        problems={
          <div className="flow-activity">
            <h3>Flow problems</h3>
            <p>{run?.error || "No saved run error."}</p>
            {[...workspace.attempts, ...workspace.conversation_attempts]
              .filter((attempt) => attempt.error)
              .map((attempt) => (
                <p key={attempt.id}>
                  {attempt.configuration.node.name}: {attempt.error}
                </p>
              ))}
            {detail.tests
              .filter((test) => ["failed", "interrupted"].includes(test.status))
              .map((test) => (
                <p key={test.id}>
                  {test.status} · {test.command}
                </p>
              ))}
          </div>
        }
      />
      {edit && (
        <ProfileEditor
          profile={edit}
          close={() => setEdit(undefined)}
          saved={() => {
            void load().catch((reason) => setLocalError(errorMessage(reason)));
          }}
        />
      )}
      {continuation && (
        <ContinuationDialog
          plan={continuation}
          busy={busy}
          close={() => setContinuation(undefined)}
          apply={() => {
            void action("flow.continuation.apply", {
              run_id: continuation.parent_run_id,
              revision: continuation.revision,
              plan_hash: continuation.hash,
              request_id: continuationRequest.current,
            }).then((success) => {
              if (success) setContinuation(undefined);
            });
          }}
        />
      )}
    </div>
  );
};
