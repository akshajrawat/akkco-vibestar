import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

import {
  AgentProfileSchema,
  CanvasLayoutSchema,
  FlowDefinitionSchema,
  resolveAgentNode,
  type FlowNode,
} from "../../backend/flows/contracts";

const profile = () =>
  AgentProfileSchema.parse({
    id: randomUUID(),
    revision: 1,
    name: "Reviewer",
    instructions: "Follow repository conventions.",
    supported_access: ["read-only"],
    execution: {
      provider: "codex",
      model: "",
      effort: "low",
      timeout_secs: 60,
      access: "read-only",
      output: "summary",
    },
  });

const agent = (profileId: string = randomUUID()): Extract<FlowNode, { type: "agent" }> => ({
  id: randomUUID(),
  type: "agent",
  name: "Viber",
  profile_id: profileId,
  instructions: "Focus on this node.",
  overrides: {},
  completion: { verification: "record-only", review: "none" },
  inputs: [{ kind: "task-goal" }],
});

const edge = (source: FlowNode, target: FlowNode) => ({
  id: randomUUID(),
  source: source.id,
  target: target.id,
});

it("accepts branches and joins with explicitly selected ancestor context", () => {
  const [start, left, right, join] = [agent(), agent(), agent(), agent()];

  join.inputs.push(
    { kind: "output", node_id: left.id },
    { kind: "verification", node_id: right.id },
    { kind: "output", node_id: start.id },
  );

  const flow = {
    name: "Branch and join",
    nodes: [start, left, right, join],
    edges: [edge(start, left), edge(start, right), edge(left, join), edge(right, join)],
  };

  expect(FlowDefinitionSchema.parse(flow)).toEqual(flow);
  // A dependency alone does not deliver predecessor output.
  expect(left.inputs).toEqual([{ kind: "task-goal" }]);
});

it("rejects cycles, invalid or duplicate connections and duplicate node IDs", () => {
  const [a, b, c] = [agent(), agent(), agent()];
  const flow = { name: "Validation", nodes: [a, b, c], edges: [edge(a, b), edge(b, c)] };
  for (const addition of [edge(c, a), edge(a, a), edge(agent(), b), edge(a, b), flow.edges[0]])
    expect(
      FlowDefinitionSchema.safeParse({ ...flow, edges: [...flow.edges, addition] }).success,
    ).toBe(false);
  expect(FlowDefinitionSchema.safeParse({ ...flow, nodes: [a, a, c] }).success).toBe(false);
});

it("rejects context from unrelated nodes and duplicated bindings", () => {
  const [a, b] = [agent(), agent()];
  const parse = () => FlowDefinitionSchema.safeParse({ name: "Inputs", nodes: [a, b], edges: [] });
  b.inputs.push({ kind: "output", node_id: a.id });
  expect(parse().success).toBe(false);
  b.inputs = [{ kind: "task-goal" }, { kind: "task-goal" }];
  expect(parse().success).toBe(false);
  b.inputs = [{ kind: "output", node_id: b.id }];
  expect(parse().success).toBe(false);
});

it("keeps executable definitions separate from layout and accepts empty drafts", () => {
  const node = agent();
  const flow = { name: "Draft", nodes: [node], edges: [] };
  const layout = { positions: { [node.id]: { x: 10, y: 20 } }, viewport: { x: 0, y: 0, zoom: 1 } };
  expect(CanvasLayoutSchema.parse(layout)).toEqual(layout);
  expect(FlowDefinitionSchema.safeParse({ ...flow, layout }).success).toBe(false);

  expect(
    FlowDefinitionSchema.safeParse({ ...flow, nodes: [{ ...node, position: { x: 0, y: 0 } }] })
      .success,
  ).toBe(false);

  expect(
    CanvasLayoutSchema.safeParse({ ...layout, viewport: { x: Infinity, y: 0, zoom: 1 } }).success,
  ).toBe(false);

  expect(FlowDefinitionSchema.parse({ name: "Empty draft", nodes: [], edges: [] }).nodes).toEqual(
    [],
  );
});

it("captures profile configuration without deriving authority or provider identity from its name", () => {
  const selected = profile();
  const node = agent(selected.id);
  const captured = resolveAgentNode(node, selected);
  selected.name = "Implementer";
  selected.instructions = "Changed later";
  selected.execution.provider = "antigravity";

  expect(captured).toMatchObject({
    profile: { name: "Reviewer", revision: 1 },
    execution: { provider: "codex", access: "read-only" },
    instructions: "Follow repository conventions.\n\nFocus on this node.",
  });

  expect(resolveAgentNode(node, selected).execution.access).toBe("read-only");

  expect(() =>
    resolveAgentNode({ ...node, overrides: { access: "workspace-write" } }, selected),
  ).toThrow("does not support");

  expect(() => resolveAgentNode({ ...node, profile_id: randomUUID() }, selected)).toThrow(
    "selected profile",
  );

  expect(() =>
    AgentProfileSchema.parse({ ...selected, supported_access: ["workspace-write"] }),
  ).toThrow();
});

it("does not infer successful checks or approved review from process completion", () => {
  const selected = profile();
  const node = agent(selected.id);

  expect(() =>
    resolveAgentNode(
      { ...node, completion: { verification: "require-passing", review: "require-approved" } },
      selected,
    ),
  ).toThrow("review output contract");

  expect(
    resolveAgentNode(
      {
        ...node,
        overrides: { output: "review" },
        completion: { verification: "require-passing", review: "require-approved" },
      },
      selected,
    ).execution.output,
  ).toBe("review");
});

it("accepts command and approval nodes while rejecting shell-shaped command configuration", () => {
  const command = {
    id: randomUUID(),
    type: "command",
    name: "Checks",
    inputs: [],
    argv: ["npm", "test"],
    access: "read-only",
    timeout_secs: 60,
  };

  const approval = {
    id: randomUUID(),
    type: "approval",
    name: "Review inputs",
    inputs: [{ kind: "output", node_id: command.id }],
    instructions: "Inspect the check result.",
  };

  const flow = {
    name: "Controlled command",
    nodes: [command, approval],
    edges: [{ id: randomUUID(), source: command.id, target: approval.id }],
  };

  expect(FlowDefinitionSchema.safeParse(flow).success).toBe(true);
  for (const invalid of [
    { ...command, argv: [] },
    { ...command, argv: [" "] },
    { ...command, argv: ["npm", "test\0bad"] },
    { ...command, argv: ["npm", ...Array<string>(5).fill("x".repeat(16000))] },
    { ...command, shell: "npm test" },
  ])
    expect(FlowDefinitionSchema.safeParse({ ...flow, nodes: [invalid, approval] }).success).toBe(
      false,
    );
});
