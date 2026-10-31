import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { fetchIssue } from "../../backend/workspace/issue";
import { gitChecked, gitCapture } from "../../backend/workspace/git-command";
import { migrateDataRoot } from "../../backend/storage/migrate-root";
import { checked } from "../../backend/execution/runtime/process";
import { Rpc } from "../../backend/rpc";
import type { AgentRunRequest } from "../../backend/execution/providers/contracts";
import {
  createFixtureEngine,
  fixtureRepository,
  FixtureProvider,
  waitForTask,
} from "../helpers/fixtures";

vi.mock("../../backend/workspace/issue", () => ({ fetchIssue: vi.fn() }));
let directory: string;
let engine: Awaited<ReturnType<typeof createFixtureEngine>>;
const invocations: AgentRunRequest[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "vibestar-source-workspace-"));
  invocations.length = 0;

  vi.mocked(fetchIssue).mockImplementation(async (reference) => ({
    title: "Dedicated branch",
    body: "Change only this task",
    comments: [],
    labels: [],
    state: "open",
    number: reference.number,
    url: reference.url,
    linkedPullRequests: [],
    contextWarnings: [],
    context_fetched_at: new Date().toISOString(),
  }));

  engine = await createFixtureEngine(
    join(directory, "data"),
    (_stage, name) => ({
      ...new FixtureProvider(),
      name: name || "codex",
      invocation: (request) => {
        invocations.push(request);
        return new FixtureProvider().invocation(request);
      },
    }),
    (url) => {
      if (url === "https://github.com/fixture/fixture.git") return join(directory, "upstream");
      if (isAbsolute(url)) return url;
      throw new Error("Live Git transport is disabled in this fixture.");
    },
  );
});

afterEach(async () => {
  await engine.close();
  await rm(directory, { recursive: true, force: true });
});

const start = async (
  repositoryId: string,
  number: number,
  provider: "codex" | "antigravity" = "codex",
) => {
  const task = await engine.createTask(
    repositoryId,
    `https://github.com/fixture/fixture/issues/${number}`,
    "Task A",
    "",
  );

  await new Rpc(engine).call("task.configureStage", {
    id: task.id,
    stage: 1,
    config: { provider, model: "next-model", effort: "low", timeout_secs: 30 },
  });

  await engine.startWorkflow({ id: task.id, request_id: randomUUID() });
  await waitForTask(engine, task.id, (status) => ["awaiting_approval", "failed"].includes(status));
  await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false));

  expect(
    engine.db.task(task.id).status,
    engine.db.task(task.id).error || "Preparation result",
  ).toBe("awaiting_approval");

  return engine.db.task(task.id);
};

it.each(["codex", "antigravity"] as const)(
  "uses a dedicated source branch for %s and isolates the overlapping task without committing or stashing",
  async (provider) => {
    const { repo } = await fixtureRepository(engine, directory);
    const first = await start(repo.id, 1, provider);

    expect(first).toMatchObject({
      workspace_mode: "source",
      worktree_path: repo.path,
      branch_owned: true,
    });

    expect(await gitChecked(["symbolic-ref", "--short", "HEAD"], repo.path)).toBe(
      first.branch_name,
    );

    expect(first.branch_name).not.toBe(repo.base_branch);
    await writeFile(join(repo.path, "source.txt"), "Task 1 unfinished changes\n");
    const second = await start(repo.id, 2, provider);
    expect(second.workspace_mode).toBeUndefined();
    expect(second.worktree_path).not.toBe(repo.path);
    expect(second.branch_name).not.toBe(first.branch_name);

    expect(await gitChecked(["symbolic-ref", "--short", "HEAD"], second.worktree_path)).toBe(
      second.branch_name,
    );

    expect(await readFile(join(second.worktree_path, "source.txt"), "utf8")).toBe("base\n");

    expect(await readFile(join(repo.path, "source.txt"), "utf8")).toBe(
      "Task 1 unfinished changes\n",
    );

    expect(await gitChecked(["rev-parse", "HEAD"], repo.path)).toBe(first.base_commit_sha);
    expect((await gitCapture(["rev-parse", "--verify", "refs/stash"], repo.path)).code).not.toBe(0);
    expect(invocations.map((request) => request.cwd)).toEqual([repo.path, second.worktree_path]);
    expect(engine.db.detail(first.id).runs[0].provider).toBe(provider);
    await engine.close();
    engine = await createFixtureEngine(join(directory, "data"));
    engine.start();
    expect(await engine.git.assertTask(engine.db.task(first.id))).toBe(repo.path);
    expect(engine.db.detail(first.id).runs).toHaveLength(1);

    expect(await readFile(join(repo.path, "source.txt"), "utf8")).toBe(
      "Task 1 unfinished changes\n",
    );
  },
);

it("uses a worktree for dirty source checkouts and preserves their branch and files", async () => {
  const { repo } = await fixtureRepository(engine, directory);
  await writeFile(join(repo.path, "source.txt"), "Existing private edit\n");
  const task = await start(repo.id, 1);
  expect(task.workspace_mode).toBeUndefined();
  expect(await gitChecked(["symbolic-ref", "--short", "HEAD"], repo.path)).toBe("main");
  expect(await readFile(join(repo.path, "source.txt"), "utf8")).toBe("Existing private edit\n");
  expect(await readFile(join(task.worktree_path, "source.txt"), "utf8")).toBe("base\n");
});

it("preserves source checkouts during task disposal and can remove only their history", async () => {
  const { repo } = await fixtureRepository(engine, directory);
  const task = await start(repo.id, 1);
  const rpc = new Rpc(engine);

  const preview = (await rpc.call("task.disposal.preview", { id: task.id })) as {
    fingerprint: string;
    active_operation: string;
  };

  expect(preview.active_operation).toContain("Source checkout is retained");

  await expect(
    rpc.call("task.disposal.discard", {
      id: task.id,
      fingerprint: preview.fingerprint,
      confirmed: true,
    }),
  ).rejects.toThrow("never removed");

  await rpc.call("task.disposal.preserve", { id: task.id, confirmed: true });

  expect(engine.db.task(task.id)).toMatchObject({
    status: "preserved",
    workspace_mode: "source",
    worktree_path: repo.path,
  });

  expect(await readFile(join(repo.path, "source.txt"), "utf8")).toBe("base\n");
});

it("migrates a managed source assignment without treating its .git directory as a worktree file", async () => {
  const { repo } = await fixtureRepository(engine, directory);
  const task = await start(repo.id, 1);
  const target = join(directory, "moved");
  await engine.close();
  await migrateDataRoot(join(directory, "data"), target);
  engine = await createFixtureEngine(target);
  const migrated = engine.db.task(task.id);
  expect(migrated.workspace_mode).toBe("source");
  expect(await engine.git.assertTask(migrated)).toBe(engine.db.repository(repo.id).path);
  expect(await readFile(join(migrated.worktree_path, "source.txt"), "utf8")).toBe("base\n");
});

it("uses a registered external checkout without changing its existing remotes", async () => {
  const { repo, upstream } = await fixtureRepository(engine, directory);
  const external = join(directory, "existing-checkout");
  await checked("git", ["clone", "--", upstream, external], directory);

  await gitChecked(
    ["remote", "set-url", "origin", "https://github.com/fixture/fixture.git"],
    external,
  );

  engine.db.saveRepository({
    ...repo,
    path: external,
    source: "imported",
    upstream_url: "https://github.com/fixture/fixture.git",
  });

  const remotes = await gitChecked(["remote", "-v"], external);
  const task = await start(repo.id, 1, "antigravity");
  expect(task).toMatchObject({ workspace_mode: "source", worktree_path: external });
  expect(await gitChecked(["remote", "-v"], external)).toBe(remotes);
  expect(await engine.git.assertTask(task)).toBe(external);
});

it("reuses a source checkout only after its previous owner is preserved and the user returns to a clean base branch", async () => {
  const { repo } = await fixtureRepository(engine, directory);
  const first = await start(repo.id, 1);
  await new Rpc(engine).call("task.disposal.preserve", { id: first.id, confirmed: true });
  await gitChecked(["checkout", "main"], repo.path);
  const next = await start(repo.id, 2);
  expect(next).toMatchObject({ workspace_mode: "source", worktree_path: repo.path });
  expect(next.branch_name).not.toBe(first.branch_name);

  await expect(engine.git.assertTask(engine.db.task(first.id))).rejects.toThrow(
    "ownership changed",
  );

  expect(await gitChecked(["rev-parse", `refs/heads/${first.branch_name}`], repo.path)).toBe(
    first.base_commit_sha,
  );
});
