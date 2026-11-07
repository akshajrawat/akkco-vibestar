import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Sqlite from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";

import { now, type Task } from "../../backend/domain";
import { Database } from "../../backend/storage/database";
import { migrations } from "../../backend/storage/migrations";
import {
  historicalRuns,
  legacyMigration,
  migrateLegacyTask,
  migrateLegacyTasks,
} from "../../backend/flows/legacy-migration";
import { Rpc } from "../../backend/rpc";
import type { FlowWorkspace } from "../../backend/rpc/flows";
import {
  createFixtureEngine,
  fixtureRepository,
  FixtureProvider,
  plan1,
  plan2,
  prepareFixtureTask,
} from "../helpers/fixtures";
import type { AgentRunRequest } from "../../backend/execution/providers/contracts";

let directory: string;
let engine: Awaited<ReturnType<typeof createFixtureEngine>>;

const forbiddenProvider = () => {
  throw new Error("Historical recovery must not invoke providers");
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "vibestar-legacy-flows-"));
  engine = await createFixtureEngine(join(directory, "data"), forbiddenProvider);
});

afterEach(async () => {
  await engine.close();
  await rm(directory, { recursive: true, force: true });
});

const outputs = {
  1: plan1,
  2: plan2,
  3: {
    summary: "Saved implementation",
    filesChanged: ["source.txt"],
    testsPassed: ["provider report only"],
    testsFailed: [],
    testsSkipped: [],
    remainingRisks: [],
  },
  5: {
    approval: "approved",
    summary: "Saved review",
    findings: [],
    testsRun: [],
    testsNotRun: ["remote CI"],
  },
};

const historicalTask = async (
  status: Task["status"],
  stage: number,
  gate?: Task["approval_gate"],
) => {
  const repositoryRoot = join(directory, randomUUID());
  await mkdir(repositoryRoot);
  const { repo } = await fixtureRepository(engine, repositoryRoot);
  const task = await prepareFixtureTask(engine, repo, randomUUID());

  const configuration = {
    provider: "codex" as const,
    model: "next-model",
    effort: "low",
    timeout_secs: 30,
  };

  engine.db.saveTask({
    ...task,
    status,
    stage,
    scope_mode: "partial",
    claimed_scope: "Preserve the source file",
    notes: "Keep these exclusions",
    approval_gate: gate,
    execution_settings: {
      ...engine.db.settings(),
      antigravity: configuration,
      codex_plan: configuration,
      codex_implementation: configuration,
      antigravity_review: configuration,
    },
  });

  for (const [stage, output] of Object.entries(outputs)) {
    engine.db.run(
      "INSERT INTO task_artifacts VALUES(?,?,?,'plan',?,?)",
      randomUUID(),
      task.id,
      Number(stage),
      JSON.stringify(output),
      now(),
    );
  }

  const runId = randomUUID();

  engine.db.run(
    "INSERT INTO agent_runs(id,task_id,stage,provider,model,effort,prompt,status,started_at,ended_at,output) VALUES(?,?,?,'codex','actual-old-model','high','Original prompt','completed',?,?,?)",
    runId,
    task.id,
    stage,
    now(),
    now(),
    JSON.stringify(outputs[stage as keyof typeof outputs] || plan1),
  );

  engine.db.run(
    "INSERT INTO ai_usage(id,task_id,purpose,provider,model,effort,started_at,status,total_tokens) VALUES(?,?,'pipeline','codex','actual-old-model','high',?,'completed',123)",
    runId,
    task.id,
    now(),
  );

  engine.db.run(
    "INSERT INTO test_runs(id,task_id,run_id,command,status,started_at,exit_code,stdout) VALUES(?,?,?,'npm test','failed',?,1,'Observed failure')",
    randomUUID(),
    task.id,
    runId,
    now(),
  );

  const delivered = randomUUID();
  const pending = randomUUID();
  for (const [id, status] of [
    [delivered, "delivered"],
    [pending, "queued"],
  ])
    engine.db.run(
      "INSERT INTO task_messages(id,task_id,role,content,created_at,status,purpose) VALUES(?,?,'user',?,?,?,'instruction')",
      id,
      task.id,
      status === "delivered" ? "Keep this prior instruction" : "Unselected saved draft",
      now(),
      status,
    );
  return { task: engine.db.task(task.id), runId, delivered, pending };
};

it("converts each saved approval boundary on reopen without inference, fabricated decisions or changes to existing history", async () => {
  const originals = [];
  for (const [gate, stage] of [
    ["antigravity_plan", 1],
    ["codex_plan", 2],
    ["implementation", 3],
    ["final_review", 5],
  ] as const) {
    const fixture = await historicalTask("awaiting_approval", stage, gate);

    originals.push({
      ...fixture,
      raw: engine.db.all<{ data: string }>("SELECT data FROM tasks WHERE id=?", fixture.task.id)[0]
        .data,
      detail: engine.db.detail(fixture.task.id),
    });
  }

  await engine.close();
  for (let reopen = 0; reopen < 2; reopen++) {
    engine = await createFixtureEngine(join(directory, "data"), forbiddenProvider);
    await engine.drain();
    for (const original of originals) {
      const task = engine.db.task(original.task.id);
      const record = legacyMigration(engine.db, task.id)!;

      expect(record).toMatchObject({
        state: "converted",
        original_status: "awaiting_approval",
        original_stage: original.task.stage,
      });

      expect(task).toMatchObject({
        id: original.task.id,
        flow_id: record.flow_id,
        worktree_path: original.task.worktree_path,
        branch_name: original.task.branch_name,
        status: "not_started",
      });

      expect(engine.flows.definition(task.flow_id!, 1).definition.nodes).toHaveLength(8);
      const checkpoint = engine.flowRuns.run(record.checkpoint_run_id!);
      expect(checkpoint).toMatchObject({ status: "waiting", origin: "historical" });
      const graph = engine.flows.definition(checkpoint.flow_id, checkpoint.revision).definition;
      expect(graph.nodes[0]).toMatchObject({ id: record.boundary_node_id, type: "approval" });
      expect(engine.flowRuns.attempts(checkpoint.id)).toEqual([]);

      expect(
        engine.db.all("SELECT data FROM flow_migration_sources WHERE task_id=?", task.id),
      ).toEqual([{ data: original.raw }]);

      const detail = engine.db.detail(task.id);
      for (const key of ["runs", "messages", "artifacts", "tests", "usage"] as const)
        expect(detail[key]).toEqual(original.detail[key]);
      expect(await readFile(join(task.worktree_path, "source.txt"), "utf8")).toBe("base\n");
      expect(detail.runs[0]).toMatchObject({ execution: null, model: "actual-old-model" });
      for (const node of graph.nodes.filter((node) => node.type === "agent")) {
        expect(node.inputs).toContainEqual({ kind: "message", message_id: original.delivered });
        expect(node.inputs).not.toContainEqual({ kind: "message", message_id: original.pending });
      }
    }

    expect(engine.db.all("SELECT id FROM flow_runs")).toHaveLength(4);
    expect(engine.db.all("SELECT id FROM flow_dispatches")).toHaveLength(0);
    expect(engine.db.all("SELECT attempt_id FROM flow_approval_decisions")).toHaveLength(0);
    expect(engine.db.all("PRAGMA foreign_key_check")).toEqual([]);
    if (reopen === 0) await engine.close();
  }
});

it("requires a new explicit checkpoint inspection before approval and captures owned artifacts and observed failed checks", async () => {
  const original = await historicalTask("awaiting_approval", 1, "antigravity_plan");
  const imported = migrateLegacyTask(engine.db, original.task.id)!;
  const runId = imported.checkpoint_run_id!;
  expect(engine.flowRuns.attempts(runId)).toHaveLength(0);
  const rpc = new Rpc(engine);
  try {
    const workspace = (await rpc.call("flow.workspace", {
      task_id: original.task.id,
    })) as FlowWorkspace;

    expect(workspace.history?.migration).toMatchObject({
      original_status: "awaiting_approval",
      boundary_node_id: imported.boundary_node_id,
    });

    await expect(rpc.call("task.approve", { id: original.task.id })).rejects.toMatchObject({
      kind: "invalid_method",
    });

    await rpc.call("flow.continue", { run_id: runId, request_id: randomUUID() });

    await expect
      .poll(
        () => engine.flowRuns.run(runId).status === "waiting" && !engine.isActive(original.task.id),
      )
      .toBe(true);

    const attempt = engine.flowRuns.attempts(runId)[0];

    expect(attempt).toMatchObject({
      status: "waiting",
      node_id: imported.boundary_node_id,
      agent_run_id: null,
    });

    expect(
      attempt.inputs.some(
        (input) => input.binding.kind === "artifact" && input.content.includes("Fixture plan"),
      ),
    ).toBe(true);

    expect(
      attempt.inputs.some(
        (input) =>
          input.binding.kind === "command-evidence" && input.content.includes("Observed failure"),
      ),
    ).toBe(true);

    expect(engine.db.all("SELECT attempt_id FROM flow_approval_decisions")).toHaveLength(0);

    await rpc.call("flow.node.approve", {
      attempt_id: attempt.id,
      request_id: randomUUID(),
      decision: "rejected",
      configuration_hash: attempt.configuration_hash,
      inputs_hash: attempt.inputs_hash,
      workspace_fingerprint: attempt.workspace_fingerprint,
    });

    expect(engine.flowRuns.attempt(attempt.id).status).toBe("rejected");
    expect(engine.db.detail(original.task.id).runs).toHaveLength(1);

    expect(historicalRuns(engine.db, original.task.id, 1).map((run) => run.id)).toEqual([
      original.runId,
    ]);
  } finally {
    await rpc.close();
  }
});

it("retains cancelled, failed and interrupted checkpoints and never queues them on reopen", async () => {
  for (const status of ["cancelled", "failed", "interrupted"] as const) {
    const original = await historicalTask(status, 2);
    const record = migrateLegacyTask(engine.db, original.task.id)!;
    expect(record.state).toBe("converted");
    const run = engine.flowRuns.run(record.checkpoint_run_id!);
    expect(run.status).toBe(status);
    const first = engine.flows.definition(run.flow_id, run.revision).definition.nodes[0];
    expect(first.type).toBe("agent");
    expect(first.inputs.some((input) => input.kind === "artifact")).toBe(true);
  }

  await engine.close();
  engine = await createFixtureEngine(join(directory, "data"), forbiddenProvider);
  await engine.drain();
  expect(engine.db.all("SELECT id FROM flow_dispatches")).toEqual([]);
  expect(engine.db.all("SELECT id FROM flow_node_attempts")).toEqual([]);
});

it("continues an imported stopped node only on request through explicit settings and selected historical handoffs", async () => {
  const original = await historicalTask("interrupted", 2);
  const record = migrateLegacyTask(engine.db, original.task.id)!;
  const prior = engine.db.detail(original.task.id);
  const requests: AgentRunRequest[] = [];
  await engine.close();

  engine = await createFixtureEngine(join(directory, "data"), () => ({
    ...new FixtureProvider(),
    invocation: (request) => {
      requests.push(request);
      return new FixtureProvider().invocation({ ...request, stage: 2 });
    },
  }));

  await engine.drain();
  expect(requests).toEqual([]);
  engine.continueFlow({ run_id: record.checkpoint_run_id!, request_id: randomUUID() });

  await expect
    .poll(
      () =>
        engine.flowRuns.run(record.checkpoint_run_id!).status === "waiting" &&
        !engine.isActive(original.task.id),
      { timeout: 10000 },
    )
    .toBe(true);

  expect(requests).toHaveLength(1);

  expect(requests[0]).toMatchObject({
    stage: 0,
    access: "read-only",
    config: { model: "next-model", effort: "low" },
  });

  const attempts = engine.flowRuns.attempts(record.checkpoint_run_id!);
  const agent = attempts.find((attempt) => attempt.configuration.node.type === "agent")!;
  expect(agent).toMatchObject({ node_id: record.boundary_node_id, status: "completed" });

  expect(agent.configuration.agent?.execution).toMatchObject({
    output: "refinement",
    access: "read-only",
  });

  expect(
    agent.inputs.some(
      (input) => input.binding.kind === "artifact" && input.content.includes("Fixture plan"),
    ),
  ).toBe(true);

  expect(
    agent.inputs.some(
      (input) =>
        input.binding.kind === "task-brief" && input.content.includes("Keep these exclusions"),
    ),
  ).toBe(true);

  expect(
    agent.inputs.some(
      (input) => input.binding.kind === "message" && input.binding.message_id === original.pending,
    ),
  ).toBe(false);

  expect(agent.agent_run_id).not.toBe(original.runId);

  expect(engine.db.detail(original.task.id).runs.find((run) => run.id === original.runId)).toEqual(
    prior.runs[0],
  );

  expect(engine.db.detail(original.task.id).messages).toEqual(prior.messages);
  expect(engine.db.all("SELECT attempt_id FROM flow_approval_decisions")).toEqual([]);
});

it("rolls back incomplete translation, retains corrupt source bytes and exposes a recovery diagnostic", async () => {
  const original = await historicalTask("awaiting_approval", 2, "codex_plan");

  const raw = engine.db.all<{ data: string }>(
    "SELECT data FROM tasks WHERE id=?",
    original.task.id,
  )[0].data;

  engine.db.run(
    "UPDATE task_artifacts SET content='{broken original artifact' WHERE task_id=? AND stage=2",
    original.task.id,
  );

  const profiles = engine.db.all("SELECT * FROM agent_profiles");
  const record = migrateLegacyTask(engine.db, original.task.id)!;

  expect(record).toMatchObject({
    state: "needs_recovery",
    flow_id: null,
    checkpoint_run_id: null,
    diagnostic: expect.stringContaining("original data is preserved"),
  });

  expect(engine.db.all("SELECT data FROM tasks WHERE id=?", original.task.id)).toEqual([
    { data: raw },
  ]);

  expect(engine.db.all("SELECT * FROM agent_profiles")).toEqual(profiles);
  expect(engine.db.all("SELECT id FROM flow_definitions")).toEqual([]);

  expect(
    engine.db.all(
      "SELECT content FROM task_artifacts WHERE task_id=? AND stage=2",
      original.task.id,
    ),
  ).toEqual([{ content: "{broken original artifact" }]);

  const corrupt = "{original task bytes sk-fixturecredential123456";
  engine.db.run("UPDATE tasks SET data=? WHERE id=?", corrupt, original.task.id);
  const broken = migrateLegacyTask(engine.db, original.task.id)!;
  expect(broken.state).toBe("needs_recovery");
  expect(broken.source_hash).toBe(createHash("sha256").update(corrupt).digest("hex"));
  expect(broken.diagnostic).not.toContain("fixturecredential");

  expect(
    engine.db.all(
      "SELECT data FROM flow_migration_sources WHERE task_id=? ORDER BY rowid",
      original.task.id,
    ),
  ).toEqual([{ data: raw }, { data: corrupt }]);

  expect(() => engine.db.run("UPDATE flow_migration_sources SET data='changed'")).toThrow(
    "immutable",
  );
});

it("refuses a stale imported final review before creating an approvable attempt", async () => {
  const original = await historicalTask("awaiting_approval", 5, "final_review");
  const fingerprint = await engine.git.fingerprint(original.task);
  engine.db.saveTask({ ...original.task, final_review_hash: fingerprint });
  const record = migrateLegacyTask(engine.db, original.task.id)!;

  await writeFile(
    join(original.task.worktree_path, "source.txt"),
    "Changed since the old review\n",
  );

  engine.continueFlow({ run_id: record.checkpoint_run_id!, request_id: randomUUID() });

  await expect
    .poll(() => engine.flowRuns.run(record.checkpoint_run_id!).status, { timeout: 10000 })
    .toBe("failed");

  expect(engine.flowRuns.run(record.checkpoint_run_id!).error).toContain(
    "fresh read-only Reviewer",
  );

  expect(engine.flowRuns.attempts(record.checkpoint_run_id!)).toHaveLength(0);
  expect(engine.db.all("SELECT attempt_id FROM flow_approval_decisions")).toEqual([]);
  expect(engine.db.detail(original.task.id).artifacts).toHaveLength(4);
});

it("preserves corrupt migration-journal bytes without blocking other task history", async () => {
  const original = await historicalTask("cancelled", 1);
  const record = migrateLegacyTask(engine.db, original.task.id)!;
  const raw = '{"unsupported":"original migration journal"}';
  engine.db.run("UPDATE flow_task_migrations SET data=? WHERE task_id=?", raw, original.task.id);

  expect(() => migrateLegacyTask(engine.db, original.task.id)).toThrow(
    "could not be decoded safely",
  );

  migrateLegacyTasks(engine.db);

  expect(
    engine.db.all("SELECT data FROM flow_task_migrations WHERE task_id=?", original.task.id),
  ).toEqual([{ data: raw }]);

  expect(engine.db.task(original.task.id).flow_id).toBe(record.flow_id);
  expect(engine.db.detail(original.task.id).runs).toHaveLength(1);

  expect(engine.db.records.diagnostics()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ table_name: "flow_task_migrations", record_id: original.task.id }),
    ]),
  );
});

it("keeps unsupported historical IDs readable with a recovery diagnostic and never manufactures settings for history", async () => {
  const { repo } = await fixtureRepository(engine, directory);
  const task = await prepareFixtureTask(engine, repo, "original-non-UUID-task");
  const record = migrateLegacyTask(engine.db, task.id)!;
  expect(record.state).toBe("needs_recovery");
  engine.db.run("INSERT INTO settings VALUES('pipeline','{corrupt original settings')");
  const rpc = new Rpc(engine);
  try {
    const history = await rpc.call("flow.history", { task_id: task.id });

    expect(history).toMatchObject({
      migration: { task_id: task.id, diagnostic: expect.stringContaining("identity") },
      definition: null,
    });

    const detail = await rpc.call("task.detail", { id: task.id });
    expect(detail).toMatchObject({ task: { id: task.id, status: "cancelled" } });
    expect((detail as { task: Task }).task.execution_settings).toBeUndefined();
    await expect(rpc.call("task.archive", { id: task.id })).rejects.toThrow();
    expect(engine.db.task(task.id).id).toBe(task.id);
    expect(engine.db.all("SELECT id FROM flow_runs")).toEqual([]);
  } finally {
    await rpc.close();
  }
});

it("upgrades a version-34 database with a backup and preserves missing historical execution and approval evidence", async () => {
  const path = join(directory, "v34.sqlite");
  const old = new Sqlite(path);
  for (const migration of migrations.filter((entry) => entry.version <= 34)) {
    old.exec(migration.sql);

    old
      .prepare("INSERT OR IGNORE INTO schema_migrations VALUES(?,?)")
      .run(migration.version, "before");
  }

  const id = randomUUID();
  const source = "{incomplete historical source bytes";

  old
    .prepare(
      "INSERT INTO tasks(id,status,stage,data,created_at) VALUES(?,'cancelled',2,?,'before')",
    )
    .run(id, source);

  old.close();
  for (let reopen = 0; reopen < 2; reopen++) {
    const db = await Database.open(path);
    try {
      migrateLegacyTasks(db);

      expect(legacyMigration(db, id)).toMatchObject({
        original_status: "cancelled",
        original_stage: 2,
        state: "needs_recovery",
      });

      expect(db.all("SELECT data FROM tasks")).toEqual([{ data: source }]);
      expect(db.all("SELECT data FROM flow_migration_sources")).toEqual([{ data: source }]);
      expect(db.all("SELECT id FROM flow_runs")).toEqual([]);
      expect(db.all("SELECT attempt_id FROM flow_approval_decisions")).toEqual([]);
      expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  }

  const backups = (await readdir(directory)).filter((name) => name.includes("before-v34"));
  expect(backups).toHaveLength(1);
  const backup = new Sqlite(join(directory, backups[0]), { readonly: true });
  try {
    expect(backup.prepare("SELECT data FROM tasks").get()).toEqual({ data: source });
  } finally {
    backup.close();
  }
});

it("preserves an uncaptured historical configuration instead of substituting current provider defaults", async () => {
  const original = await historicalTask("interrupted", 1);
  const task = engine.db.task(original.task.id);
  engine.db.saveTask({ ...task, execution_settings: undefined });
  const raw = engine.db.all<{ data: string }>("SELECT data FROM tasks WHERE id=?", task.id)[0].data;
  const profiles = engine.db.all("SELECT * FROM agent_profiles");
  const priorRuns = engine.db.all("SELECT * FROM agent_runs");
  const record = migrateLegacyTask(engine.db, task.id)!;

  expect(record).toMatchObject({
    state: "needs_recovery",
    flow_id: null,
    checkpoint_run_id: null,
    diagnostic: expect.stringContaining("current defaults cannot prove"),
  });

  expect(engine.db.all("SELECT data FROM tasks WHERE id=?", task.id)).toEqual([{ data: raw }]);

  expect(engine.db.all("SELECT data FROM flow_migration_sources WHERE task_id=?", task.id)).toEqual(
    [{ data: raw }],
  );

  expect(engine.db.all("SELECT * FROM agent_profiles")).toEqual(profiles);
  expect(engine.db.all("SELECT id FROM flow_runs")).toEqual([]);
  expect(engine.db.all("SELECT * FROM agent_runs")).toEqual(priorRuns);
  await engine.drain();
  expect(engine.db.all("SELECT id FROM flow_dispatches")).toEqual([]);
});
