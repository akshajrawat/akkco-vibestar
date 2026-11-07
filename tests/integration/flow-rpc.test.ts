import { randomUUID } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";

import { Rpc } from "../../backend/rpc";
import type { FlowWorkspace } from "../../backend/flows/workspace";
import type { AgentProfile } from "../../backend/flows/contracts";
import { FlowDefinitionSchema } from "../../backend/flows/contracts";
import { builtInProfiles, flowTemplates, instantiateTemplate } from "../../backend/flows/templates";
import type { FlowRun } from "../../backend/flows/run-contracts";
import type { AgentRunRequest } from "../../backend/execution/providers/contracts";
import { createFixtureEngine, FixtureProvider } from "../helpers/fixtures";

class ConversationFixture extends FixtureProvider {
  readonly requests: AgentRunRequest[] = [];

  invocation = (request: AgentRunRequest) => {
    this.requests.push(request);
    return {
      program: process.execPath,
      input: "",
      args: [
        "-e",
        `require('node:fs').writeFileSync('answer.txt','Saved from solo Viber'); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'The solo Viber edited answer.txt.'}})); console.log(JSON.stringify({type:'turn.completed'}));`,
      ],
    };
  };
}

let dir: string;
let engine: Awaited<ReturnType<typeof createFixtureEngine>>;
let rpc: Rpc;
let provider: ConversationFixture;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibestar-flow-rpc-"));
  provider = new ConversationFixture();
  engine = await createFixtureEngine(join(dir, "data"), () => provider);
  rpc = new Rpc(engine);
  const profile = engine.flows.profile(builtInProfiles.implementer);

  engine.flows.saveProfile(
    {
      ...profile,
      revision: 2,
      execution: { ...profile.execution, model: "next-model", effort: "low", timeout_secs: 30 },
    },
    1,
  );
});

afterEach(async () => {
  await rpc.close();
  await engine.close();
  await rm(dir, { recursive: true, force: true });
});

const task = () =>
  engine.createGeneralTask({
    request_id: randomUUID(),
    goal: "Build with a solo Viber",
    profile_id: builtInProfiles.implementer,
  });

const workspace = async (taskId: string) =>
  (await rpc.call("flow.workspace", { task_id: taskId })) as FlowWorkspace;

const finished = async (run: FlowRun) => {
  await expect.poll(() => engine.flowRuns.run(run.id).status, { timeout: 10000 }).toBe("completed");
  await expect.poll(() => engine.isActive(run.task_id)).toBe(false);
};

it("saves idle general tasks, editable profiles and separate layouts without inference", async () => {
  const created = (await rpc.call("task.createGeneral", {
    request_id: randomUUID(),
    goal: "An unattached task",
    profile_id: builtInProfiles.implementer,
  })) as ReturnType<typeof task>;

  expect(created).toMatchObject({
    repo_id: null,
    issue_url: null,
    status: "not_started",
    worktree_path: "",
  });

  expect((await rpc.call("profile.list", {})) as AgentProfile[]).toHaveLength(4);
  const saved = await workspace(created.id);
  const node = saved.revision.definition.nodes[0];

  await rpc.call("flow.layout", {
    task_id: created.id,
    layout: { positions: { [node.id]: { x: 200, y: 100 } }, viewport: { x: 3, y: 5, zoom: 0.8 } },
  });

  expect((await workspace(created.id)).revision).toEqual(saved.revision);

  const invalid = {
    ...saved.revision.definition,
    edges: [{ id: randomUUID(), source: node.id, target: node.id }],
  };

  await expect(
    rpc.call("flow.save", { task_id: created.id, expected_revision: 1, definition: invalid }),
  ).rejects.toThrow();

  expect(provider.requests).toHaveLength(0);
  expect(engine.db.all("SELECT id FROM flow_runs")).toHaveLength(0);
});

it("executes solo chat through the graph runner, retains request identity, and sends only selected history", async () => {
  const created = task();
  let current = await workspace(created.id);

  const input = {
    task_id: created.id,
    node_id: current.revision.definition.nodes[0].id,
    expected_revision: 1,
    request_id: randomUUID(),
    content: "Edit answer.txt directly",
    history_ids: [],
    profile_id: builtInProfiles.implementer,
    inputs: [{ kind: "task-goal" }],
  };

  const run = (await rpc.call("viber.chat", input)) as FlowRun;
  await finished(run);
  expect(provider.requests).toHaveLength(1);
  expect(provider.requests[0]).toMatchObject({ stage: 0, access: "workspace-write" });
  expect(engine.db.task(created.id).stage).toBe(0);

  expect(engine.db.detail(created.id).messages.map((row) => row.status)).toEqual([
    "chat_completed",
    "chat_completed",
  ]);

  expect(await rpc.call("viber.chat", input)).toEqual(engine.flowRuns.run(run.id));
  expect(provider.requests).toHaveLength(1);

  await expect(rpc.call("viber.chat", { ...input, content: "Changed duplicate" })).rejects.toThrow(
    "different message",
  );

  const files = await rpc.call("flow.files", { task_id: created.id, path: "answer.txt" });
  expect(files).toMatchObject({ files: ["answer.txt"], text: "Saved from solo Viber" });
  current = await workspace(created.id);

  const assistant = engine.db
    .detail(created.id)
    .messages.find((message) => message.role === "assistant")!;

  const next = (await rpc.call("viber.chat", {
    ...input,
    expected_revision: current.revision.revision,
    request_id: randomUUID(),
    content: "Continue with the selected reply",
    history_ids: [assistant.id],
  })) as FlowRun;

  await finished(next);
  const captured = engine.flowRuns.attempts(next.id)[0];
  expect(captured.inputs.filter((entry) => entry.binding.kind === "message")).toHaveLength(2);

  expect(captured.inputs.some((entry) => entry.content.includes("Edit answer.txt directly"))).toBe(
    false,
  );

  expect(
    captured.inputs.some((entry) => entry.content.includes("The solo Viber edited answer.txt.")),
  ).toBe(true);
});

it("rejects foreign conversation inputs, stale edits and file aliases without dropping original records", async () => {
  const a = task();
  const b = task();
  const current = await workspace(a.id);
  const id = randomUUID();

  engine.db.run(
    "INSERT INTO task_messages(id,task_id,role,content,created_at,status,purpose) VALUES(?,?,'user','Foreign instruction',?,'chat_completed','chat')",
    id,
    b.id,
    new Date().toISOString(),
  );

  const input = {
    task_id: a.id,
    node_id: current.revision.definition.nodes[0].id,
    expected_revision: 1,
    request_id: randomUUID(),
    content: "Work",
    history_ids: [id],
    profile_id: builtInProfiles.implementer,
    inputs: [{ kind: "task-goal" }],
  };

  await expect(rpc.call("viber.chat", input)).rejects.toThrow("from this task");
  expect(engine.db.all("SELECT id FROM task_messages WHERE task_id=?", a.id)).toHaveLength(0);

  await rpc.call("flow.save", {
    task_id: a.id,
    expected_revision: 1,
    definition: current.revision.definition,
  });

  await expect(rpc.call("viber.chat", { ...input, history_ids: [] })).rejects.toThrow("Reload");
  expect(engine.db.all("SELECT id FROM task_messages WHERE task_id=?", a.id)).toHaveLength(0);

  const run = (await rpc.call("viber.chat", {
    ...input,
    expected_revision: 2,
    history_ids: [],
  })) as FlowRun;

  await finished(run);
  await writeFile(join(dir, "private.txt"), "private");
  await symlink(join(dir, "private.txt"), join(engine.db.task(a.id).worktree_path, "alias.txt"));

  await expect(rpc.call("flow.files", { task_id: a.id, path: "alias.txt" })).rejects.toThrow(
    /symlink|links/,
  );

  expect(engine.flowRuns.attempts(run.id)).toHaveLength(1);
});

it("lists reusable Viber instances and projects chat separately from the connected graph", async () => {
  const created = task();
  const current = await workspace(created.id);
  const first = current.revision.definition.nodes[0];
  if (first.type !== "agent") throw new Error("Expected fixture Viber");

  const second = {
    ...first,
    id: randomUUID(),
    name: "Another instance",
    inputs: [{ kind: "output" as const, node_id: first.id }],
  };

  await rpc.call("flow.save", {
    task_id: created.id,
    expected_revision: 1,
    definition: {
      name: "Two reusable Vibers",
      nodes: [first, second],
      edges: [{ id: randomUUID(), source: first.id, target: second.id }],
    },
  });

  expect(await rpc.call("viber.instances", {})).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        task_id: created.id,
        node_id: first.id,
        profile_id: first.profile_id,
      }),
      expect.objectContaining({
        task_id: created.id,
        node_id: second.id,
        profile_id: first.profile_id,
      }),
    ]),
  );

  expect(provider.requests).toHaveLength(0);
  await expect(rpc.call("viber.instances", { arbitrary: true })).rejects.toThrow();

  const turn = (await rpc.call("viber.chat", {
    task_id: created.id,
    node_id: second.id,
    profile_id: first.profile_id,
    expected_revision: 2,
    content: "Work directly with this Viber",
    request_id: randomUUID(),
    history_ids: [],
    inputs: [{ kind: "task-goal" }],
  })) as FlowRun;

  await finished(turn);
  const result = await workspace(created.id);
  expect(result.runs).toEqual([]);
  expect(result.attempts).toEqual([]);
  expect(result.conversations).toHaveLength(1);
  expect(result.conversation_attempts).toHaveLength(1);
  expect(result.revision.revision).toBe(2);

  expect(result.conversation_attempts[0]).toMatchObject({
    node_id: second.id,
    status: "completed",
  });

  expect(provider.requests).toHaveLength(1);
  const source = result.conversation_attempts[0];

  const shared = (await rpc.call("viber.chat", {
    task_id: created.id,
    node_id: first.id,
    profile_id: first.profile_id,
    expected_revision: 2,
    content: "Use the explicitly selected result",
    request_id: randomUUID(),
    history_ids: [],
    inputs: [
      { kind: "attempt-output", attempt_id: source.id },
      { kind: "attempt-verification", attempt_id: source.id },
    ],
  })) as FlowRun;

  await finished(shared);
  expect(engine.flowRuns.attempts(shared.id)[0].inputs[0].content).toBe(source.output);
  expect(engine.flowRuns.attempts(shared.id)[0].inputs[1].content).toContain("observed");
  const other = task();
  const otherNode = (await workspace(other.id)).revision.definition.nodes[0];

  await expect(
    rpc.call("viber.chat", {
      task_id: other.id,
      node_id: otherNode.id,
      profile_id: first.profile_id,
      expected_revision: 1,
      content: "A foreign task must not get this result",
      request_id: randomUUID(),
      history_ids: [],
      inputs: [{ kind: "attempt-output", attempt_id: source.id }],
    }),
  ).rejects.toThrow(/this task|same task/);

  expect(engine.db.detail(other.id).messages).toEqual([]);
  expect(provider.requests).toHaveLength(2);
});

it("finishes task lifecycle independently while preserving missing verification", async () => {
  const created = task();
  const current = await workspace(created.id);

  const run = (await rpc.call("flow.start", {
    flow_id: created.flow_id,
    task_id: created.id,
    revision: 1,
    request_id: randomUUID(),
    goal: created.goal,
  })) as FlowRun;

  await finished(run);
  expect(engine.flowRuns.attempts(run.id)[0].verification).toBe("missing");
  await rpc.call("task.lifecycle", { task_id: created.id, action: "finish" });
  expect(engine.db.task(created.id).status).toBe("completed");
  expect((await workspace(created.id)).attempts[0].verification).toBe("missing");

  await expect(
    rpc.call("flow.start", {
      flow_id: created.flow_id,
      task_id: created.id,
      revision: current.revision.revision,
      request_id: randomUUID(),
      goal: created.goal,
    }),
  ).rejects.toThrow("Reopen");

  await rpc.call("task.lifecycle", { task_id: created.id, action: "reopen" });
  expect(engine.db.task(created.id).status).toBe("not_started");
});

it("offers exactly three valid editable templates and keeps independent reviewers read-only", () => {
  expect(flowTemplates.map((template) => template.id)).toEqual([
    "plan-build",
    "build-review",
    "full",
  ]);

  for (const template of flowTemplates) {
    const graph = FlowDefinitionSchema.parse(instantiateTemplate(template.id, randomUUID));

    const created = engine.createGeneralTask({
      request_id: randomUUID(),
      goal: template.name,
      profile_id: builtInProfiles.implementer,
      template: template.id,
    });

    expect(engine.flows.definition(created.flow_id!).definition.nodes).toHaveLength(
      graph.nodes.length,
    );

    const reviewers = graph.nodes.filter(
      (node) => node.type === "agent" && node.completion.review === "require-approved",
    );

    for (const reviewer of reviewers)
      if (reviewer.type === "agent")
        expect(engine.flows.profile(reviewer.profile_id).execution.access).toBe("read-only");
  }

  expect(provider.requests).toHaveLength(0);
});

it("requires reopening a finished paused task before continuing or retrying execution", async () => {
  const created = task();

  expect(await rpc.call("flow.files", { task_id: created.id })).toMatchObject({
    files: [],
    text: null,
  });

  const release = engine.acquireTerminal(created.id);

  const run = (await rpc.call("flow.start", {
    task_id: created.id,
    flow_id: created.flow_id,
    revision: 1,
    request_id: randomUUID(),
    goal: created.goal,
  })) as FlowRun;

  await rpc.call("flow.pause", { run_id: run.id });
  release();
  await rpc.call("task.lifecycle", { task_id: created.id, action: "finish" });

  await expect(
    rpc.call("flow.continue", { run_id: run.id, request_id: randomUUID() }),
  ).rejects.toThrow("Reopen");

  expect(provider.requests).toHaveLength(0);
  await rpc.call("task.lifecycle", { task_id: created.id, action: "reopen" });
  await rpc.call("flow.continue", { run_id: run.id, request_id: randomUUID() });
  await finished(run);
});

it("refuses archiving a queued flow even when another task owns the only execution slot", async () => {
  engine.db.saveSettings({ ...engine.db.settings(), concurrency: 1 });
  const occupied = task();

  const first = engine.startFlow({
    task_id: occupied.id,
    flow_id: occupied.flow_id!,
    revision: 1,
    request_id: randomUUID(),
    goal: occupied.goal!,
  });

  await finished(first);

  const command = engine.runCommand(occupied.id, [
    process.execPath,
    "-e",
    "setInterval(()=>{},1000)",
  ]);

  const cancelled = command.catch(() => {});
  try {
    const queued = task();

    const run = engine.startFlow({
      task_id: queued.id,
      flow_id: queued.flow_id!,
      revision: 1,
      request_id: randomUUID(),
      goal: queued.goal!,
    });

    expect(engine.flowRuns.run(run.id).status).toBe("queued");
    expect(engine.isActive(queued.id)).toBe(false);

    await expect(rpc.call("task.archive", { id: queued.id, archived: true })).rejects.toMatchObject(
      { kind: "busy" },
    );

    expect(engine.db.task(queued.id).archived).not.toBe(true);
    expect(engine.flowRuns.attempts(run.id)).toEqual([]);
    await engine.cancel(occupied.id);
    await cancelled;
    await finished(run);
    await rpc.call("task.archive", { id: queued.id, archived: true });
    expect(engine.db.task(queued.id).archived).toBe(true);

    expect(() =>
      engine.startFlow({
        task_id: queued.id,
        flow_id: queued.flow_id!,
        revision: 1,
        request_id: randomUUID(),
        goal: queued.goal!,
      }),
    ).toThrow("Reopen this task");

    await rpc.call("task.archive", { id: queued.id, archived: false });
    expect(engine.db.task(queued.id).archived).toBe(false);
  } finally {
    await engine.cancel(occupied.id);
    await cancelled;
  }
});
