import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { now } from "../../backend/domain";
import { Database } from "../../backend/storage/database";
import { FlowStore } from "../../backend/flows/store";
import { FlowRunStore } from "../../backend/flows/run-store";
import {
  AgentProfileSchema,
  type FlowNode,
  type FlowDefinition,
} from "../../backend/flows/contracts";
import { agentNodePrompt, type NodeAttempt } from "../../backend/flows/run-contracts";
import { createFixtureEngine } from "../helpers/fixtures";
import { resolveNodeInputs } from "../../backend/flows/context";

const databases: Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

const fixture = (database?: Database) => {
  const db = database || new Database(":memory:");
  if (!database) databases.push(db);

  db.run(
    "INSERT INTO repositories VALUES('repo','fixture','fixture',?)",
    JSON.stringify({ id: "repo", owner: "fixture", name: "fixture" }),
  );

  for (const id of ["task", "other-task"])
    db.run(
      "INSERT INTO tasks(id,repo_id,status,stage,data,created_at) VALUES(?,'repo','not_started',0,?,'fixture')",
      id,
      JSON.stringify({ id, repo_id: "repo" }),
    );
  const definitions = new FlowStore(db);
  const runs = new FlowRunStore(db);

  const profile = AgentProfileSchema.parse({
    id: randomUUID(),
    revision: 1,
    name: "Viber",
    instructions: "Use the selected inputs.",
    supported_access: ["read-only", "workspace-write"],
    execution: {
      provider: "codex",
      model: "",
      effort: "low",
      timeout_secs: 30,
      access: "read-only",
      output: "summary",
    },
  });

  definitions.saveProfile(profile, null);

  const agent = (): Extract<FlowNode, { type: "agent" }> => ({
    id: randomUUID(),
    name: "Agent",
    type: "agent",
    profile_id: profile.id,
    inputs: [{ kind: "task-goal" }],
    instructions: "",
    overrides: {},
    completion: { verification: "record-only", review: "none" },
  });

  const flowId = randomUUID();

  const save = (nodes: FlowNode[], edges: FlowDefinition["edges"] = []) =>
    definitions.saveDefinition(flowId, { name: "Test flow", nodes, edges }, null, "task");

  const start = () =>
    runs.createRun({
      flow_id: flowId,
      revision: 1,
      task_id: "task",
      request_id: randomUUID(),
      goal: "Captured task goal",
    });

  return { db, definitions, runs, profile, agent, flowId, save, start };
};

const edge = (source: FlowNode, target: FlowNode) => ({
  id: randomUUID(),
  source: source.id,
  target: target.id,
});

const goalInput = [{ binding: { kind: "task-goal" as const }, content: "Captured task goal" }];

const observedAgent = (
  db: Database,
  runs: FlowRunStore,
  attempt: NodeAttempt,
  output = '{"summary":"completed"}',
  taskId = "task",
) => {
  const id = randomUUID();

  db.run(
    "INSERT INTO agent_runs(id,task_id,stage,provider,model,effort,prompt,status,started_at,exit_code,output) VALUES(?,?,0,'codex','','low','fixture','completed',?,0,?)",
    id,
    taskId,
    now(),
    output,
  );

  runs.attachExecution(attempt.id, id, "agent");
  return id;
};

it("captures one Viber conversation without changing the graph, its access or its paused authority", () => {
  const { db, definitions, runs, profile, agent, flowId, save, start } = fixture();

  const updated = {
    ...profile,
    revision: 2,
    execution: { ...profile.execution, access: "workspace-write" as const },
  };

  definitions.saveProfile(updated, 1);
  const planner = agent();

  const reviewer = {
    ...agent(),
    overrides: { access: "read-only" as const, output: "review" as const },
    completion: { verification: "record-only" as const, review: "require-approved" as const },
    inputs: [{ kind: "output" as const, node_id: planner.id }],
  };

  const saved = save([planner, reviewer], [edge(planner, reviewer)]);
  const graph = start();
  runs.setRunStatus(graph.id, "queued", "paused");

  const request = {
    flow_id: flowId,
    task_id: "task",
    revision: 1,
    goal: "Captured task goal",
    request_id: randomUUID(),
    parent_run_id: graph.id,
  };

  const scope = { node_id: reviewer.id, inputs: [{ kind: "task-goal" as const }] };
  const conversation = runs.createRun(request, "user", scope);
  expect(conversation.kind).toBe("conversation");

  expect(conversation.snapshot.agents[reviewer.id].execution).toMatchObject({
    access: "read-only",
    output: "conversation",
  });

  expect(runs.definition(conversation.id).nodes.map((node) => node.id)).toEqual([reviewer.id]);
  expect(definitions.definition(flowId)).toEqual(saved);
  expect(runs.run(graph.id).status).toBe("paused");
  expect(runs.attempts(graph.id)).toEqual([]);
  expect(runs.createRun(request, "user", scope)).toEqual(conversation);
  expect(() => runs.createRun(request)).toThrow("different configuration");
  runs.setRunStatus(conversation.id, "queued", "running");
  const attempt = runs.beginAttempt(conversation.id, reviewer.id, goalInput, "fixture:before");
  observedAgent(db, runs, attempt, "A conversational answer");

  runs.finishAttempt(
    attempt.id,
    "completed",
    "A conversational answer",
    "missing",
    null,
    "fixture:before",
  );

  runs.setRunStatus(conversation.id, "running", "completed");
  expect(runs.run(graph.id).status).toBe("paused");
  expect(runs.results(graph.id)).toEqual([]);

  expect(() => db.run("UPDATE flow_runs SET kind='flow' WHERE id=?", conversation.id)).toThrow(
    "immutable",
  );
});

it("refuses conversations during active graph execution and refuses implicit predecessor handoffs", () => {
  const { db, runs, agent, flowId, save, start } = fixture();
  const node = agent();
  save([node]);
  const graph = start();

  const request = {
    flow_id: flowId,
    task_id: "task",
    revision: 1,
    goal: "Captured task goal",
    request_id: randomUUID(),
    parent_run_id: graph.id,
  };

  expect(() => runs.createRun(request, "user", { node_id: node.id, inputs: [] })).toThrow(
    "Pause or stop",
  );

  runs.setRunStatus(graph.id, "queued", "paused");

  expect(() =>
    runs.createRun(request, "user", {
      node_id: node.id,
      inputs: [{ kind: "output", node_id: node.id }],
    }),
  ).toThrow("retained attempts explicitly");

  expect(() => runs.createRun(request, "historical", { node_id: node.id, inputs: [] })).toThrow(
    "explicit user request",
  );

  expect(db.all("SELECT id FROM flow_runs")).toHaveLength(1);
  expect(db.all("SELECT id FROM agent_runs")).toEqual([]);
});

it("invalidates paused graph authority after separate workspace changes without inventing an approval or erasing prior results", () => {
  const { db, runs, agent, save, start } = fixture();
  const node = agent();

  const gate: FlowNode = {
    id: randomUUID(),
    type: "approval",
    name: "Inspect",
    instructions: "Inspect the actual result.",
    inputs: [{ kind: "output", node_id: node.id }],
  };

  save([node, gate], [edge(node, gate)]);
  const run = start();
  runs.setRunStatus(run.id, "queued", "running");
  const attempt = runs.beginAttempt(run.id, node.id, goalInput, "fixture:before");
  const output = '{"summary":"Completed source result"}';
  observedAgent(db, runs, attempt, output);
  runs.finishAttempt(attempt.id, "completed", output, "missing", null, "fixture:before");

  const approval = runs.beginAttempt(
    run.id,
    gate.id,
    resolveNodeInputs(db, runs, run.id, gate.id),
    "fixture:before",
  );

  runs.setRunStatus(run.id, "running", "waiting");
  runs.invalidateWorkspace(run.id, "Another Viber changed the shared workspace.");
  expect(runs.run(run.id).status).toBe("failed");
  expect(runs.attempt(approval.id).status).toBe("interrupted");
  expect(runs.attempt(attempt.id)).toMatchObject({ status: "completed", output });

  expect(runs.staleResults(run.id)).toContainEqual({
    node_id: node.id,
    reason: "Another Viber changed the shared workspace.",
  });

  expect(db.all("SELECT attempt_id FROM flow_approval_decisions")).toEqual([]);
  runs.setRunStatus(run.id, "failed", "running");

  expect(() => runs.beginAttempt(run.id, gate.id, [], "fixture:after", approval.id)).toThrow(
    "Apply a saved revision",
  );
});

it("captures run settings once, deduplicates requests and preserves immutable snapshots", () => {
  const { db, definitions, runs, profile, agent, save, start, flowId } = fixture();
  const node = agent();
  save([node]);
  const run = start();

  definitions.saveProfile(
    {
      ...profile,
      revision: 2,
      instructions: "Changed later",
      execution: { ...profile.execution, access: "workspace-write" },
    },
    1,
  );

  const request = {
    flow_id: flowId,
    revision: 1,
    task_id: "task",
    request_id: run.request_id,
    goal: run.snapshot.goal,
  };

  expect(runs.createRun(request)).toEqual(run);
  expect(runs.run(run.id).snapshot.agents[node.id].execution.access).toBe("read-only");

  expect(() => runs.createRun({ ...request, goal: "Different" })).toThrow(
    "different configuration",
  );

  expect(() => runs.createRun({ ...request, request_id: randomUUID() })).toThrow("active flow");

  expect(() =>
    runs.createRun({ ...request, request_id: randomUUID(), task_id: "other-task" }),
  ).toThrow("owned by this task");

  expect(() => db.run("UPDATE flow_runs SET snapshot=snapshot WHERE id=?", run.id)).toThrow(
    "immutable",
  );

  expect(db.all("SELECT * FROM agent_runs")).toHaveLength(0);
});

it("waits for every branch at a join and requires complete, exact input handoffs", () => {
  const { db, runs, agent, save, start } = fixture();
  const [left, right, join] = [agent(), agent(), agent()];
  join.inputs = [{ kind: "output", node_id: left.id }];
  save([left, right, join], [edge(left, join), edge(right, join)]);
  const run = start();
  runs.setRunStatus(run.id, "queued", "running");
  expect(() => runs.beginAttempt(run.id, join.id, [], "workspace:1")).toThrow("predecessors");

  expect(() => runs.beginAttempt(run.id, left.id, [], "workspace:1")).toThrow(
    "every selected binding",
  );

  expect(() =>
    runs.beginAttempt(run.id, left.id, [{ ...goalInput[0], content: "wrong goal" }], "workspace:1"),
  ).toThrow("captured run goal");

  const a = runs.beginAttempt(run.id, left.id, goalInput, "workspace:1");
  expect(() => runs.beginAttempt(run.id, right.id, goalInput, "workspace:1")).toThrow("serially");
  expect(() => runs.setRunStatus(run.id, "running", "completed")).toThrow();
  const output = '{"summary":"selected left result"}';
  observedAgent(db, runs, a, output);
  runs.finishAttempt(a.id, "completed", output, "missing");

  expect(() =>
    runs.beginAttempt(
      run.id,
      join.id,
      [{ binding: join.inputs[0], content: output }],
      "workspace:1",
    ),
  ).toThrow("predecessors");

  const b = runs.beginAttempt(run.id, right.id, goalInput, "workspace:1");
  observedAgent(db, runs, b);
  runs.finishAttempt(b.id, "completed", '{"summary":"completed"}', "missing");

  expect(() =>
    runs.beginAttempt(
      run.id,
      join.id,
      [{ binding: join.inputs[0], content: "fabricated" }],
      "workspace:1",
    ),
  ).toThrow("captured completed result");

  const c = runs.beginAttempt(
    run.id,
    join.id,
    [{ binding: join.inputs[0], content: output }],
    "workspace:1",
  );

  observedAgent(db, runs, c);
  runs.finishAttempt(c.id, "completed", '{"summary":"completed"}', "missing");
  expect(runs.setRunStatus(run.id, "running", "completed").status).toBe("completed");
  expect(runs.attempt(c.id).inputs).toEqual([{ binding: join.inputs[0], content: output }]);
  expect(db.all("SELECT * FROM flow_transitions").length).toBeGreaterThan(6);
});

it("records retries as separate attempts, blocks downstream failures and rejects stale retry identities", () => {
  const { db, runs, agent, save, start } = fixture();
  const [first, next] = [agent(), agent()];
  save([first, next], [edge(first, next)]);
  const run = start();
  runs.setRunStatus(run.id, "queued", "running");
  const failed = runs.beginAttempt(run.id, first.id, goalInput, "before");
  runs.finishAttempt(failed.id, "failed", null, "missing", "Provider failed");
  expect(() => runs.beginAttempt(run.id, next.id, goalInput, "before")).toThrow("predecessors");
  expect(() => runs.beginAttempt(run.id, first.id, goalInput, "after")).toThrow("Retry must");
  const retry = runs.beginAttempt(run.id, first.id, goalInput, "after", failed.id);
  expect(retry.ordinal).toBe(2);
  observedAgent(db, runs, retry);
  runs.finishAttempt(retry.id, "completed", '{"summary":"completed"}', "missing");

  expect(runs.attempt(failed.id)).toMatchObject({
    status: "failed",
    error: "Provider failed",
    workspace_fingerprint: "before",
  });

  expect(() => db.run("UPDATE flow_node_attempts SET inputs=inputs WHERE id=?", retry.id)).toThrow(
    "immutable",
  );

  expect(() => runs.beginAttempt(run.id, first.id, goalInput, "after", failed.id)).toThrow(
    "Retry must",
  );

  expect(runs.attempts(run.id)).toHaveLength(2);
});

it("binds approval to exact configuration, inputs and workspace and handles duplicate requests durably", () => {
  const { db, runs, agent, save, start } = fixture();

  const approval: FlowNode = {
    id: randomUUID(),
    type: "approval",
    name: "Your approval",
    instructions: "Inspect these inputs.",
    inputs: [{ kind: "task-goal" }],
  };

  const next = agent();
  save([approval, next], [edge(approval, next)]);
  const run = start();
  runs.setRunStatus(run.id, "queued", "running");
  const attempt = runs.beginAttempt(run.id, approval.id, goalInput, "workspace:1");

  const decision = {
    attempt_id: attempt.id,
    request_id: randomUUID(),
    decision: "rejected" as const,
    configuration_hash: attempt.configuration_hash,
    inputs_hash: attempt.inputs_hash,
    workspace_fingerprint: "workspace:1",
  };

  expect(() => runs.decideApproval(decision, "workspace:2")).toThrow("changed");

  expect(() =>
    runs.decideApproval({ ...decision, inputs_hash: "0".repeat(64) }, "workspace:1"),
  ).toThrow("changed");

  const saved = runs.decideApproval(decision, "workspace:1");
  expect(runs.decideApproval(decision, "workspace:1")).toEqual(saved);

  expect(() => runs.decideApproval({ ...decision, decision: "accepted" }, "workspace:1")).toThrow(
    "different decision",
  );

  expect(() => runs.beginAttempt(run.id, next.id, goalInput, "workspace:1")).toThrow(
    "predecessors",
  );

  expect(db.all("SELECT * FROM flow_approval_decisions")).toHaveLength(1);

  expect(() =>
    db.run("UPDATE flow_approval_decisions SET decision='accepted' WHERE attempt_id=?", attempt.id),
  ).toThrow("immutable");
});

it("does not promote process completion or reported checks into verified or approved outcomes", () => {
  const { db, runs, agent, save, start } = fixture();

  const node = {
    ...agent(),
    completion: { verification: "require-passing" as const, review: "none" as const },
  };

  save([node]);
  const run = start();
  runs.setRunStatus(run.id, "queued", "running");
  const attempt = runs.beginAttempt(run.id, node.id, goalInput, "workspace:1");

  expect(() => runs.finishAttempt(attempt.id, "completed", "{}", "missing")).toThrow(
    "observed execution",
  );

  expect(() => observedAgent(db, runs, attempt, "{}", "other-task")).toThrow("same task");
  observedAgent(db, runs, attempt, '{"summary":"tests passed according to model"}');

  expect(() =>
    runs.finishAttempt(attempt.id, "completed", '{"summary":"fabricated"}', "missing"),
  ).toThrow("retained agent result");

  expect(() =>
    runs.finishAttempt(
      attempt.id,
      "completed",
      '{"summary":"tests passed according to model"}',
      "passed",
    ),
  ).toThrow("observed passing checks");

  expect(
    runs.finishAttempt(
      attempt.id,
      "completed",
      '{"summary":"tests passed according to model"}',
      "missing",
    ),
  ).toMatchObject({ status: "failed", verification: "missing" });

  const snapshot = run.snapshot.agents[node.id];
  const retry = runs.beginAttempt(run.id, node.id, goalInput, "workspace:1", attempt.id);

  expect(() =>
    runs.assertAgentExecution(retry.id, "task", snapshot.execution, "wrong context"),
  ).toThrow("snapshot");

  expect(() =>
    runs.assertAgentExecution(
      retry.id,
      "task",
      { ...snapshot.execution, access: "workspace-write" },
      agentNodePrompt(retry),
    ),
  ).toThrow("snapshot");

  runs.assertAgentExecution(retry.id, "task", snapshot.execution, agentNodePrompt(retry));
});

it("creates a linked continuation after paused edits without rewriting the prior snapshot", () => {
  const { definitions, runs, profile, agent, save, start, flowId } = fixture();
  const node = agent();
  const initial = save([node]);
  const run = start();
  runs.setRunStatus(run.id, "queued", "running");
  runs.setRunStatus(run.id, "running", "pausing");
  runs.setRunStatus(run.id, "pausing", "paused");
  definitions.saveProfile({ ...profile, revision: 2, instructions: "New instructions" }, 1);
  definitions.saveDefinition(flowId, { ...initial.definition, name: "Edited graph" }, 1);

  const continuation = runs.createRun({
    flow_id: flowId,
    revision: 2,
    task_id: "task",
    request_id: randomUUID(),
    parent_run_id: run.id,
    goal: run.snapshot.goal,
  });

  expect(continuation.parent_run_id).toBe(run.id);

  expect(runs.run(run.id)).toMatchObject({
    status: "continued",
    revision: 1,
    snapshot: run.snapshot,
  });

  expect(continuation.snapshot.agents[node.id].instructions).toBe("New instructions");
  expect(runs.attempts(continuation.id)).toHaveLength(0);
});

it("marks unfinished flow work interrupted on real engine restart without invoking a provider", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-flow-restart-"));
  const root = join(dir, "data");

  const forbidden = () => {
    throw new Error("Restart must never invoke a provider");
  };

  let engine = await createFixtureEngine(root, forbidden);
  try {
    const { runs, agent, save, start } = fixture(engine.db);
    const node = agent();
    save([node]);
    const run = start();
    runs.setRunStatus(run.id, "queued", "running");
    const attempt = runs.beginAttempt(run.id, node.id, goalInput, "workspace:1");
    await engine.close();
    engine = await createFixtureEngine(root, forbidden);
    expect(engine.flowRuns.run(run.id).status).toBe("interrupted");
    expect(engine.flowRuns.attempt(attempt.id).status).toBe("interrupted");
    expect(engine.flowRuns.attempts(run.id)).toHaveLength(1);
    expect(engine.db.all("SELECT * FROM agent_runs")).toHaveLength(0);
    const count = engine.db.all("SELECT * FROM flow_transitions").length;
    await engine.close();
    engine = await createFixtureEngine(root, forbidden);
    expect(engine.db.all("SELECT * FROM flow_transitions")).toHaveLength(count);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("resolves only owned artifact context and rejects changed or oversized inputs without rewriting them", () => {
  const { db, runs, agent, save, start } = fixture();
  const own = randomUUID();
  const foreign = randomUUID();

  db.run(
    "INSERT INTO task_artifacts VALUES(?, 'task',0,'fixture',?,?)",
    own,
    "Selected artifact",
    now(),
  );

  db.run(
    "INSERT INTO task_artifacts VALUES(?, 'other-task',0,'fixture',?,?)",
    foreign,
    "Private other-task artifact",
    now(),
  );

  const a = { ...agent(), inputs: [{ kind: "artifact" as const, artifact_id: own }] };
  const b = { ...agent(), inputs: [{ kind: "artifact" as const, artifact_id: foreign }] };
  save([a, b]);
  const run = start();
  runs.setRunStatus(run.id, "queued", "running");
  const captured = resolveNodeInputs(db, runs, run.id, a.id);
  expect(captured[0].content).toBe("Selected artifact");
  expect(() => resolveNodeInputs(db, runs, run.id, b.id)).toThrow("belong to this task");

  expect(() =>
    runs.beginAttempt(
      run.id,
      b.id,
      [{ binding: b.inputs[0], content: "fabricated" }],
      "workspace:1",
    ),
  ).toThrow("belong to this task");

  db.run("UPDATE task_artifacts SET content='Changed after capture' WHERE id=?", own);

  expect(() => runs.beginAttempt(run.id, a.id, captured, "workspace:1")).toThrow(
    "Selected inputs changed",
  );

  const large = "x".repeat(131073);
  db.run("UPDATE task_artifacts SET content=? WHERE id=?", large, own);

  expect(() => resolveNodeInputs(db, runs, run.id, a.id)).toThrow(
    "no context was silently truncated",
  );

  expect(
    db.all<{ content: string }>("SELECT content FROM task_artifacts WHERE id=?", own)[0].content,
  ).toBe(large);

  expect(runs.attempts(run.id)).toEqual([]);
  expect(db.all("SELECT * FROM agent_runs")).toEqual([]);
});

it("hands observed checks to a successor separately from model claims", () => {
  const { db, runs, agent, save, start } = fixture();
  const a = agent();
  const b = { ...agent(), inputs: [{ kind: "verification" as const, node_id: a.id }] };
  save([a, b], [edge(a, b)]);
  const run = start();
  runs.setRunStatus(run.id, "queued", "running");
  const attempt = runs.beginAttempt(run.id, a.id, goalInput, "workspace:1");
  const report = '{"summary":"The model says all tests passed"}';
  const execution = observedAgent(db, runs, attempt, report);

  db.run(
    "INSERT INTO test_runs(id,task_id,command,status,started_at,exit_code,run_id) VALUES(?,'task','npm test','failed',?,1,?)",
    randomUUID(),
    now(),
    execution,
  );

  runs.finishAttempt(attempt.id, "completed", report, "failed");
  const inputs = resolveNodeInputs(db, runs, run.id, b.id);

  expect(JSON.parse(inputs[0].content)).toMatchObject({
    verification: "failed",
    provider_report: report,
    observed_commands: [expect.objectContaining({ status: "failed", exit_code: 1 })],
  });

  expect(() =>
    runs.beginAttempt(
      run.id,
      b.id,
      [{ binding: b.inputs[0], content: '{"verification":"passed"}' }],
      "workspace:1",
    ),
  ).toThrow("Selected inputs changed");
});

it("cancels pending approval without manufacturing a decision and interrupts corrupt snapshots conservatively", () => {
  const { db, definitions, runs, agent, save, start } = fixture();

  const approval: FlowNode = {
    id: randomUUID(),
    name: "Approval",
    type: "approval",
    instructions: "",
    inputs: [],
  };

  save([approval]);
  const first = start();
  runs.setRunStatus(first.id, "queued", "running");
  const waiting = runs.beginAttempt(first.id, approval.id, [], "workspace:1");
  runs.setRunStatus(first.id, "running", "cancelled");
  expect(runs.attempt(waiting.id)).toMatchObject({ status: "cancelled", output: null });
  expect(db.all("SELECT * FROM flow_approval_decisions")).toEqual([]);
  const secondFlow = randomUUID();
  const node = agent();

  definitions.saveDefinition(
    secondFlow,
    { name: "Corrupt input recovery", nodes: [node], edges: [] },
    null,
    "other-task",
  );

  const second = runs.createRun({
    flow_id: secondFlow,
    revision: 1,
    task_id: "other-task",
    request_id: randomUUID(),
    goal: "Captured task goal",
  });

  runs.setRunStatus(second.id, "queued", "running");
  const active = runs.beginAttempt(second.id, node.id, goalInput, "workspace:1");
  db.run("DROP TRIGGER flow_attempt_snapshot_immutable");
  db.run("UPDATE flow_node_attempts SET inputs='[]' WHERE id=?", active.id);
  expect(() => runs.attempt(active.id)).toThrow("original data is preserved");
  runs.interruptUnfinished();
  expect(runs.run(second.id).status).toBe("interrupted");

  expect(db.all("SELECT inputs,status FROM flow_node_attempts WHERE id=?", active.id)).toEqual([
    { inputs: "[]", status: "interrupted" },
  ]);

  expect(db.records.diagnostics()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ table_name: "flow_node_attempts", record_id: active.id }),
    ]),
  );
});
