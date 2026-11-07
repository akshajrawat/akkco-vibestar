import {
  FlowDefinitionSchema,
  FlowNodeSchema,
  nodeDependencies,
  type FlowDefinition,
  type AgentProfile,
} from "../../../backend/flows/contracts";
import type { NodeAttempt } from "../../../backend/flows/run-contracts";

export const predecessors = (graph: FlowDefinition, nodeId: string) => {
  const seen = new Set<string>();
  const pending = [nodeId];
  while (pending.length) {
    const id = pending.pop()!;
    for (const edge of graph.edges.filter((edge) => edge.target === id)) {
      if (seen.has(edge.source)) continue;
      seen.add(edge.source);
      pending.push(edge.source);
    }
  }

  return seen;
};

/** Removing dependencies also removes input references that no longer have a valid source. */
export const pruneBindings = (graph: FlowDefinition): FlowDefinition => ({
  ...graph,
  nodes: graph.nodes.map((node) => {
    const sources = predecessors(graph, node.id);
    return {
      ...node,
      inputs: node.inputs.filter((input) => !("node_id" in input) || sources.has(input.node_id)),
    };
  }),
});

export const graphError = (graph: FlowDefinition) => {
  const result = FlowDefinitionSchema.safeParse(graph);
  return result.success ? "" : result.error.issues.map((issue) => issue.message).join(" ");
};

/** A changed result invalidates downstream results even when their instructions stay the same. */
export const staleNodes = (
  graph: FlowDefinition,
  captured: FlowDefinition | undefined,
  profiles: AgentProfile[],
  results: NodeAttempt[],
) => {
  const changed = new Set<string>();
  for (const node of graph.nodes) {
    const previous = results.filter((attempt) => attempt.node_id === node.id).at(-1);
    if (!previous) continue;

    const profile =
      node.type === "agent"
        ? profiles.find((profile) => profile.id === node.profile_id)
        : undefined;

    const parsed = FlowNodeSchema.safeParse(node);
    if (
      !parsed.success ||
      JSON.stringify(parsed.data) !== JSON.stringify(previous.configuration.node) ||
      (node.type === "agent" &&
        JSON.stringify(profile) !== JSON.stringify(previous.configuration.agent?.profile)) ||
      (captured &&
        JSON.stringify(nodeDependencies(captured, node.id)) !==
          JSON.stringify(nodeDependencies(graph, node.id)))
    )
      changed.add(node.id);
  }

  let count = -1;
  while (count !== changed.size) {
    count = changed.size;
    for (const edge of graph.edges) if (changed.has(edge.source)) changed.add(edge.target);
  }

  return changed;
};
