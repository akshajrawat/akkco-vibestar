import { z } from "zod";

import { AgentExecutionSchema, WorkspaceAccessSchema } from "../execution/contracts";

const identity = z.string().uuid();
const instructions = z.string().max(32000);

export const GeneralTaskCreateSchema = z
  .object({
    request_id: identity,
    goal: z.string().trim().min(1).max(32000),
    repository_id: identity.nullable().default(null),
    profile_id: identity,
    template: z.enum(["plan-build", "build-review", "full"]).optional(),
  })
  .strict();

export const IssueTaskCreateSchema = z
  .object({
    request_id: identity,
    repository_id: identity,
    issue_url: z.string().min(1).max(2000),
    scope_mode: z.enum(["whole_issue", "partial"]),
    claimed_scope: z.string().max(1000).default(""),
    notes: instructions.default(""),
    profile_id: identity,
    template: GeneralTaskCreateSchema.shape.template,
  })
  .strict();

// Custom runtime schemas belong to trusted internal utility callers, not saved graphs.
const FlowExecutionSchema = AgentExecutionSchema.extend({
  output: AgentExecutionSchema.shape.output.exclude(["custom"]),
});

export const AgentProfileSchema = z
  .object({
    id: identity,
    revision: z.number().int().positive(),
    name: z.string().trim().min(1).max(100),
    instructions,
    execution: FlowExecutionSchema,
    supported_access: z.array(WorkspaceAccessSchema).min(1).max(2),
  })
  .strict()
  .superRefine((profile, context) => {
    if (!profile.supported_access.includes(profile.execution.access))
      context.addIssue({
        code: "custom",
        path: ["execution", "access"],
        message: "The profile's default access must be supported by that profile.",
      });
    if (new Set(profile.supported_access).size !== profile.supported_access.length)
      context.addIssue({
        code: "custom",
        path: ["supported_access"],
        message: "Supported access levels must be unique.",
      });
  });

export const InputBindingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task-goal") }).strict(),
  z.object({ kind: z.literal("task-brief") }).strict(),
  z.object({ kind: z.literal("repository") }).strict(),
  z.object({ kind: z.literal("issue") }).strict(),
  z.object({ kind: z.literal("output"), node_id: identity }).strict(),
  z.object({ kind: z.literal("verification"), node_id: identity }).strict(),
  z.object({ kind: z.literal("attempt-output"), attempt_id: identity }).strict(),
  z.object({ kind: z.literal("attempt-verification"), attempt_id: identity }).strict(),
  z.object({ kind: z.literal("artifact"), artifact_id: identity }).strict(),
  z.object({ kind: z.literal("message"), message_id: identity }).strict(),
  z
    .object({ kind: z.literal("command-evidence"), run_id: z.string().min(1).max(100).nullable() })
    .strict(),
]);

const nodeFields = {
  id: identity,
  name: z.string().trim().min(1).max(100),
  inputs: z.array(InputBindingSchema).max(100),
};

export const FlowNodeSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...nodeFields,
      type: z.literal("agent"),
      profile_id: identity,
      instructions,
      overrides: FlowExecutionSchema.partial(),
      completion: z
        .object({
          verification: z.enum(["record-only", "require-passing"]),
          review: z.enum(["none", "require-approved"]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...nodeFields,
      type: z.literal("command"),
      argv: z
        .array(
          z
            .string()
            .max(16000)
            .refine((value) => !value.includes("\0"), "Arguments cannot contain NUL."),
        )
        .min(1)
        .max(100)
        .refine((argv) => !!argv[0]?.trim(), "A command program is required.")
        .refine(
          (argv) => new TextEncoder().encode(JSON.stringify(argv)).byteLength <= 65536,
          "Command arguments exceed the 64 KiB limit.",
        ),
      access: WorkspaceAccessSchema,
      timeout_secs: AgentExecutionSchema.shape.timeout_secs,
    })
    .strict(),
  z.object({ ...nodeFields, type: z.literal("approval"), instructions }).strict(),
]);

const FlowGraphSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    nodes: z.array(FlowNodeSchema).max(200),
    edges: z
      .array(z.object({ id: identity, source: identity, target: identity }).strict())
      .max(1000),
  })
  .strict();

export type FlowDefinition = z.infer<typeof FlowGraphSchema>;
export type FlowNode = z.infer<typeof FlowNodeSchema>;
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const nodeDependencies = (flow: FlowDefinition, nodeId: string) =>
  flow.edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => edge.source)
    .sort();

/** Shared by the renderer and host: connections schedule work; bindings deliver context. */
export const FlowDefinitionSchema = FlowGraphSchema.superRefine((flow, context) => {
  const issue = (path: (string | number)[], message: string) =>
    context.addIssue({ code: "custom", path, message });

  const nodes = new Set<string>();
  for (const [index, node] of flow.nodes.entries()) {
    if (nodes.has(node.id)) issue(["nodes", index, "id"], "Node IDs must be unique.");
    nodes.add(node.id);
  }

  const edgeIds = new Set<string>();
  const connections = new Set<string>();
  const incoming = new Map(flow.nodes.map((node) => [node.id, new Set<string>()]));
  for (const [index, edge] of flow.edges.entries()) {
    if (edgeIds.has(edge.id)) issue(["edges", index, "id"], "Connection IDs must be unique.");
    edgeIds.add(edge.id);
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) {
      issue(["edges", index], "Both ends of a connection must exist.");
      continue;
    }

    if (edge.source === edge.target) issue(["edges", index], "A node cannot depend on itself.");
    const key = `${edge.source}:${edge.target}`;
    if (connections.has(key)) issue(["edges", index], "These nodes are already connected.");
    connections.add(key);
    incoming.get(edge.target)!.add(edge.source);
  }

  const ancestors = (id: string) => {
    const seen = new Set<string>();
    const pending = [...(incoming.get(id) || [])];
    while (pending.length) {
      const parent = pending.pop()!;
      if (seen.has(parent)) continue;
      seen.add(parent);
      pending.push(...(incoming.get(parent) || []));
    }

    return seen;
  };

  for (const [index, node] of flow.nodes.entries()) {
    const predecessors = ancestors(node.id);
    if (predecessors.has(node.id))
      issue(["nodes", index], "Flows must be acyclic. Remove the connection that creates a loop.");
    const bindings = new Set<string>();
    for (const [bindingIndex, binding] of node.inputs.entries()) {
      const key = JSON.stringify(binding);
      if (bindings.has(key))
        issue(["nodes", index, "inputs", bindingIndex], "Input bindings must be unique.");
      bindings.add(key);
      if (
        "node_id" in binding &&
        (!predecessors.has(binding.node_id) || binding.node_id === node.id)
      )
        issue(
          ["nodes", index, "inputs", bindingIndex],
          "Node inputs must refer to a connected predecessor.",
        );
    }
  }
});

/** Layout is never part of an executable revision or an approval fingerprint. */
export const CanvasLayoutSchema = z
  .object({
    positions: z
      .record(identity, z.object({ x: z.number().finite(), y: z.number().finite() }).strict())
      .refine(
        (positions) => Object.keys(positions).length <= 200,
        "A canvas supports at most 200 positions.",
      ),
    viewport: z
      .object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().min(0.1).max(4) })
      .strict(),
  })
  .strict();

export const FlowRevisionSchema = z
  .object({
    flow_id: identity,
    revision: z.number().int().positive(),
    definition: FlowDefinitionSchema,
    created_at: z.string().datetime(),
  })
  .strict();

/** Resolve once at explicit run startup, then retain this value with the run. */
export const resolveAgentNode = (
  node: Extract<FlowNode, { type: "agent" }>,
  profile: AgentProfile,
) => {
  const validatedNode = FlowNodeSchema.parse(node);
  const validatedProfile = AgentProfileSchema.parse(profile);
  if (validatedNode.type !== "agent" || validatedNode.profile_id !== validatedProfile.id)
    throw new Error("The agent node must use its selected profile.");

  const execution = FlowExecutionSchema.parse({
    ...validatedProfile.execution,
    ...validatedNode.overrides,
  });

  if (!validatedProfile.supported_access.includes(execution.access))
    throw new Error("The node requests access that its selected profile does not support.");
  if (validatedNode.completion.review === "require-approved" && execution.output !== "review")
    throw new Error("An approved-review completion rule requires the review output contract.");
  if (validatedNode.completion.review === "require-approved" && execution.access !== "read-only")
    throw new Error("Independent review must use read-only workspace access.");
  return {
    profile: validatedProfile,
    execution,
    instructions: [validatedProfile.instructions, validatedNode.instructions]
      .filter(Boolean)
      .join("\n\n"),
  };
};
