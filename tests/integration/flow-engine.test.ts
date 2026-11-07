import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { AgentProfileSchema, type FlowNode } from "../../backend/flows/contracts";
import type { ApprovalDecision, FlowRun } from "../../backend/flows/run-contracts";
import type { AgentRunRequest } from "../../backend/execution/providers/contracts";
import { createFixtureEngine, FixtureProvider } from "../helpers/fixtures";
import { staleNodes } from "../../src/features/flows/graph";

class FlowFixture extends FixtureProvider {
  readonly requests: {
    request: AgentRunRequest;
    tag: string;
    inputs: { binding: { kind: string }; content: string }[];
  }[] = [];

  invocation = (request: AgentRunRequest) => {
    const packet = JSON.parse(request.prompt.slice(request.prompt.indexOf("\n\n") + 2));
    const tag = packet.instructions.split("\n\n").at(-1) as string;
    const count = this.requests.filter((entry) => entry.tag === tag).length;
    this.requests.push({ request, tag, inputs: packet.inputs });
    const emit = `console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({summary:${JSON.stringify(tag)}})}}));`;

    const body =
      tag === "partial_chat"
        ? `require('node:fs').writeFileSync('chat-change.txt','Partial chat change');setInterval(()=>{},20);`
        : tag === "probe"
          ? `try{require('node:fs').writeFileSync('forbidden.txt','unexpected');throw new Error('Read-only write succeeded');}catch(e){if(e.message==='Read-only write succeeded')throw e;}${emit}`
          : tag === "edit_chat"
            ? `require('node:fs').writeFileSync('chat-change.txt','Viber chat change');${emit}`
            : tag === "hold"
              ? `const timer=setInterval(()=>{if(require('node:fs').existsSync('release.fixture')){clearInterval(timer);${emit}}},20);`
              : tag === "fail_once" && count === 0
                ? "throw new TypeError('Fixture provider failure');"
                : tag === "root"
                  ? `require('node:fs').writeFileSync('source.js','const value = 1;\\n');${emit}`
                  : tag === "join"
                    ? `require('node:fs').writeFileSync('final.md','Joined results');${emit}`
                    : tag === "left"
                      ? `require('node:fs').readFileSync('source.js','utf8');${emit}`
                      : tag === "reports_only"
                        ? `const argv=[process.execPath,'-e','console.log("file listing, not a check")'];const out=require('node:child_process').execFileSync(argv[0],argv.slice(1),{encoding:'utf8'});console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',id:'ordinary-read',command:JSON.stringify(argv),exit_code:0,aggregated_output:out}}));${emit}`
                        : emit;

    return { program: process.execPath, args: ["-e", body], input: "" };
  };
}

let directory: string;
let provider: FlowFixture;
let engine: Awaited<ReturnType<typeof createFixtureEngine>>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "vibestar-flow-engine-"));
  provider = new FlowFixture();
  engine = await createFixtureEngine(join(directory, "data"), () => provider);
});

afterEach(async () => {
  await engine.close();
  await rm(directory, { recursive: true, force: true });
});

const workspace = () => {
  const profile = AgentProfileSchema.parse({
    id: randomUUID(),
    revision: 1,
    name: "Viber",
    instructions: "Use only selected inputs.",
    supported_access: ["read-only", "workspace-write"],
    execution: {
      provider: "codex",
      model: "next-model",
      effort: "low",
      timeout_secs: 30,
      access: "workspace-write",
      output: "summary",
    },
  });

  engine.flows.saveProfile(profile, null);
  const goal = "Work on this general task";
  const task = engine.createGeneralTask({ request_id: randomUUID(), goal, profile_id: profile.id });
  const flowId = task.flow_id;
  if (!flowId) throw new Error("Fixture task did not create its owned flow.");

  const agent = (tag: string): Extract<FlowNode, { type: "agent" }> => ({
    id: randomUUID(),
    name: tag,
    type: "agent",
    profile_id: profile.id,
    instructions: tag,
    inputs: [{ kind: "task-goal" }],
    overrides: {},
    completion: { verification: "record-only", review: "none" },
  });

  const save = (nodes: FlowNode[], edges: { id: string; source: string; target: string }[] = []) =>
    engine.flows.saveDefinition(flowId, { name: "Fixture graph", nodes, edges }, 1);

  const request = {
    flow_id: flowId,
    task_id: task.id,
    revision: 2,
    request_id: randomUUID(),
    goal,
  };

  return { task, profile, flowId, goal, agent, save, request };
};

const edge = (source: FlowNode, target: FlowNode) => ({
  id: randomUUID(),
  source: source.id,
  target: target.id,
});

const settled = async (run: FlowRun, status: FlowRun["status"]) => {
  await expect
    .poll(
      () => ({
        status: engine.flowRuns.run(run.id).status,
        active: engine.isActive(run.task_id),
        error: engine.flowRuns.run(run.id).error,
      }),
      {
        timeout: 10000,
      },
    )
    .toMatchObject({ status, active: false, ...(status === "completed" ? { error: null } : {}) });
};

const chat = (
  w: ReturnType<typeof workspace>,
  node: Extract<FlowNode, { type: "agent" }>,
  content = "A private message for this Viber",
) => ({
  task_id: w.task.id,
  node_id: node.id,
  profile_id: node.profile_id,
  expected_revision: 2,
  request_id: randomUUID(),
  content,
  history_ids: [] as string[],
  inputs: [{ kind: "task-goal" as const }],
});

it("isolates conversations for two instances of one Viber without editing or completing their graph", async () => {
  const w = workspace();
  const first = w.agent("first");
  const second = w.agent("second");
  w.save([first, second], [edge(first, second)]);
  const input = chat(w, second, "Only the second Viber should see this");
  const run = engine.chatViber(input);
  await settled(run, "completed");
  expect(engine.flows.definition(w.flowId).revision).toBe(2);
  expect(engine.flowRuns.definition(run.id).nodes.map((node) => node.id)).toEqual([second.id]);
  expect(engine.flowRuns.definition(run.id).edges).toEqual([]);
  expect(engine.flowRuns.run(run.id).kind).toBe("conversation");
  expect(provider.requests.map((entry) => entry.tag)).toEqual(["second"]);
  expect(engine.chatViber(input).id).toBe(run.id);
  const messages = engine.db.detail(w.task.id).messages;
  expect(messages).toHaveLength(2);

  expect(
    messages.every(
      (message) => message.flow_node_id === second.id && message.viber_profile_id === w.profile.id,
    ),
  ).toBe(true);

  const reply = messages.find((message) => message.role === "assistant")!;

  expect(() => engine.chatViber({ ...chat(w, first), history_ids: [String(reply.id)] })).toThrow(
    "this task and Viber",
  );

  expect(() => engine.chatViber({ ...chat(w, second), profile_id: randomUUID() })).toThrow(
    "different Viber",
  );

  expect(provider.requests).toHaveLength(1);
  const next = engine.chatViber({ ...chat(w, second), history_ids: [String(reply.id)] });
  await settled(next, "completed");

  expect(
    engine.flowRuns
      .attempts(next.id)[0]
      .inputs.some(
        (entry) =>
          entry.binding.kind === "message" &&
          entry.binding.message_id === reply.id &&
          JSON.parse(entry.content).content === reply.content,
      ),
  ).toBe(true);

  const graph = engine.startFlow(w.request);
  await settled(graph, "completed");

  expect(engine.flowRuns.attempts(graph.id).map((attempt) => attempt.node_id)).toEqual([
    first.id,
    second.id,
  ]);

  expect(provider.requests.map((entry) => entry.tag)).toEqual([
    "second",
    "second",
    "first",
    "second",
  ]);
});

it("allows a read-only Viber chat at a waiting gate without granting writes or accepting that gate", async () => {
  const w = workspace();
  const read = { ...w.agent("probe"), overrides: { access: "read-only" as const } };
  const approval = approvalNode();
  w.save([read, approval], [edge(read, approval)]);
  const graph = engine.startFlow(w.request);
  await settled(graph, "waiting");
  const before = engine.flowRuns.attempts(graph.id);
  const turn = engine.chatViber(chat(w, read));
  await settled(turn, "completed");
  expect(provider.requests.at(-1)?.request.access).toBe("read-only");
  expect(engine.flowRuns.run(graph.id).status).toBe("waiting");
  expect(engine.flowRuns.attempts(graph.id)).toEqual(before);
  expect(engine.flowRuns.invalidation(graph.id)).toBeNull();
  expect(engine.db.all("SELECT * FROM flow_approval_decisions")).toHaveLength(0);
  await expect(readFile(joinPath(w.task.id, "forbidden.txt"), "utf8")).rejects.toThrow();
});

it.each(["edit_chat", "partial_chat"])(
  "invalidates a pending graph after %s changes shared files, including cancelled partial work",
  async (tag) => {
    const w = workspace();
    const read = w.agent("first");
    const approval = approvalNode();
    const editor = w.agent(tag);
    w.save([read, approval, editor], [edge(read, approval), edge(approval, editor)]);
    const graph = engine.startFlow(w.request);
    await settled(graph, "waiting");
    const original = engine.flowRuns.attempts(graph.id)[0];
    const gate = decision(graph, approval.id);
    const turn = engine.chatViber(chat(w, editor));
    if (tag === "partial_chat") {
      await expect
        .poll(
          async () => readFile(joinPath(w.task.id, "chat-change.txt"), "utf8").catch(() => ""),
          { timeout: 10000 },
        )
        .toBe("Partial chat change");

      engine.cancelFlow(turn.id);
      await settled(turn, "cancelled");
    } else await settled(turn, "completed");
    expect(engine.flowRuns.run(graph.id).status).toBe("failed");

    expect(engine.flowRuns.invalidation(graph.id)?.reason).toContain(
      "changed the shared workspace",
    );

    expect(engine.flowRuns.attempts(graph.id)[0]).toEqual(original);
    expect(engine.flowRuns.attempt(gate.attempt_id).status).toBe("interrupted");
    expect(engine.db.all("SELECT * FROM flow_approval_decisions")).toHaveLength(0);
    await expect(engine.approveFlowNode(gate)).rejects.toThrow(/workspace|Viber/);

    expect(
      engine.db.detail(w.task.id).messages.find((message) => message.id === turn.request_id)
        ?.status,
    ).toBe(tag === "partial_chat" ? "chat_cancelled" : "chat_completed");
  },
  15000,
);

it("blocks graph authority while a conversation is queued and cancels only the requested scope", async () => {
  const w = workspace();
  const read = w.agent("first");
  const approval = approvalNode();
  const hold = w.agent("hold");
  w.save([read, approval, hold], [edge(read, approval), edge(approval, hold)]);
  const graph = engine.startFlow(w.request);
  await settled(graph, "waiting");
  const release = engine.acquireTerminal(w.task.id);
  const turn = engine.chatViber(chat(w, hold));
  expect(engine.flowRuns.run(turn.id).status).toBe("queued");

  await expect(engine.approveFlowNode(decision(graph, approval.id))).rejects.toThrow(
    "conversation",
  );

  engine.cancelFlow(graph.id);
  expect(engine.flowRuns.run(turn.id).status).toBe("queued");
  release();

  await expect
    .poll(() => provider.requests.some((entry) => entry.tag === "hold"), { timeout: 10000 })
    .toBe(true);

  expect(engine.flowRuns.run(turn.id).status).toBe("running");
  engine.cancel(w.task.id);
  await settled(turn, "cancelled");
  expect(engine.flowRuns.run(graph.id).status).toBe("cancelled");

  expect(
    engine.db.detail(w.task.id).messages.find((message) => message.id === turn.request_id)?.status,
  ).toBe("chat_cancelled");
});

it("retries a failed captured conversation explicitly while retaining both attempts and correct message scope", async () => {
  const w = workspace();
  const node = w.agent("fail_once");
  w.save([node]);
  const input = chat(w, node);
  const turn = engine.chatViber(input);
  await settled(turn, "failed");
  const failed = engine.flowRuns.attempts(turn.id)[0];
  expect(engine.db.detail(w.task.id).messages[0].status).toBe("chat_failed");

  engine.retryFlowNode({
    run_id: turn.id,
    node_id: node.id,
    attempt_id: failed.id,
    request_id: randomUUID(),
  });

  await settled(turn, "completed");

  expect(engine.flowRuns.attempts(turn.id).map((attempt) => attempt.status)).toEqual([
    "failed",
    "completed",
  ]);

  expect(engine.flowRuns.attempt(failed.id)).toEqual(failed);

  expect(engine.db.detail(w.task.id).messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: input.request_id,
        status: "chat_completed",
        flow_node_id: node.id,
        viber_profile_id: node.profile_id,
      }),
      expect.objectContaining({
        role: "assistant",
        status: "chat_completed",
        flow_node_id: node.id,
        viber_profile_id: node.profile_id,
      }),
    ]),
  );

  expect(provider.requests).toHaveLength(2);
});

const decision = (
  run: FlowRun,
  nodeId: string,
  value: "accepted" | "rejected" = "accepted",
): Omit<ApprovalDecision, "created_at"> => {
  const attempt = engine.flowRuns
    .attempts(run.id)
    .filter((entry) => entry.node_id === nodeId)
    .at(-1);

  if (!attempt) throw new Error("Expected a waiting approval attempt.");
  return {
    attempt_id: attempt.id,
    request_id: randomUUID(),
    decision: value,
    configuration_hash: attempt.configuration_hash,
    inputs_hash: attempt.inputs_hash,
    workspace_fingerprint: attempt.workspace_fingerprint,
  };
};

it("executes branches and joins with a real command, explicit context and an approval pause", async () => {
  const w = workspace();
  const root = w.agent("root");
  const left = { ...w.agent("left"), overrides: { access: "read-only" as const } };

  const check: FlowNode = {
    id: randomUUID(),
    name: "Syntax check",
    type: "command",
    inputs: [],
    argv: [process.execPath, "--check", "source.js"],
    access: "read-only",
    timeout_secs: 30,
  };

  const approval: FlowNode = {
    id: randomUUID(),
    name: "Approve joined inputs",
    type: "approval",
    instructions: "Inspect both branches.",
    inputs: [
      { kind: "output", node_id: left.id },
      { kind: "verification", node_id: check.id },
    ],
  };

  const join = {
    ...w.agent("join"),
    inputs: [
      { kind: "output" as const, node_id: left.id },
      { kind: "output" as const, node_id: approval.id },
    ],
  };

  w.save(
    [root, left, check, approval, join],
    [
      edge(root, left),
      edge(root, check),
      edge(left, approval),
      edge(check, approval),
      edge(approval, join),
    ],
  );

  expect(provider.requests).toHaveLength(0);
  const run = engine.startFlow(w.request);
  await settled(run, "waiting");
  expect(provider.requests.map((entry) => entry.tag)).toEqual(["root", "left"]);

  expect(
    engine.flowRuns.attempts(run.id).find((attempt) => attempt.node_id === check.id),
  ).toMatchObject({ status: "completed", verification: "passed" });

  expect(engine.flowRuns.attempts(run.id).some((attempt) => attempt.node_id === join.id)).toBe(
    false,
  );

  const input = decision(run, approval.id);
  const first = engine.approveFlowNode(input);
  const duplicate = engine.approveFlowNode(input);
  expect(duplicate).toBe(first);
  expect(await first).toEqual(await duplicate);
  await settled(run, "completed");
  expect(provider.requests.map((entry) => entry.tag)).toEqual(["root", "left", "join"]);

  expect(provider.requests.at(-1)?.inputs.map((entry) => entry.binding.kind)).toEqual([
    "output",
    "output",
  ]);

  expect(provider.requests.at(-1)?.inputs[0].content).toBe('{"summary":"left"}');
  expect(await readFile(joinPath(w.task.id, "final.md"), "utf8")).toBe("Joined results");
  const before = engine.db.all("SELECT id FROM flow_dispatches").length;
  await engine.approveFlowNode(input);
  engine.startFlow(w.request);
  await engine.drain();
  expect(provider.requests).toHaveLength(3);
  expect(engine.db.all("SELECT id FROM flow_dispatches")).toHaveLength(before);

  expect(engine.db.task(w.task.id)).toMatchObject({
    stage: 0,
    status: "not_started",
    repo_id: null,
  });

  expect(
    engine.db.all(
      "SELECT a.id FROM flow_node_attempts a JOIN agent_runs r ON r.id=a.agent_run_id JOIN ai_usage u ON u.id=r.id WHERE a.run_id=?",
      run.id,
    ),
  ).toHaveLength(3);
}, 15000);

const joinPath = (taskId: string, file: string) => join(engine.db.task(taskId).worktree_path, file);

const approvalNode = (): Extract<FlowNode, { type: "approval" }> => ({
  id: randomUUID(),
  name: "Approve selected evidence",
  type: "approval",
  instructions: "Inspect the result.",
  inputs: [],
});

it("applies a saved revision with proved results, original telemetry and concurrent request deduplication", async () => {
  const w = workspace();
  const a = w.agent("a");
  const b = w.agent("b");
  const approval = approvalNode();
  const edges = [edge(a, b), edge(b, approval)];
  w.save([a, b, approval], edges);
  const original = engine.startFlow(w.request);
  await settled(original, "waiting");
  engine.pauseFlow(original.id);
  const before = engine.flowRuns.attempts(original.id);

  expect(before[0].completed_fingerprint).toBe(
    await engine.git.fingerprint(engine.db.task(w.task.id)),
  );

  const changed = { ...b, instructions: "changed_b" };

  engine.flows.saveDefinition(
    w.flowId,
    { name: "Updated remainder", nodes: [a, changed, approval], edges },
    2,
  );

  const plan = await engine.previewFlowContinuation({ run_id: original.id, revision: 3 });
  expect(plan.nodes.map((node) => node.status)).toEqual(["reuse", "stale", "stale"]);
  expect(provider.requests).toHaveLength(2);

  const request = {
    run_id: original.id,
    revision: 3,
    request_id: randomUUID(),
    plan_hash: plan.hash,
  };

  const first = engine.applyFlowContinuation(request);
  expect(engine.applyFlowContinuation(request)).toBe(first);
  const next = await first;
  await settled(next, "waiting");
  expect(provider.requests.map((request) => request.tag)).toEqual(["a", "b", "changed_b"]);

  expect(engine.flowRuns.attempts(next.id).map((attempt) => attempt.node_id)).toEqual([
    b.id,
    approval.id,
  ]);

  expect(engine.flowRuns.results(next.id).find((attempt) => attempt.node_id === a.id)).toEqual(
    before[0],
  );

  expect(engine.flowRuns.run(original.id).status).toBe("continued");
  expect(engine.flowRuns.attempt(before[2].id).status).toBe("interrupted");
  expect(engine.flowRuns.attempt(before[0].id)).toEqual(before[0]);
  await engine.approveFlowNode(decision(next, approval.id));
  await settled(next, "completed");
  expect(await engine.applyFlowContinuation(request)).toEqual(engine.flowRuns.run(next.id));
  expect(engine.db.all("SELECT id FROM agent_runs WHERE task_id=?", w.task.id)).toHaveLength(3);
  expect(engine.db.all("SELECT id FROM ai_usage WHERE task_id=?", w.task.id)).toHaveLength(3);
  expect(engine.db.all("PRAGMA foreign_key_check")).toEqual([]);

  await expect(engine.applyFlowContinuation({ ...request, revision: 2 })).rejects.toThrow(
    "different",
  );
}, 15000);

it("marks an edited branch and its join stale while reusing an unchanged branch", async () => {
  const w = workspace();
  const root = w.agent("root");
  const left = w.agent("left");
  const right = w.agent("right");

  const joined = {
    ...w.agent("join_read"),
    inputs: [
      { kind: "output" as const, node_id: left.id },
      { kind: "output" as const, node_id: right.id },
    ],
  };

  const nodes = [root, left, right, joined];
  const edges = [edge(root, left), edge(root, right), edge(left, joined), edge(right, joined)];
  w.save(nodes, edges);
  const original = engine.startFlow(w.request);
  await settled(original, "completed");

  const changedNodes = nodes.map((node) =>
    node.id === left.id ? { ...left, instructions: "changed_left" } : node,
  );

  const graph = { name: "Branch edit", nodes: changedNodes, edges };
  engine.flows.saveDefinition(w.flowId, graph, 2);

  expect(
    [
      ...staleNodes(
        graph,
        { name: "Fixture graph", nodes, edges },
        [w.profile],
        engine.flowRuns.results(original.id),
      ),
    ].sort(),
  ).toEqual([left.id, joined.id].sort());

  const plan = await engine.previewFlowContinuation({ run_id: original.id, revision: 3 });
  expect(plan.nodes.find((node) => node.node_id === root.id)?.status).toBe("reuse");
  expect(plan.nodes.find((node) => node.node_id === right.id)?.status).toBe("reuse");
  expect(plan.nodes.find((node) => node.node_id === joined.id)?.reason).toContain("predecessor");

  const next = await engine.applyFlowContinuation({
    run_id: original.id,
    revision: 3,
    request_id: randomUUID(),
    plan_hash: plan.hash,
  });

  await settled(next, "completed");

  expect(provider.requests.map((request) => request.tag)).toEqual([
    "root",
    "left",
    "right",
    "join_read",
    "changed_left",
    "join_read",
  ]);

  expect(provider.requests.at(-1)?.inputs.map((input) => input.content)).toEqual([
    '{"summary":"changed_left"}',
    '{"summary":"right"}',
  ]);
}, 15000);

it("refuses stale continuation previews after workspace or profile changes without creating a run", async () => {
  const w = workspace();
  const a = w.agent("a");
  w.save([a]);
  const original = engine.startFlow(w.request);
  await settled(original, "completed");
  engine.flows.saveDefinition(w.flowId, { name: "Unchanged execution", nodes: [a], edges: [] }, 2);
  const first = await engine.previewFlowContinuation({ run_id: original.id, revision: 3 });
  await writeFile(joinPath(w.task.id, "manual.txt"), "A manual change");

  await expect(
    engine.applyFlowContinuation({
      run_id: original.id,
      revision: 3,
      request_id: randomUUID(),
      plan_hash: first.hash,
    }),
  ).rejects.toThrow("fresh continuation");

  const second = await engine.previewFlowContinuation({ run_id: original.id, revision: 3 });

  expect(second.nodes[0]).toMatchObject({
    status: "stale",
    reason: expect.stringContaining("workspace"),
  });

  engine.flows.saveProfile(
    { ...w.profile, revision: 2, instructions: "Changed reusable instructions" },
    1,
  );

  await expect(
    engine.applyFlowContinuation({
      run_id: original.id,
      revision: 3,
      request_id: randomUUID(),
      plan_hash: second.hash,
    }),
  ).rejects.toThrow("fresh continuation");

  expect(engine.db.all("SELECT id FROM flow_runs WHERE task_id=?", w.task.id)).toHaveLength(1);
  expect(provider.requests).toHaveLength(1);
  expect(engine.flowRuns.run(original.id).status).toBe("completed");
}, 15000);

it("invalidates reused results when queued workspace evidence changes and requires explicit recomputation", async () => {
  const w = workspace();
  const a = w.agent("a");
  w.save([a]);
  const original = engine.startFlow(w.request);
  await settled(original, "completed");
  engine.db.saveSettings({ ...engine.db.settings(), concurrency: 1 });
  const blocker = workspace();
  blocker.save([blocker.agent("hold")]);
  const held = engine.startFlow(blocker.request);

  await expect
    .poll(() => provider.requests.filter((request) => request.tag === "hold").length)
    .toBe(1);

  const plan = await engine.previewFlowContinuation({ run_id: original.id, revision: 2 });
  expect(plan.nodes[0].status).toBe("reuse");

  const next = await engine.applyFlowContinuation({
    run_id: original.id,
    revision: 2,
    request_id: randomUUID(),
    plan_hash: plan.hash,
  });

  expect(engine.flowRuns.run(next.id).status).toBe("queued");
  await writeFile(joinPath(w.task.id, "changed.txt"), "Changed after applying the preview");
  await engine.cancelFlow(held.id);
  await settled(next, "failed");
  expect(engine.flowRuns.staleResults(next.id).map((row) => row.node_id)).toEqual([a.id]);
  expect(engine.flowRuns.results(next.id)).toEqual([]);
  expect(engine.flowRuns.results(next.id, { includeStale: true })[0].run_id).toBe(original.id);
  expect(engine.flowRuns.attempts(next.id)).toHaveLength(0);
  expect(provider.requests.filter((request) => request.tag === "a")).toHaveLength(1);
  engine.runFlowNode({ run_id: next.id, node_id: a.id, request_id: randomUUID() });
  await settled(next, "completed");
  expect(provider.requests.filter((request) => request.tag === "a")).toHaveLength(2);
  expect(engine.flowRuns.attempts(next.id)).toHaveLength(1);
}, 15000);

it("treats changed dependencies as execution changes even when no handoff was selected", async () => {
  const w = workspace();
  const a = w.agent("a");
  const b = w.agent("b");
  w.save([a, b]);
  const original = engine.startFlow(w.request);
  await settled(original, "completed");

  engine.flows.saveDefinition(
    w.flowId,
    { name: "Changed dependency", nodes: [a, b], edges: [edge(a, b)] },
    2,
  );

  const plan = await engine.previewFlowContinuation({ run_id: original.id, revision: 3 });
  expect(plan.nodes[0].status).toBe("reuse");

  expect(plan.nodes[1]).toMatchObject({
    status: "stale",
    reason: expect.stringContaining("dependencies changed"),
  });
}, 15000);

it("reopens a completed continuation without replaying linked or original processes", async () => {
  const w = workspace();
  const a = w.agent("a");
  w.save([a]);
  const original = engine.startFlow(w.request);
  await settled(original, "completed");
  const plan = await engine.previewFlowContinuation({ run_id: original.id, revision: 2 });

  const request = {
    run_id: original.id,
    revision: 2,
    request_id: randomUUID(),
    plan_hash: plan.hash,
  };

  const next = await engine.applyFlowContinuation(request);
  await settled(next, "completed");
  expect(engine.flowRuns.attempts(next.id)).toEqual([]);
  await engine.close();
  engine = await createFixtureEngine(join(directory, "data"), () => provider);
  expect((await engine.applyFlowContinuation(request)).id).toBe(next.id);
  await engine.drain();
  expect(provider.requests).toHaveLength(1);
  expect(engine.flowRuns.results(next.id)[0].run_id).toBe(original.id);
}, 15000);

it("refreshes only a stale approval, retains its interrupted attempt and requires explicit continuation", async () => {
  const w = workspace();
  const a = w.agent("a");
  const approval = approvalNode();
  const next = w.agent("next");
  w.save([a, approval, next], [edge(a, approval), edge(approval, next)]);
  const run = engine.startFlow(w.request);
  await settled(run, "waiting");
  const original = decision(run, approval.id);
  const before = engine.flowRuns.attempt(original.attempt_id);
  await writeFile(joinPath(w.task.id, "changed.txt"), "Updated while waiting");
  await expect(engine.approveFlowNode(original)).rejects.toThrow("workspace changed");

  const request = {
    run_id: run.id,
    node_id: approval.id,
    attempt_id: before.id,
    request_id: randomUUID(),
  };

  engine.retryFlowNode(request);
  await settled(run, "waiting");
  expect(provider.requests.map((request) => request.tag)).toEqual(["a"]);

  const fresh = engine.flowRuns
    .attempts(run.id)
    .filter((attempt) => attempt.node_id === approval.id)
    .at(-1)!;

  expect(fresh).toMatchObject({ ordinal: 2, status: "waiting" });
  expect(fresh.workspace_fingerprint).not.toBe(before.workspace_fingerprint);

  expect(engine.flowRuns.attempt(before.id)).toMatchObject({
    status: "interrupted",
    workspace_fingerprint: before.workspace_fingerprint,
  });

  expect(
    engine.db.all("SELECT attempt_id FROM flow_approval_decisions WHERE attempt_id=?", before.id),
  ).toHaveLength(0);

  engine.retryFlowNode(request);
  expect(engine.flowRuns.attempts(run.id)).toHaveLength(3);
  await engine.approveFlowNode(decision(run, approval.id));
  await settled(run, "paused");
  expect(provider.requests.map((request) => request.tag)).toEqual(["a"]);
  engine.continueFlow({ run_id: run.id, request_id: randomUUID() });
  await settled(run, "completed");
  expect(provider.requests.map((request) => request.tag)).toEqual(["a", "next"]);
}, 15000);

it("reuses exact accepted approvals and never manufactures a replacement decision", async () => {
  const w = workspace();
  const a = w.agent("a");
  const approval = approvalNode();
  w.save([a, approval], [edge(a, approval)]);
  const run = engine.startFlow(w.request);
  await settled(run, "waiting");
  const accepted = decision(run, approval.id);
  await engine.approveFlowNode(accepted);
  await settled(run, "completed");
  const plan = await engine.previewFlowContinuation({ run_id: run.id, revision: 2 });
  expect(plan.nodes.map((node) => node.status)).toEqual(["reuse", "reuse"]);

  const next = await engine.applyFlowContinuation({
    run_id: run.id,
    revision: 2,
    request_id: randomUUID(),
    plan_hash: plan.hash,
  });

  await settled(next, "completed");
  expect(engine.flowRuns.attempts(next.id)).toHaveLength(0);

  expect(engine.db.all("SELECT attempt_id FROM flow_approval_decisions")).toEqual([
    { attempt_id: accepted.attempt_id },
  ]);

  expect(provider.requests).toHaveLength(1);
}, 15000);

it("rejects foreign result links and protects completed workspace evidence against replacement", async () => {
  const a = workspace();
  const node = a.agent("a");
  a.save([node]);
  const run = engine.startFlow(a.request);
  await settled(run, "completed");
  const source = engine.flowRuns.attempts(run.id)[0];

  expect(() =>
    engine.db.run(
      "UPDATE flow_node_attempts SET completed_fingerprint='forged' WHERE id=?",
      source.id,
    ),
  ).toThrow("immutable");

  const b = workspace();
  b.save([{ ...b.agent("b"), id: node.id }]);
  const foreignRun = engine.startFlow(b.request);
  await settled(foreignRun, "completed");
  const foreign = engine.flowRuns.attempts(foreignRun.id)[0];

  const captured = engine.flowRuns.createRun({
    ...a.request,
    request_id: randomUUID(),
    parent_run_id: run.id,
  });

  expect(() =>
    engine.flowRuns.linkResult(captured.id, node.id, foreign.id, foreign.completed_fingerprint!),
  ).toThrow("parent");

  expect(engine.flowRuns.results(captured.id)).toHaveLength(0);
  expect(engine.db.all("PRAGMA foreign_key_check")).toEqual([]);
}, 15000);

it("binds preview context even when a changed node already requires recomputation", async () => {
  const w = workspace();
  const artifactId = randomUUID();

  engine.db.run(
    "INSERT INTO task_artifacts(id,task_id,stage,kind,content,created_at) VALUES(?,?,0,'context','Selected source',?)",
    artifactId,
    w.task.id,
    new Date().toISOString(),
  );

  const a = { ...w.agent("a"), inputs: [{ kind: "artifact" as const, artifact_id: artifactId }] };
  w.save([a]);
  const original = engine.startFlow(w.request);
  await settled(original, "completed");

  engine.flows.saveDefinition(
    w.flowId,
    { name: "Changed instructions", nodes: [{ ...a, instructions: "changed_a" }], edges: [] },
    2,
  );

  const plan = await engine.previewFlowContinuation({ run_id: original.id, revision: 3 });
  expect(plan.nodes[0].status).toBe("stale");

  engine.db.run(
    "UPDATE task_artifacts SET content='Changed selected source' WHERE id=?",
    artifactId,
  );

  await expect(
    engine.applyFlowContinuation({
      run_id: original.id,
      revision: 3,
      request_id: randomUUID(),
      plan_hash: plan.hash,
    }),
  ).rejects.toThrow("fresh continuation");

  expect(engine.db.all("SELECT id FROM flow_runs WHERE task_id=?", w.task.id)).toHaveLength(1);
  expect(provider.requests).toHaveLength(1);
}, 15000);

it("pauses after the current node and continues the captured revision despite draft/profile/layout edits", async () => {
  const w = workspace();
  const root = w.agent("hold");
  const next = w.agent("next");
  w.save([root, next], [edge(root, next)]);
  const run = engine.startFlow(w.request);

  await expect
    .poll(
      () =>
        engine.db.all(
          "SELECT id FROM agent_runs WHERE task_id=? AND status='running' AND pid IS NOT NULL",
          w.task.id,
        ).length,
    )
    .toBe(1);

  expect(engine.pauseFlow(run.id).status).toBe("pausing");
  await writeFile(joinPath(w.task.id, "release.fixture"), "release");
  await settled(run, "paused");
  expect(provider.requests.map((entry) => entry.tag)).toEqual(["hold"]);

  engine.flows.saveProfile(
    {
      ...w.profile,
      revision: 2,
      instructions: "Changed profile",
      execution: { ...w.profile.execution, access: "read-only" },
    },
    1,
  );

  engine.flows.saveDefinition(
    w.flowId,
    {
      name: "Changed draft",
      nodes: [root, { ...next, instructions: "changed_next" }],
      edges: [edge(root, next)],
    },
    2,
  );

  engine.flows.saveLayout(w.flowId, {
    positions: { [root.id]: { x: 0, y: 10 }, [next.id]: { x: 350, y: 20 } },
    viewport: { x: 10, y: 20, zoom: 0.8 },
  });

  engine.continueFlow({ run_id: run.id, request_id: randomUUID() });
  await settled(run, "completed");
  expect(provider.requests.map((entry) => entry.tag)).toEqual(["hold", "next"]);
  expect(provider.requests[1].request.access).toBe("workspace-write");
  expect(engine.flowRuns.run(run.id).revision).toBe(2);
  expect(engine.flows.definition(w.flowId).revision).toBe(3);
}, 15000);

it("retries only the selected failed node and requires explicit continuation for its successors", async () => {
  const w = workspace();
  const first = w.agent("fail_once");
  const next = w.agent("next");
  w.save([first, next], [edge(first, next)]);
  const run = engine.startFlow(w.request);
  await settled(run, "failed");
  const previous = engine.flowRuns.attempts(run.id)[0];
  expect(previous.status).toBe("failed");

  const request = {
    run_id: run.id,
    node_id: first.id,
    attempt_id: previous.id,
    request_id: randomUUID(),
  };

  engine.retryFlowNode(request);
  await settled(run, "paused");
  expect(provider.requests.map((entry) => entry.tag)).toEqual(["fail_once", "fail_once"]);
  expect(engine.flowRuns.attempts(run.id).map((attempt) => attempt.ordinal)).toEqual([1, 2]);
  expect(engine.flowRuns.attempt(previous.id)).toEqual(previous);
  engine.retryFlowNode(request);
  await engine.drain();
  expect(provider.requests).toHaveLength(2);
  engine.continueFlow({ run_id: run.id, request_id: randomUUID() });
  await settled(run, "completed");
  expect(provider.requests.map((entry) => entry.tag)).toEqual(["fail_once", "fail_once", "next"]);
}, 15000);

it("runs only an eligible node and does not broaden single-node approval into a full-flow run", async () => {
  const w = workspace();
  const first = w.agent("first");

  const approval: FlowNode = {
    id: randomUUID(),
    name: "Approval",
    type: "approval",
    instructions: "",
    inputs: [],
  };

  const next = w.agent("next");
  w.save([first, approval, next], [edge(first, approval), edge(approval, next)]);
  const release = engine.acquireTerminal(w.task.id);
  const run = engine.startFlow(w.request);
  engine.pauseFlow(run.id);
  release();
  await engine.drain();
  expect(provider.requests).toHaveLength(0);
  engine.runFlowNode({ run_id: run.id, node_id: first.id, request_id: randomUUID() });
  await settled(run, "paused");

  expect(() =>
    engine.runFlowNode({ run_id: run.id, node_id: next.id, request_id: randomUUID() }),
  ).toThrow("predecessor");

  engine.runFlowNode({ run_id: run.id, node_id: approval.id, request_id: randomUUID() });
  await settled(run, "waiting");
  await engine.approveFlowNode(decision(run, approval.id));
  await settled(run, "paused");
  expect(provider.requests.map((entry) => entry.tag)).toEqual(["first"]);
  engine.continueFlow({ run_id: run.id, request_id: randomUUID() });
  await settled(run, "completed");
  expect(provider.requests.map((entry) => entry.tag)).toEqual(["first", "next"]);
}, 15000);

it("queues across the shared execution limit and waits for the task's terminal lease", async () => {
  engine.db.saveSettings({ ...engine.db.settings(), concurrency: 1 });
  const a = workspace();
  a.save([a.agent("hold")]);
  const first = engine.startFlow(a.request);
  await expect.poll(() => provider.requests.length).toBe(1);
  const b = workspace();
  b.save([b.agent("second")]);
  expect(engine.db.all("SELECT id FROM flow_runs WHERE task_id=?", b.task.id)).toHaveLength(0);
  const second = engine.startFlow(b.request);
  expect(engine.flowRuns.run(second.id).status).toBe("queued");

  expect(engine.cleanupBlockers(b.task.id)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: `flow:${second.id}`, task_id: b.task.id }),
    ]),
  );

  const release = engine.acquireTerminal(b.task.id);

  await expect
    .poll(
      () =>
        engine.db.all("SELECT id FROM agent_runs WHERE task_id=? AND pid IS NOT NULL", a.task.id)
          .length,
      { timeout: 10000 },
    )
    .toBe(1);

  await writeFile(joinPath(a.task.id, "release.fixture"), "release");
  await settled(first, "completed");
  await engine.drain();
  expect(provider.requests).toHaveLength(1);
  expect(engine.flowRuns.run(second.id).status).toBe("queued");
  release();
  await settled(second, "completed");
  expect(provider.requests.map((entry) => entry.tag)).toEqual(["hold", "second"]);
}, 15000);

it("cancels a real provider process and never replays its settled startup request", async () => {
  const w = workspace();
  w.save([w.agent("hold")]);
  const run = engine.startFlow(w.request);

  await expect
    .poll(
      () =>
        engine.db.all("SELECT id FROM agent_runs WHERE task_id=? AND pid IS NOT NULL", w.task.id)
          .length,
    )
    .toBe(1);

  await engine.cancelFlow(run.id);
  await settled(run, "cancelled");
  expect(engine.flowRuns.attempts(run.id)[0].status).toBe("cancelled");

  expect(engine.db.all("SELECT status FROM agent_runs WHERE task_id=?", w.task.id)).toEqual([
    { status: "cancelled" },
  ]);

  engine.startFlow(w.request);
  await engine.drain();
  expect(provider.requests).toHaveLength(1);
}, 15000);

it("interrupts active execution on shutdown and requires an explicit node retry after reopening", async () => {
  const w = workspace();
  const node = w.agent("hold");
  w.save([node]);
  const run = engine.startFlow(w.request);

  await expect
    .poll(
      () =>
        engine.db.all("SELECT id FROM agent_runs WHERE task_id=? AND pid IS NOT NULL", w.task.id)
          .length,
    )
    .toBe(1);

  await engine.close();
  engine = await createFixtureEngine(join(directory, "data"), () => provider);
  expect(engine.flowRuns.run(run.id).status).toBe("interrupted");
  const previous = engine.flowRuns.attempts(run.id)[0];
  expect(previous.status).toBe("interrupted");
  engine.start();
  await engine.drain();
  expect(provider.requests).toHaveLength(1);
  await writeFile(joinPath(w.task.id, "release.fixture"), "release");

  engine.retryFlowNode({
    run_id: run.id,
    node_id: node.id,
    attempt_id: previous.id,
    request_id: randomUUID(),
  });

  await settled(run, "completed");

  expect(engine.flowRuns.attempts(run.id).map((attempt) => attempt.status)).toEqual([
    "interrupted",
    "completed",
  ]);

  expect(provider.requests).toHaveLength(2);
}, 15000);

it("blocks failed dependencies while executing independent branches and keeps ordinary commands separate from checks", async () => {
  const w = workspace();

  const failure: FlowNode = {
    id: randomUUID(),
    name: "Failing command",
    type: "command",
    inputs: [],
    argv: [process.execPath, "-e", "throw new TypeError('fixture command failure')"],
    access: "read-only",
    timeout_secs: 30,
  };

  const independent = w.agent("independent");
  const blocked = w.agent("blocked");
  w.save([failure, independent, blocked], [edge(failure, blocked)]);
  const run = engine.startFlow(w.request);
  await settled(run, "failed");
  expect(provider.requests.map((entry) => entry.tag)).toEqual(["independent"]);

  expect(
    engine.flowRuns.attempts(run.id).find((attempt) => attempt.node_id === failure.id),
  ).toMatchObject({ status: "failed", verification: "failed" });

  const other = workspace();

  const reporter = {
    ...other.agent("reports_only"),
    completion: { verification: "require-passing" as const, review: "none" as const },
  };

  other.save([reporter]);
  const report = engine.startFlow(other.request);
  await settled(report, "failed");

  expect(
    engine.db.all("SELECT status,exit_code FROM agent_runs WHERE task_id=?", other.task.id),
  ).toEqual([{ status: "completed", exit_code: 0 }]);

  expect(engine.flowRuns.attempts(report.id)[0]).toMatchObject({
    status: "failed",
    verification: "missing",
    error: expect.stringContaining("required verification"),
  });
}, 15000);
