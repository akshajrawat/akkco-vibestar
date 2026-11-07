import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  rmdir,
  mkdir,
  rename,
  symlink,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { z } from "zod";

import { AgentProfileSchema } from "../../backend/flows/contracts";
import { agentNodePrompt } from "../../backend/flows/run-contracts";
import { resolveNodeInputs } from "../../backend/flows/context";
import { AgentRunner } from "../../backend/execution/agents/agent-runner";
import { StorageService } from "../../backend/storage/service";
import {
  assertManagedWorkspace,
  prepareManagedWorkspace,
  managedWorkspaceFingerprint,
} from "../../backend/workspace/managed";
import { createLayout, exists } from "../../backend/workspace/paths";
import { Database } from "../../backend/storage/database";
import { gitChecked } from "../../backend/workspace/git-command";
import { migrateDataRoot } from "../../backend/storage/migrate-root";
import { createFixtureEngine, FixtureProvider, fixtureRepository } from "../helpers/fixtures";

let directory: string;
let engine: Awaited<ReturnType<typeof createFixtureEngine>>;

const forbidden = () => {
  throw new Error("General task creation/recovery must not invoke providers");
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "vibestar-general-workspace-"));
  engine = await createFixtureEngine(join(directory, "data"), forbidden);
});

afterEach(async () => {
  await engine.close();
  await rm(directory, { recursive: true, force: true });
});

const create = (repositoryId: string | null = null) => {
  const profile = AgentProfileSchema.parse({
    id: randomUUID(),
    revision: 1,
    name: "My Viber",
    instructions: "Work only on the selected goal.",
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

  const request = {
    request_id: randomUUID(),
    goal: "Draft a local project",
    repository_id: repositoryId,
    profile_id: profile.id,
  };

  const task = engine.createGeneralTask(request);
  const flowId = z.string().uuid().parse(task.flow_id);
  return { profile, request, task, flowId };
};

it("creates and reopens general tasks in the existing task model without fabricated issue/repository records or inference", async () => {
  const { task, request, flowId } = create();
  expect(engine.createGeneralTask(request)).toEqual(task);

  expect(task).toMatchObject({
    kind: "general",
    goal: request.goal,
    repo_id: null,
    issue_number: null,
    issue_url: null,
    workspace_kind: "managed",
    worktree_path: "",
    status: "not_started",
  });

  expect(() => engine.createGeneralTask({ ...request, goal: "Changed request" })).toThrow(
    "different payload",
  );

  expect(engine.db.all("SELECT * FROM repositories")).toEqual([]);
  expect(engine.db.all("SELECT * FROM issues")).toEqual([]);
  expect(engine.db.all("SELECT * FROM agent_runs")).toEqual([]);
  expect(engine.db.all("SELECT * FROM ai_usage")).toEqual([]);
  expect(await exists(join(engine.root, "workspaces", task.id))).toBe(false);
  expect(engine.flows.definition(flowId).definition.nodes).toHaveLength(1);
  expect(engine.db.all("PRAGMA foreign_key_check")).toEqual([]);
  await engine.close();
  engine = await createFixtureEngine(join(directory, "data"), forbidden);
  expect(engine.db.task(task.id)).toEqual(task);
  expect(engine.createGeneralTask(request)).toEqual(task);
});

it("prepares an attached repository for a general goal without a fake issue or stage advancement on restart", async () => {
  const { repo } = await fixtureRepository(engine, directory);
  const { task } = create(repo.id);
  expect(task.repo_id).toBe(repo.id);
  expect(task.issue_url).toBeNull();
  expect(task.issue_number).toBeNull();
  await engine.git.prepare(repo, task);
  engine.db.saveTask(task);
  expect(task.branch_name).toContain(`task-${task.id}`);
  expect(task.branch_name).toContain("draft-a-local-project");
  expect(await engine.git.assertTask(task)).toBe(task.worktree_path);
  await engine.close();
  engine = await createFixtureEngine(join(directory, "data"), forbidden);

  expect(engine.db.task(task.id)).toMatchObject({
    kind: "general",
    stage: 0,
    status: "not_started",
    worktree_path: task.worktree_path,
  });
});

it("refuses graph execution after its Git metadata owner changes and preserves the checkout", async () => {
  const { repo } = await fixtureRepository(engine, directory);
  const { task, flowId } = create(repo.id);
  await engine.git.prepare(repo, task);
  engine.db.saveTask(task);
  expect(await engine.git.assertOwnedTask(task)).toBe(task.worktree_path);
  const gitdir = await gitChecked(["rev-parse", "--absolute-git-dir"], task.worktree_path);
  await writeFile(join(gitdir, "vibestar-task-owner"), randomUUID());

  const run = engine.startFlow({
    task_id: task.id,
    flow_id: flowId,
    revision: 1,
    goal: task.goal!,
    request_id: randomUUID(),
  });

  await expect.poll(() => engine.flowRuns.run(run.id).status).toBe("failed");
  expect(engine.flowRuns.run(run.id).error).toContain("ownership changed");
  expect(engine.db.all("SELECT id FROM agent_runs WHERE task_id=?", task.id)).toHaveLength(0);
  expect(await readFile(join(task.worktree_path, "source.txt"), "utf8")).toBe("base\n");
});

it("executes an explicitly writable repository-free Viber in the real sandbox and preserves its files when cache is cleared", async () => {
  const created = create();
  const task = await prepareManagedWorkspace(engine.root, created.task);
  engine.db.saveTask(task);
  const owner = join(dirname(task.worktree_path), "vibestar-task-owner");
  const canary = join(directory, "private-canary");
  await writeFile(canary, "private bytes");
  const fixture = new FixtureProvider();

  const runner = new AgentRunner(engine.root, engine.db, engine.git, engine.publish, () => ({
    ...fixture,
    invocation: () => ({
      program: process.execPath,
      args: [
        "-e",
        `
      (async () => {
        const fs = require('node:fs/promises');
        for (const path of ${JSON.stringify([owner, canary, join(engine.root, "state", "vibestar.sqlite")])}) {
          try { await fs.readFile(path); throw Error('Host state was exposed'); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        await fs.writeFile('note.txt', 'A managed edit\\n');
        console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({summary:'managed edit'})}}));
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `,
      ],
    }),
  }));

  const run = engine.flowRuns.createRun({
    flow_id: created.flowId,
    revision: 1,
    task_id: task.id,
    request_id: randomUUID(),
    goal: created.request.goal,
  });

  engine.flowRuns.setRunStatus(run.id, "queued", "running");
  const node = engine.flows.definition(created.flowId).definition.nodes[0];
  const before = await engine.git.fingerprint(task);

  const attempt = engine.flowRuns.beginAttempt(
    run.id,
    node.id,
    resolveNodeInputs(engine.db, engine.flowRuns, run.id, node.id),
    before,
  );

  const result = await runner.runConfigured(
    task,
    new AbortController().signal,
    created.profile.execution,
    { prompt: agentNodePrompt(attempt), purpose: "Solo Viber", nodeAttemptId: attempt.id },
  );

  expect(result).toEqual({ summary: "managed edit" });
  engine.flowRuns.finishAttempt(attempt.id, "completed", JSON.stringify(result), "missing");
  engine.flowRuns.setRunStatus(run.id, "running", "completed");
  expect(await engine.git.fingerprint(task)).not.toBe(before);
  expect(await readFile(join(task.worktree_path, "note.txt"), "utf8")).toBe("A managed edit\n");
  expect(await readFile(owner, "utf8")).toBe(task.id);

  expect(engine.db.all("SELECT repository FROM ai_usage WHERE task_id=?", task.id)).toEqual([
    { repository: null },
  ]);

  await new StorageService(engine).clear("cache");
  expect(await readFile(join(task.worktree_path, "note.txt"), "utf8")).toBe("A managed edit\n");
  await engine.close();
  engine = await createFixtureEngine(join(directory, "data"), forbidden);

  expect(engine.db.task(task.id)).toMatchObject({
    stage: 0,
    status: "not_started",
    worktree_path: task.worktree_path,
  });

  expect(engine.flowRuns.run(run.id).status).toBe("completed");
  expect(engine.db.all("SELECT id FROM agent_runs WHERE task_id=?", task.id)).toHaveLength(1);
});

it("keeps manual command access read-only when requested and honors terminal exclusion for general workspaces", async () => {
  const { task: saved } = create();
  const task = await prepareManagedWorkspace(engine.root, saved);
  engine.db.saveTask(task);
  const release = engine.acquireTerminal(task.id);
  try {
    await expect(
      engine.runCommand(task.id, [process.execPath, "-e", "process.exit(0)"]),
    ).rejects.toMatchObject({ kind: "invalid_state" });
  } finally {
    release();
  }

  const result = await engine.runCommand(
    task.id,
    [
      process.execPath,
      "-e",
      "try { require('node:fs').writeFileSync('forbidden.txt','bad'); process.exitCode=2; } catch(error) { if(error.code!=='EROFS')throw error; console.log('read-only'); }",
    ],
    true,
  );

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("read-only");
  expect(await exists(join(task.worktree_path, "forbidden.txt"))).toBe(false);
});

it("links controlled command nodes to actual evidence and delivers selected context as JSON stdin", async () => {
  const { task: saved, flowId, request } = create();
  const task = await prepareManagedWorkspace(engine.root, saved);
  engine.db.saveTask(task);

  const node = {
    id: randomUUID(),
    name: "Read selected context",
    type: "command" as const,
    inputs: [{ kind: "task-goal" as const }],
    argv: [
      process.execPath,
      "-e",
      "let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>console.log(JSON.parse(input).inputs[0].content));",
    ],
    access: "read-only" as const,
    timeout_secs: 30,
  };

  engine.flows.saveDefinition(flowId, { name: "Command flow", nodes: [node], edges: [] }, 1);

  const run = engine.flowRuns.createRun({
    flow_id: flowId,
    revision: 2,
    task_id: task.id,
    request_id: randomUUID(),
    goal: request.goal,
  });

  engine.flowRuns.setRunStatus(run.id, "queued", "running");

  const attempt = engine.flowRuns.beginAttempt(
    run.id,
    node.id,
    resolveNodeInputs(engine.db, engine.flowRuns, run.id, node.id),
    await engine.git.fingerprint(task),
  );

  await expect(
    engine.manual(task.id, ["different-command"], undefined, true, undefined, {
      readOnly: true,
      timeoutMs: 30000,
      nodeAttemptId: attempt.id,
    }),
  ).rejects.toMatchObject({ kind: "isolation" });

  expect(engine.db.all("SELECT * FROM test_runs")).toHaveLength(0);

  const result = await engine.manual(task.id, node.argv, undefined, true, undefined, {
    readOnly: true,
    timeoutMs: 30000,
    nodeAttemptId: attempt.id,
  });

  expect(result.code).toBe(0);
  expect(result.stdout.trim()).toBe(request.goal);
  const linked = engine.flowRuns.attempt(attempt.id);
  expect(linked.command_run_id).not.toBeNull();

  expect(
    engine.flowRuns.finishAttempt(
      attempt.id,
      "completed",
      JSON.stringify({ command_run_id: linked.command_run_id }),
      "missing",
    ),
  ).toMatchObject({ status: "completed", verification: "missing" });

  expect(
    engine.db.all("SELECT task_id,status FROM test_runs WHERE id=?", linked.command_run_id),
  ).toEqual([{ task_id: task.id, status: "passed" }]);
});

it("preserves unknown directories and rejects aliases, hard links and changed managed ownership", async () => {
  const { task } = create();
  const ownerDirectory = join(engine.root, "workspaces", task.id);
  await mkdir(ownerDirectory);
  await writeFile(join(ownerDirectory, "personal.txt"), "preserve me");

  await expect(prepareManagedWorkspace(engine.root, task)).rejects.toMatchObject({
    kind: "ownership",
  });

  expect(await readFile(join(ownerDirectory, "personal.txt"), "utf8")).toBe("preserve me");
  const second = await prepareManagedWorkspace(engine.root, create().task);
  const foreign = join(directory, "foreign");
  await mkdir(foreign);
  await writeFile(join(foreign, "source.txt"), "private");
  await rename(second.worktree_path, `${second.worktree_path}-kept`);
  await symlink(foreign, second.worktree_path);
  await expect(assertManagedWorkspace(engine.root, second)).rejects.toThrow();
  await rm(second.worktree_path);
  await rename(`${second.worktree_path}-kept`, second.worktree_path);
  await link(join(foreign, "source.txt"), join(second.worktree_path, "alias.txt"));

  await expect(managedWorkspaceFingerprint(engine.root, second)).rejects.toMatchObject({
    kind: "ownership",
  });

  expect(await readFile(join(foreign, "source.txt"), "utf8")).toBe("private");
  await writeFile(join(dirname(second.worktree_path), "vibestar-task-owner"), "another owner");

  await expect(assertManagedWorkspace(engine.root, second)).rejects.toMatchObject({
    kind: "ownership",
  });
});

it("shares the global command capacity across repository-free task owners", async () => {
  engine.db.saveSettings({ ...engine.db.settings(), concurrency: 1 });
  const a = await prepareManagedWorkspace(engine.root, create().task);
  const b = await prepareManagedWorkspace(engine.root, create().task);
  engine.db.saveTask(a);
  engine.db.saveTask(b);
  const first = engine.runCommand(a.id, [process.execPath, "-e", "console.log('first slot')"]);

  await expect(
    engine.runCommand(b.id, [process.execPath, "-e", "console.log('second slot')"]),
  ).rejects.toMatchObject({ kind: "busy" });

  expect((await first).code).toBe(0);
  await expect.poll(() => engine.isActive(a.id)).toBe(false);

  expect(
    (await engine.runCommand(b.id, [process.execPath, "-e", "console.log('second slot')"])).code,
  ).toBe(0);
});

it("moves managed task data through the existing data-root migration while preserving the source and run history", async () => {
  const { task: saved, flowId, request } = create();
  const task = await prepareManagedWorkspace(engine.root, saved);
  engine.db.saveTask(task);
  await writeFile(join(task.worktree_path, "note.txt"), "Keep these bytes");

  const run = engine.flowRuns.createRun({
    flow_id: flowId,
    revision: 1,
    task_id: task.id,
    goal: request.goal,
    request_id: randomUUID(),
  });

  const source = engine.root;
  const target = join(directory, "relocated");
  await engine.close();
  await migrateDataRoot(source, target);
  engine = await createFixtureEngine(target, forbidden);
  const moved = engine.db.task(task.id);
  expect(moved.worktree_path).toBe(join(target, "workspaces", task.id, "files"));
  expect(await assertManagedWorkspace(target, moved)).toBe(moved.worktree_path);
  expect(await readFile(join(moved.worktree_path, "note.txt"), "utf8")).toBe("Keep these bytes");
  expect(await readFile(join(task.worktree_path, "note.txt"), "utf8")).toBe("Keep these bytes");

  expect(engine.flowRuns.run(run.id)).toMatchObject({
    status: "interrupted",
    snapshot: run.snapshot,
  });

  expect(engine.db.all("SELECT * FROM agent_runs")).toEqual([]);
  expect(engine.db.all("PRAGMA foreign_key_check")).toEqual([]);
});

it("does not adopt a new workspace category while recovering a historical migration journal", async () => {
  create();
  const source = engine.root;
  await engine.close();
  const target = await createLayout(join(directory, "historical-target"));
  const staging = await createLayout(join(target, "cache", `migration-${randomUUID()}`));
  await rmdir(join(staging, "workspaces"));
  const original = await Database.open(join(source, "state", "vibestar.sqlite"));
  try {
    await original.backup(join(staging, "state", "vibestar.sqlite"));
  } finally {
    original.close();
  }

  await rename(join(staging, "state"), join(target, "state"));

  await writeFile(
    join(target, "runtime", "migration-pending.json"),
    JSON.stringify({ source, target, staging }),
  );

  const personal = join(target, "workspaces", "personal.txt");
  await writeFile(personal, "Keep this unrelated destination file");

  await expect(migrateDataRoot(source, target)).rejects.toThrow(
    "Destination workspaces is not empty",
  );

  expect(await readFile(personal, "utf8")).toBe("Keep this unrelated destination file");
  expect(await exists(join(source, "state", "vibestar.sqlite"))).toBe(true);
});
