import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Check, CircleAlert, Clock3, TerminalSquare, ShieldCheck } from "lucide-react";

import type { AgentProfile, FlowNode } from "../../../backend/flows/contracts";
import type { NodeAttempt } from "../../../backend/flows/run-contracts";
import { ProviderIcon } from "../../components/ui/ProviderIcon";
import { ViberFace } from "./ViberFace";

export type ViberCanvasNode = Node<
  {
    node: FlowNode;
    profile?: AgentProfile;
    attempt?: NodeAttempt;
    stale: boolean;
    reused?: boolean;
    conversation?: string;
  },
  "viber"
>;

const ViberNode = ({ data, selected }: NodeProps<ViberCanvasNode>) => {
  const { node, profile, attempt, stale } = data;
  const observed = attempt?.status || "draft";
  const status = stale && !["running", "waiting"].includes(observed) ? "stale" : observed;

  const execution =
    attempt?.configuration.agent?.execution ||
    (node.type === "agent" && profile ? { ...profile.execution, ...node.overrides } : null);

  return (
    <div
      className={`viber-node ${node.type} ${status} ${data.conversation ? "chatting" : ""} ${stale ? "stale" : ""} ${selected ? "selected" : ""}`}
    >
      <div className="viber-shell">
        <Handle type="target" position={Position.Left} aria-label="Input connection" />
        {node.type === "agent" ? (
          <ViberFace />
        ) : node.type === "command" ? (
          <TerminalSquare size={30} />
        ) : (
          <ShieldCheck size={30} />
        )}
        <Handle type="source" position={Position.Right} aria-label="Output connection" />
      </div>
      <strong>{node.name}</strong>
      <span className="viber-identity">
        {execution ? (
          <>
            <ProviderIcon provider={execution.provider} model={execution.model} size={12} />
            {execution.provider} · {execution.model || "CLI default"}
          </>
        ) : node.type === "command" ? (
          node.argv[0]
        ) : (
          "Your decision"
        )}
      </span>
      {data.conversation && <small className="viber-chat-state">Chat · {data.conversation}</small>}
      <span className={`viber-state ${status}`}>
        {status === "completed" ? (
          <Check size={11} />
        ) : ["failed", "rejected", "interrupted"].includes(status) ? (
          <CircleAlert size={11} />
        ) : (
          <Clock3 size={11} />
        )}
        {data.reused && status === "completed"
          ? "Reused · completed"
          : status === "running"
            ? "Working"
            : status === "waiting"
              ? "Needs approval"
              : status === "stale"
                ? "Draft changed"
                : status}
        {stale && ["running", "waiting"].includes(observed) && " · draft changed"}
      </span>
    </div>
  );
};

export const viberNodeTypes = { viber: ViberNode };
