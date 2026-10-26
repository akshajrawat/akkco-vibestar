import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FinalizationService } from "../../backend/finalization/service";
import { checked } from "../../backend/execution/runtime/process";
import { defaultSettings, now } from "../../backend/domain";
import {
  createFixtureEngine,
  fixtureRepository,
  FixtureProvider,
  prepareFixtureTask,
} from "../helpers/fixtures";

export const finalizationFixture = async (
  providers: Parameters<typeof createFixtureEngine>[1] = () => new FixtureProvider(),
) => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-issue-git-"));
  const root = join(dir, "data");
  const engine = await createFixtureEngine(root, providers);
  const { repo, upstream } = await fixtureRepository(engine, dir);
  const task = await prepareFixtureTask(engine, repo, randomUUID());
  const fork = join(dir, "fork.git");
  await checked("git", ["clone", "--bare", repo.path, fork], dir);
  await checked("git", ["update-ref", "-d", `refs/heads/${task.branch_name}`], fork);

  await checked(
    "git",
    ["remote", "add", "origin", "https://github.com/contributor/fixture.git"],
    repo.path,
  );

  await checked(
    "git",
    ["remote", "set-url", "upstream", "https://github.com/fixture/fixture.git"],
    repo.path,
  );

  repo.origin_url = "https://github.com/contributor/fixture.git";
  repo.upstream_url = "https://github.com/fixture/fixture.git";
  engine.db.saveRepository(repo);
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

  const identity = {
    id: "fork-42",
    full_name: "contributor/fixture",
    permissions: { push: true },
    fork: true,
    parent: { full_name: "fixture/fixture" },
    viewer: "contributor",
  };

  const transport = (url: string) => {
    if (url !== repo.origin_url) throw new Error("Unexpected test transport");
    return fork;
  };

  const service = new FinalizationService(engine, async () => identity, transport);

  const preview = async (paths = ["source.txt"], replace = false) =>
    service.preview({
      id: task.id,
      request_id: randomUUID(),
      expected_hash: await engine.git.fingerprint(engine.db.task(task.id)),
      paths,
      replace_selected_staged: replace,
    });

  const close = async () => {
    await service.close();
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  };

  return {
    dir,
    root,
    engine,
    repo,
    upstream,
    fork,
    task,
    service,
    identity,
    transport,
    preview,
    close,
  };
};
