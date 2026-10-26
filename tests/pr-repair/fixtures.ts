import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { now, type Repository } from "../../backend/domain";
import { checked } from "../../backend/execution/runtime/process";
import type { Engine } from "../../backend/execution/engine";
import type { RepairSession } from "../../backend/review/repair/contracts";
import { prSnapshot, observations } from "../helpers/pr-fixtures";

export const repairFixture = async (
  engine: Engine,
  dir: string,
  options: { imported: boolean; conflict: boolean; baseBranch?: string } = {
    imported: true,
    conflict: false,
  },
) => {
  const baseBranch = options.baseBranch || "develop";
  const seed = join(dir, "seed");
  await mkdir(seed);
  await checked("git", ["init", "-b", baseBranch], seed);
  await checked("git", ["config", "user.name", "Repair Fixture"], seed);
  await checked("git", ["config", "user.email", "fixture@example.invalid"], seed);
  await writeFile(
    join(seed, "spec.ts"),
    "export const selectors = ['draft'];\nexport const exploration = 'original-exploration';\n",
  );
  await writeFile(
    join(seed, "legacy-puppeteer.cjs"),
    "exports.exploration='original-exploration';\n",
  );
  await writeFile(join(seed, "README.md"), "Original acceptance migration\n");
  await checked("git", ["add", "."], seed);
  await checked("git", ["commit", "-m", "original base"], seed);
  const originalBase = await checked("git", ["rev-parse", "HEAD"], seed);
  const upstream = join(dir, "upstream.git");
  const fork = join(dir, "fork.git");
  await checked("git", ["clone", "--bare", seed, upstream], dir);
  await checked("git", ["clone", "--bare", seed, fork], dir);
  await checked("git", ["switch", "-c", "fix-translation-tests"], seed);
  await writeFile(
    join(seed, "spec.ts"),
    "export const selectors = ['draft', 'publish'];\nexport const exploration = 'different-exploration';\nexport const hasDraft = (items: string[]) => items.every((item) => item === 'draft');\n",
  );
  await checked("git", ["add", "."], seed);
  await checked("git", ["commit", "-m", "migrate acceptance test"], seed);
  await checked("git", ["push", fork, "HEAD:refs/heads/fix-translation-tests"], seed);
  const head = await checked("git", ["rev-parse", "HEAD"], seed);
  await checked("git", ["switch", baseBranch], seed);
  await writeFile(
    join(seed, options.conflict ? "spec.ts" : "README.md"),
    options.conflict ? "export const selectors = ['upstream'];\n" : "Latest upstream development\n",
  );
  await checked("git", ["add", "."], seed);
  await checked("git", ["commit", "-m", "advance upstream"], seed);
  await checked("git", ["push", upstream, baseBranch], seed);
  const base = await checked("git", ["rev-parse", "HEAD"], seed);
  const repoId = randomUUID();
  const source = options.imported ? join(dir, "checkout") : join(engine.root, "repos", repoId);
  await checked("git", ["clone", "--origin", "upstream", upstream, source], dir);
  await checked(
    "git",
    ["fetch", fork, "refs/heads/fix-translation-tests:refs/heads/fix-translation-tests"],
    source,
  );
  await checked("git", ["switch", "fix-translation-tests"], source);
  await checked(
    "git",
    ["remote", "set-url", "upstream", "https://github.com/oppia/oppia.git"],
    source,
  );
  await checked(
    "git",
    ["remote", "add", "origin", "https://github.com/akshajrawat/oppia.git"],
    source,
  );
  await writeFile(join(source, "README.md"), "Personal dirty source checkout\n");
  await writeFile(join(source, "personal.txt"), "Preserve this untracked file\n");
  const repo: Repository = {
    id: repoId,
    owner: "oppia",
    name: "oppia",
    path: source,
    upstream_url: "https://github.com/oppia/oppia.git",
    origin_url: "https://github.com/akshajrawat/oppia.git",
    base_branch: baseBranch,
    source: options.imported ? "imported" : "managed",
    connected: true,
    last_fetched: null,
    created_at: now(),
  };
  engine.db.saveRepository(repo);
  const id = randomUUID();
  const identity = {
    url: "https://github.com/oppia/oppia/pull/27527",
    number: 27527,
    id: "PR_27527",
    upstream: { name: "oppia/oppia", id: "R_upstream", url: repo.upstream_url },
    head: {
      name: "akshajrawat/oppia",
      id: "R_fork",
      url: repo.origin_url!,
      branch: "fix-translation-tests",
      sha: head,
    },
    base: { branch: baseBranch, sha: base },
    viewer: "akshajrawat",
    can_push: true,
    state: "open" as const,
    checked_at: now(),
  };
  const snapshot = {
    ...structuredClone(prSnapshot),
    headRefOid: head,
    baseRefOid: originalBase,
    title: "Acceptance test migration",
    linkedIssues: [
      {
        number: 26831,
        title: "Migrate acceptance tests",
        body: "Migrate the existing acceptance scenario while preserving its exploration, selectors and draft behavior. Whole-issue implementation context is retained; this repair addresses only selected reviewer concerns.",
        url: "https://github.com/oppia/oppia/issues/26831",
      },
    ],
    identity: {
      prId: identity.id,
      headRepository: identity.head.name,
      headRepositoryId: identity.head.id,
      headBranch: identity.head.branch,
      baseRepository: identity.upstream.name,
      baseRepositoryId: identity.upstream.id,
      baseBranch: identity.base.branch,
    },
  };
  const actions = observations.slice(0, 3).map((action) => ({
    ...action,
    id: randomUUID(),
    reviewer: "reviewer",
    sourceUrl: null,
    sourceThreadId: null,
    threadResolved: null,
    outdated: null,
    codeStatus: "unverified" as const,
  }));
  const jobId = randomUUID();
  const analysisId = randomUUID();
  const context = {
    id: analysisId,
    job_id: jobId,
    status: "completed" as const,
    started_at: now(),
    ended_at: now(),
    phase: "Complete",
    configuration: engine.db.settings().utility_ai,
    snapshot,
    report: {
      summary: "Three review observations",
      actions,
      coverage: [],
      complete: true,
      warnings: [],
    },
  };
  engine.db.run(
    "INSERT INTO scheduled_jobs VALUES(?,?)",
    jobId,
    JSON.stringify({ id: jobId, url: identity.url, enabled: false }),
  );
  engine.db.run(
    "INSERT INTO pr_analyses VALUES(?,?,?,?,?,?)",
    analysisId,
    jobId,
    "completed",
    now(),
    now(),
    JSON.stringify(context),
  );
  const session: RepairSession = {
    id,
    repo_id: repoId,
    job_id: jobId,
    analysis_id: analysisId,
    identity,
    context,
    actions,
    instructions: "Investigate all three concerns",
    configuration: {
      codex: engine.db.settings().codex_implementation,
      antigravity: engine.db.settings().antigravity,
    },
    workspace: {
      branch_name: `akkco/pr-27527-${id}`,
      worktree_path: join(engine.root, "worktrees", repoId, `pr-27527-${id}`),
      branch_owned: false,
      git_common_dir: "",
      source_worktrees: "",
      original_head: head,
      original_base: originalBase,
      fetched_base: null,
      integrated_head: null,
      merge_commit: null,
      merge_state: "not_started",
      conflict_paths: [],
      conflict_index: "",
      preparation: "pending",
      remote_head: head,
      remote_checked_at: now(),
    },
    status: "created",
    error: null,
    created_at: now(),
    updated_at: now(),
    review_hash: null,
    approved_hash: null,
    implementation: null,
    verification: null,
  };
  const checkpoint = () =>
    engine.db.run(
      "INSERT INTO pr_repairs VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data,updated_at=excluded.updated_at",
      id,
      jobId,
      repoId,
      analysisId,
      session.status,
      JSON.stringify(session),
      session.created_at,
      now(),
    );
  checkpoint();
  return {
    repo,
    session,
    checkpoint,
    source,
    seed,
    upstream,
    fork,
    head,
    base,
    originalBase,
  };
};
