import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultSettings, now } from "../../backend/domain";
import {
  createFixtureEngine,
  fixtureRepository,
  FixtureProvider,
  prepareFixtureTask,
} from "./fixtures";

export const reviewedTaskFixture = async (
  providers: Parameters<typeof createFixtureEngine>[1] = () => new FixtureProvider(),
) => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-reviewed-task-"));
  const root = join(dir, "data");
  const engine = await createFixtureEngine(root, providers);
  const { repo } = await fixtureRepository(engine, dir);
  const task = await prepareFixtureTask(engine, repo, randomUUID());
  await writeFile(join(task.worktree_path, "source.txt"), "independently reviewed change\n");
  task.status = "ready_for_review";
  task.stage = 6;

  task.execution_settings = {
    ...defaultSettings,
    antigravity: { model: "next-model", effort: "low", timeout_secs: 30 },
  };

  task.final_review_hash = await engine.git.fingerprint(task);
  engine.db.saveTask(task);

  engine.db.run(
    "INSERT INTO agent_runs(id,task_id,stage,provider,model,effort,prompt,status,started_at,ended_at,exit_code,purpose) VALUES(?,?,3,'codex','next-model','low','Saved fixture implementation; no real inference','completed',?,?,0,'fixture implementation')",
    randomUUID(),
    task.id,
    now(),
    now(),
  );

  const diffCheck = await engine.runCommand(task.id, [
    "git",
    "diff",
    "--check",
    task.base_commit_sha,
    "--",
  ]);

  if (diffCheck.code !== 0)
    throw new Error(`Fixture pinned-base validation failed: ${diffCheck.stderr}`);

  engine.db.run(
    "INSERT INTO task_artifacts VALUES(?,?,3,'plan',?,?)",
    randomUUID(),
    task.id,
    JSON.stringify({
      summary: "Fixture implementation",
      filesChanged: ["source.txt"],
      testsPassed: [],
      testsFailed: [],
      testsSkipped: [],
      remainingRisks: [],
    }),
    now(),
  );

  engine.db.run(
    "INSERT INTO task_artifacts VALUES(?,?,5,'plan',?,?)",
    randomUUID(),
    task.id,
    JSON.stringify({
      approval: "approved",
      summary: "Independent fixture review",
      findings: [],
      testsRun: ["fixture"],
      testsNotRun: [],
    }),
    now(),
  );

  const close = async () => {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  };

  return { dir, root, engine, repo, task, close };
};
