import { useEffect, useState, type ReactNode } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MarkerType,
  applyNodeChanges,
  useReactFlow,
  type Viewport,
} from "@xyflow/react";
import { Plus, TerminalSquare, ShieldCheck } from "lucide-react";

import type {
  AgentProfile,
  CanvasLayoutSchema,
  FlowDefinition,
  FlowNode,
} from "../../../backend/flows/contracts";
import type { FlowWorkspace } from "../../../backend/flows/workspace";
import { flowTemplates, instantiateTemplate } from "../../../backend/flows/templates";
import type { NodeAttempt } from "../../../backend/flows/run-contracts";
import type { z } from "zod";
import { Button } from "../../components/ui/button";
import { FlowInspector, type FlowInputChoice } from "./FlowInspector";
import { graphError, pruneBindings, staleNodes } from "./graph";
import { ViberFace } from "./ViberFace";
import { viberNodeTypes, type ViberCanvasNode } from "./ViberNode";

type Layout = z.infer<typeof CanvasLayoutSchema>;

interface CanvasProps {
  workspace: FlowWorkspace;
  profiles: AgentProfile[];
  draft: FlowDefinition;
  change: (draft: FlowDefinition) => void;
  layout: (layout: Layout) => void;
  selected?: string;
  select: (id: string) => void;
  action: (method: string, params: unknown) => void;
  activity: () => void;
  chat?: () => void;
  editProfile: (profile: AgentProfile) => void;
  controlsDisabled: boolean;
  activityFor: (attempt: NodeAttempt) => ReactNode;
  contextChoices?: FlowInputChoice[];
}

export const FlowCanvas = (props: CanvasProps) => (
  <ReactFlowProvider>
    <Canvas {...props} />
  </ReactFlowProvider>
);

const Canvas = ({
  workspace,
  profiles,
  draft,
  change,
  layout,
  selected,
  select,
  action,
  activity,
  chat,
  editProfile,
  controlsDisabled,
  activityFor,
  contextChoices,
}: CanvasProps) => {
  const flow = useReactFlow<ViberCanvasNode>();
  const run = workspace.runs[0];
  const [error, setError] = useState("");
  const [nodes, setNodes] = useState<ViberCanvasNode[]>([]);
  const [selectedEdges, setSelectedEdges] = useState(new Set<string>());

  const [viewport, setViewport] = useState<Viewport>(
    workspace.layout?.viewport || { x: 40, y: 80, zoom: 1 },
  );

  const attempts =
    (run && workspace.results?.[run.id]) ||
    workspace.attempts.filter((attempt) => attempt.run_id === run?.id);

  const attemptFor = (id: string) => attempts.filter((attempt) => attempt.node_id === id).at(-1);

  useEffect(() => {
    const currentRun = workspace.runs[0];

    const results =
      (currentRun && workspace.results?.[currentRun.id]) ||
      workspace.attempts.filter((attempt) => attempt.run_id === currentRun?.id);

    const stale = staleNodes(
      draft,
      currentRun && workspace.definitions?.[currentRun.id],
      profiles,
      results,
    );

    for (const result of (currentRun && workspace.stale_results?.[currentRun.id]) || [])
      stale.add(result.node_id);

    setNodes((current) =>
      draft.nodes.map((node, index) => {
        const existing = current.find((item) => item.id === node.id);

        const attempt = results.filter((item) => item.node_id === node.id).at(-1);

        const profile =
          node.type === "agent" ? profiles.find((item) => item.id === node.profile_id) : undefined;

        const conversation = workspace.conversations.find(
          (run) =>
            run.snapshot.conversation?.node_id === node.id &&
            node.type === "agent" &&
            run.snapshot.agents[node.id]?.profile.id === node.profile_id &&
            ["queued", "running", "pausing", "paused"].includes(run.status),
        );

        return {
          id: node.id,
          type: "viber",
          position: existing?.position ||
            workspace.layout?.positions[node.id] || {
              x: (index % 4) * 240,
              y: Math.floor(index / 4) * 215,
            },
          selected: node.id === selected,
          ariaLabel: `${node.name}, ${attempt?.status || "draft"}${conversation ? `, chat ${conversation.status}` : ""}`,
          data: {
            node,
            profile,
            attempt,
            stale: !!attempt && stale.has(node.id),
            reused: !!attempt && attempt.run_id !== currentRun?.id,
            conversation: conversation?.status,
          },
        };
      }),
    );
  }, [draft, workspace, profiles, selected]);

  const saveLayout = (next = nodes, nextViewport = viewport) =>
    layout({
      positions: Object.fromEntries(next.map((node) => [node.id, node.position])),
      viewport: nextViewport,
    });

  const replace = (next: FlowDefinition) => {
    change(pruneBindings(next));
    setError("");
  };

  const remove = (ids: string[]) =>
    replace({
      ...draft,
      nodes: draft.nodes.filter((node) => !ids.includes(node.id)),
      edges: draft.edges.filter((edge) => !ids.includes(edge.source) && !ids.includes(edge.target)),
    });

  const connect = (source: string, target: string, replacing?: string) => {
    const next = {
      ...draft,
      edges: [
        ...draft.edges.filter((edge) => edge.id !== replacing),
        { id: replacing || crypto.randomUUID(), source, target },
      ],
    };

    const issue = graphError(pruneBindings(next));
    if (issue) setError(issue);
    else replace(next);
  };

  const add = (
    type: FlowNode["type"],
    profile?: AgentProfile,
    position?: { x: number; y: number },
  ) => {
    const base = {
      id: crypto.randomUUID(),
      name: profile?.name || (type === "command" ? "Command" : "Approval"),
      inputs: [{ kind: "task-goal" as const }],
    };

    const node: FlowNode =
      type === "agent" && profile
        ? {
            ...base,
            type: "agent",
            profile_id: profile.id,
            instructions: "",
            overrides: {},
            completion: { verification: "record-only", review: "none" },
          }
        : type === "command"
          ? {
              ...base,
              type: "command",
              argv: ["node", "--version"],
              access: "read-only",
              timeout_secs: 120,
            }
          : {
              ...base,
              type: "approval",
              instructions: "Inspect the selected inputs before continuing.",
            };

    const point =
      position ||
      flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });

    setNodes((current) => [
      ...current,
      { id: node.id, type: "viber", position: point, data: { node, profile, stale: false } },
    ]);

    replace({ ...draft, nodes: [...draft.nodes, node] });
    select(node.id);
  };

  const node = draft.nodes.find((item) => item.id === selected);
  const attempt = node && attemptFor(node.id);

  const conversationAttempt =
    node?.type === "agent"
      ? workspace.conversation_attempts.find(
          (attempt) =>
            attempt.node_id === node.id &&
            attempt.configuration.agent?.profile.id === node.profile_id &&
            attempt.status === "running",
        )
      : undefined;

  const activeAttempt = attempt?.status === "running" ? attempt : conversationAttempt;

  const request = (method: string, extra: object = {}) => {
    if (!run || !node) {
      setError("Start a flow run before running individual nodes.");
      return;
    }

    action(method, { run_id: run.id, node_id: node.id, request_id: crypto.randomUUID(), ...extra });
  };

  return (
    <div className="flow-editor">
      <aside className="flow-palette" aria-label="Flow palette">
        <div className="flow-palette-heading">
          THE VIBERS<small>Your crew, your flow.</small>
        </div>
        {profiles.map((profile) => (
          <button
            key={profile.id}
            className="flow-palette-viber"
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData("application/vibestar-profile", profile.id);
              event.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => add("agent", profile)}
          >
            <ViberFace />
            <span>
              <strong>{profile.name}</strong>
              <small>
                {profile.execution.provider} · {profile.execution.access}
              </small>
            </span>
            <Plus size={12} />
          </button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          disabled={!profiles.length}
          onClick={() =>
            editProfile({ ...profiles[0], id: crypto.randomUUID(), revision: 0, name: "New Viber" })
          }
        >
          <Plus size={12} />
          New Viber profile
        </Button>
        <span className="flow-palette-label">BUILDING BLOCKS</span>
        <Button onClick={() => add("command")}>
          <TerminalSquare size={14} />
          Command
        </Button>
        <Button onClick={() => add("approval")}>
          <ShieldCheck size={14} />
          Approval
        </Button>
        <span className="flow-palette-label">STARTING TEMPLATES</span>
        {flowTemplates.map((template) => (
          <button
            key={template.id}
            className="flow-template"
            onClick={() => {
              replace(instantiateTemplate(template.id, () => crypto.randomUUID()));
            }}
          >
            <strong>{template.name}</strong>
            <small>{template.description}</small>
          </button>
        ))}
      </aside>
      <div
        className="flow-canvas"
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          event.preventDefault();

          const profile = profiles.find(
            (item) => item.id === event.dataTransfer.getData("application/vibestar-profile"),
          );

          if (profile)
            add(
              "agent",
              profile,
              flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
            );
        }}
      >
        <ReactFlow<ViberCanvasNode>
          nodes={nodes}
          edges={draft.edges.map((edge) => ({
            ...edge,
            selected: selectedEdges.has(edge.id),
            animated: attemptFor(edge.source)?.status === "running",
            markerEnd: { type: MarkerType.ArrowClosed },
            type: "smoothstep",
          }))}
          nodeTypes={viberNodeTypes}
          onNodesChange={(changes) => {
            const deleted = changes
              .filter((change) => change.type === "remove")
              .map((change) => change.id);

            const next = applyNodeChanges(changes, nodes);
            setNodes(next);
            if (changes.some((change) => change.type === "position" && change.dragging !== true))
              saveLayout(next);
            if (deleted.length) remove(deleted);
          }}
          onEdgesChange={(changes) => {
            setSelectedEdges((current) => {
              const next = new Set(current);
              for (const change of changes) {
                if (change.type !== "select") continue;
                if (change.selected) next.add(change.id);
                else next.delete(change.id);
              }

              return next;
            });

            const removed = changes
              .filter((change) => change.type === "remove")
              .map((change) => change.id);

            if (removed.length)
              replace({
                ...draft,
                edges: draft.edges.filter((edge) => !removed.includes(edge.id)),
              });
          }}
          onNodeClick={(_, node) => select(node.id)}
          onNodeDoubleClick={(_, node) => {
            select(node.id);
            if (node.data.node.type === "agent") chat?.();
            else activity();
          }}
          onNodeDragStop={(_, node, dragged) =>
            saveLayout(
              nodes.map(
                (item) =>
                  dragged.find((value) => value.id === item.id) ||
                  (item.id === node.id ? node : item),
              ),
            )
          }
          onMoveEnd={(_, value) => {
            setViewport(value);
            saveLayout(nodes, value);
          }}
          onConnect={(connection) => connect(connection.source, connection.target)}
          onReconnect={(edge, connection) => connect(connection.source, connection.target, edge.id)}
          isValidConnection={(connection) =>
            !graphError({
              ...draft,
              edges: [
                ...draft.edges,
                { id: crypto.randomUUID(), source: connection.source, target: connection.target },
              ],
            })
          }
          defaultViewport={viewport}
          minZoom={0.1}
          maxZoom={4}
          fitView={!workspace.layout}
          fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
          deleteKeyCode={["Backspace", "Delete"]}
          edgesReconnectable
          nodesFocusable
          edgesFocusable
        >
          <Background color="var(--border-default)" gap={22} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
        {!draft.nodes.length && (
          <div className="flow-empty">
            <ViberFace />
            <h2>Give your ideas a crew.</h2>
            <p>Add a Viber or start with a template.</p>
          </div>
        )}
        {error && (
          <p className="flow-validation" role="alert">
            {error}
          </p>
        )}
        <div className="flow-canvas-caption">
          Connect ports to set dependencies · Select a Viber to choose its inputs
        </div>
      </div>
      {node ? (
        <FlowInspector
          contextChoices={contextChoices}
          activityPreview={activeAttempt ? activityFor(activeAttempt) : undefined}
          controlsDisabled={controlsDisabled}
          node={node}
          graph={draft}
          profiles={profiles}
          attempt={attempt}
          update={(updated) =>
            change({
              ...draft,
              nodes: draft.nodes.map((item) => (item.id === node.id ? updated : item)),
            })
          }
          remove={() => remove([node.id])}
          duplicate={() => {
            const clone = {
              ...node,
              id: crypto.randomUUID(),
              name: `${node.name.slice(0, 90)} copy`,
            };

            replace({
              ...draft,
              nodes: [...draft.nodes, clone],
              edges: [
                ...draft.edges,
                ...draft.edges
                  .filter((edge) => edge.target === node.id)
                  .map((edge) => ({ ...edge, id: crypto.randomUUID(), target: clone.id })),
              ],
            });

            select(clone.id);
          }}
          run={() => request("flow.node.run")}
          retry={() => request("flow.node.retry", { attempt_id: attempt?.id })}
          approve={(decision) => {
            if (attempt)
              action("flow.node.approve", {
                attempt_id: attempt.id,
                request_id: crypto.randomUUID(),
                decision,
                configuration_hash: attempt.configuration_hash,
                inputs_hash: attempt.inputs_hash,
                workspace_fingerprint: attempt.workspace_fingerprint,
              });
          }}
          activity={activity}
          chat={chat}
          editProfile={editProfile}
        />
      ) : (
        <aside className="flow-inspector flow-inspector-empty">
          <ViberFace />
          <p>Select a Viber</p>
          <small>Instructions, inputs, access and real activity live here.</small>
        </aside>
      )}
    </div>
  );
};
