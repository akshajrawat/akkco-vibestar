import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { checked } from "../../apps/core/execution/runtime/process";
import { now, type Repository, type WorkspaceAssignment } from "../../apps/core/domain";
import { Engine } from "../../apps/core/execution/engine";
import type { GitHubClient } from "../../apps/core/github/client";
import type { ProviderDetection } from "../../apps/core/execution/providers/contracts";
import { createTestProfiles } from "./viber-fixtures";

const fixtureTransport = (url: string) => {
  if (!isAbsolute(url)) {
    throw new Error("Fixture Git network is disabled; supply a local constructor transport.");
  }

  return url;
};

export const createFixtureEngine = async (
  root: string,
  providers?: Parameters<typeof Engine.create>[1],
  gitHubClient?: GitHubClient,
) => {
  const engine = await Engine.create(root, providers, fixtureTransport, gitHubClient);
  createTestProfiles(engine.db);

  return engine;
};

export const fixtureRepository = async (engine: Engine, dir: string) => {
  const upstream = join(dir, "upstream");
  await mkdir(upstream);
  await checked("git", ["init", "-b", "main"], upstream);
  await checked("git", ["config", "user.email", "test@example.invalid"], upstream);
  await checked("git", ["config", "user.name", "Integration Test"], upstream);
  await writeFile(join(upstream, "source.txt"), "base\n");
  await checked("git", ["add", "."], upstream);
  await checked("git", ["commit", "-m", "base"], upstream);
  const id = randomUUID();
  const path = join(engine.root, "repos", id);
  await engine.git.clone(upstream, path);

  const repo: Repository = {
    id,
    owner: "fixture",
    name: "fixture",
    upstream_url: upstream,
    origin_url: null,
    base_branch: "main",
    path,
    last_fetched: null,
    created_at: now(),
  };

  engine.db.saveRepository(repo);
  return { repo };
};

export const detectFixtureProvider = async (): Promise<ProviderDetection> => ({
  provider: "codex",
  installed: true,
  version: "codex-test-fixture",
  connected: true,
  models: [
    { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", supportedEfforts: ["low", "xhigh"] },
    { id: "next-model", label: "Next Model", supportedEfforts: ["low", "high"] },
  ],
  efforts: ["low", "high", "xhigh"],
  capabilities: ["exec", "models", "native-conversations"],
  error: null,
});

export const prepareFixtureTask = async (
  engine: Engine,
  repo: Repository,
  id: string,
): Promise<WorkspaceAssignment> => {
  const assignment: WorkspaceAssignment = {
    id,
    repo_id: repo.id,
    branch_name: "",
    base_commit_sha: "",
    worktree_path: "",
    base_branch: repo.base_branch,
    kind: "general",
    goal: "fixture-workspace",
  };

  await engine.git.prepare(repo, assignment);
  return assignment;
};
