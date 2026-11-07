import type { FlowDefinition, FlowNode } from "./contracts";

export const builtInProfiles = {
  planner: "e1bc5ab8-3a96-4d53-96c5-3103cf484501",
  refiner: "e1bc5ab8-3a96-4d53-96c5-3103cf484502",
  implementer: "e1bc5ab8-3a96-4d53-96c5-3103cf484503",
  reviewer: "e1bc5ab8-3a96-4d53-96c5-3103cf484504",
} as const;

export const flowTemplates = [
  { id: "plan-build", name: "Planner → Implementer", description: "Plan, approve, then build." },
  {
    id: "build-review",
    name: "Implementer → Reviewer",
    description: "Build and request an independent read-only review.",
  },
  {
    id: "full",
    name: "Full contribution flow",
    description: "Plan, refine, implement and review with approval pauses.",
  },
] as const;

export type TemplateId = (typeof flowTemplates)[number]["id"];

/** Templates are editable configurations. Instantiating one never authorizes execution. */
export const instantiateTemplate = (id: TemplateId, identity: () => string): FlowDefinition => {
  const nodes: FlowNode[] = [];
  const edges: FlowDefinition["edges"] = [];

  const append = (node: FlowNode) => {
    const previous = nodes.at(-1);
    if (previous) {
      edges.push({ id: identity(), source: previous.id, target: node.id });
      node.inputs.push({ kind: "output", node_id: previous.id });
    }

    nodes.push(node);
  };

  const agent = (role: keyof typeof builtInProfiles, name: string) =>
    append({
      id: identity(),
      type: "agent",
      name,
      profile_id: builtInProfiles[role],
      instructions: "",
      overrides: {},
      inputs: [{ kind: "task-goal" }],
      completion: {
        verification: "record-only",
        review: role === "reviewer" ? "require-approved" : "none",
      },
    });

  const approval = (name: string) =>
    append({
      id: identity(),
      type: "approval",
      name,
      instructions: "Inspect the selected result before continuing.",
      inputs: [],
    });

  if (id === "plan-build" || id === "full") {
    agent("planner", "Planner");
    approval("Approve plan");
  }

  if (id === "full") {
    agent("refiner", "Refiner");
    approval("Approve refined plan");
  }

  agent("implementer", "Implementer");
  if (id === "full") {
    const implementation = nodes.at(-1)!;
    if (implementation.type === "agent") {
      implementation.overrides = { output: "implementation" };
      implementation.completion.verification = "require-passing";
    }
  }

  if (id !== "plan-build") {
    if (id === "full") approval("Approve implementation");
    agent("reviewer", "Reviewer");
    if (id === "full") approval("Accept review");
  }

  // An approval's output is its decision. Agents also receive the result being approved.
  for (const [index, node] of nodes.entries()) {
    if (node.type === "agent" && nodes[index - 1]?.type === "approval" && nodes[index - 2])
      node.inputs.push({ kind: "output", node_id: nodes[index - 2].id });
  }

  return { name: flowTemplates.find((template) => template.id === id)!.name, nodes, edges };
};
