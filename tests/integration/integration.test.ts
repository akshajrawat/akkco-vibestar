import { ActionSchema } from "../../backend/scheduled/action";
import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { now } from "../../backend/domain";
import { checked } from "../../backend/execution/runtime/process";
import {
  createFixtureEngine,
  fixtureRepository,
  prepareFixtureTask,
  FixtureProvider,
  historicalTaskFixture,
  fixtureFlowTask,
  startFixtureFlow,
  waitForFixtureFlow,
} from "../helpers/fixtures";

it("creates two concurrently running worktrees, isolates same-file edits, and ignores personal branch switching", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-isolation-"));
  let release!: () => void;

  const gate = new Promise<void>((r) => {
    release = r;
  });

  let planning = 0;
  let reached!: () => void;

  const both = new Promise<void>((r) => {
    reached = r;
  });

  const engine = await createFixtureEngine(
    join(dir, "ade"),
    () =>
      new FixtureProvider(async () => {
        planning++;
        if (planning === 2) reached();
        await gate;
      }),
  );

  try {
    const { repo, upstream } = await fixtureRepository(engine, dir);
    const a = fixtureFlowTask(engine, repo, "Task A");
    const b = fixtureFlowTask(engine, repo, "Task B");
    const runA = startFixtureFlow(engine, a);
    const runB = startFixtureFlow(engine, b);

    await both;

    const taskA = engine.db.task(a.id),
      taskB = engine.db.task(b.id);

    expect(taskA.worktree_path).not.toBe(taskB.worktree_path);
    expect(taskA.base_commit_sha).toBe(taskB.base_commit_sha);
    await checked("git", ["switch", "-c", "personal-unrelated-branch"], upstream);
    release();

    await Promise.all([waitForFixtureFlow(engine, runA), waitForFixtureFlow(engine, runB)]);
    expect(engine.flowRuns.run(runA.id).status).toBe("completed");
    expect(engine.flowRuns.run(runB.id).status).toBe("completed");
    expect(await readFile(join(taskA.worktree_path, "source.txt"), "utf8")).toBe("A\n");
    expect(await readFile(join(taskB.worktree_path, "source.txt"), "utf8")).toBe("B\n");
    expect(await readFile(join(upstream, "source.txt"), "utf8")).toBe("base\n");

    expect(await checked("git", ["branch", "--show-current"], taskA.worktree_path)).toBe(
      taskA.branch_name,
    );

    const diff = await engine.git.diff(engine.db.task(a.id));
    expect(diff.files.some((f) => f.path === "source.txt" && f.status === "M")).toBe(true);
    expect(diff.insertions).toBe(1);
    expect(diff.deletions).toBe(1);
  } finally {
    release();
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 40000);

it("calculates staged, unstaged, untracked, deleted and renamed files against saved base", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-diff-"));
  const engine = await createFixtureEngine(join(dir, "ade"), () => new FixtureProvider());
  try {
    const { repo } = await fixtureRepository(engine, dir);

    const task = await prepareFixtureTask(engine, repo, randomUUID(), 2);
    await writeFile(join(task.worktree_path, "source.txt"), "A\n");
    await writeFile(join(task.worktree_path, "new.txt"), "new\nline\n");
    await rm(join(task.worktree_path, "deleted.txt"));
    await rename(join(task.worktree_path, "rename.txt"), join(task.worktree_path, "renamed.txt"));

    await checked(
      "git",
      ["add", "source.txt", "deleted.txt", "rename.txt", "renamed.txt"],
      task.worktree_path,
    );

    await writeFile(join(task.worktree_path, "source.txt"), "unstaged\n");
    const diff = await engine.git.diff(task);

    expect(diff.files.find((f) => f.path === "source.txt")).toMatchObject({
      staged: true,
      unstaged: true,
    });

    expect(diff.files.find((f) => f.path === "new.txt")).toMatchObject({
      status: "A",
      untracked: true,
      insertions: 2,
    });

    expect(diff.files.find((f) => f.path === "deleted.txt")?.status).toBe("D");

    expect(diff.files.find((f) => f.path === "renamed.txt")).toMatchObject({
      status: "R",
      old_path: "rename.txt",
    });

    await engine.git.discard(task);
    expect((await engine.git.diff(task)).files).toEqual([]);
    expect(await readFile(join(task.worktree_path, "source.txt"), "utf8")).toBe("base\n");
  } finally {
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);

it("reconciles crash records as Interrupted without automatically spending model quota", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-recovery-"));
  let engine = await createFixtureEngine(join(dir, "ade"), () => new FixtureProvider());
  try {
    const { repo } = await fixtureRepository(engine, dir);

    const t = await prepareFixtureTask(engine, repo, randomUUID(), 4);

    const crashed = {
      ...engine.db.task(t.id),
      stage: 1,
      status: "planning_antigravity" as const,
      execution_settings: engine.db.settings(),
    };

    engine.db.saveTask(crashed);

    engine.db.run(
      "INSERT INTO agent_runs(id,task_id,stage,provider,model,effort,prompt,status,started_at) VALUES(?,?,1,'codex','','high','fixture','running',?)",
      randomUUID(),
      t.id,
      now(),
    );

    engine.db.run(
      "INSERT INTO terminal_sessions(id,task_id,status,started_at) VALUES(?,?,'running',?)",
      randomUUID(),
      t.id,
      now(),
    );

    await engine.close();
    engine = await createFixtureEngine(join(dir, "ade"), () => new FixtureProvider());
    engine.start();

    expect(engine.db.task(t.id).status, engine.db.task(t.id).error || "migration status").toBe(
      "not_started",
    );

    const checkpoint = engine.db.all<{ id: string }>(
      "SELECT id FROM flow_runs WHERE task_id=?",
      t.id,
    )[0];

    expect(engine.flowRuns.run(checkpoint.id)).toMatchObject({
      origin: "historical",
      status: "interrupted",
    });

    expect(engine.db.all("SELECT id FROM agent_runs WHERE status='running'")).toEqual([]);

    expect(engine.db.all("SELECT status FROM terminal_sessions")).toEqual([
      { status: "interrupted" },
    ]);

    expect(engine.db.all("SELECT id FROM flow_dispatches WHERE run_id=?", checkpoint.id)).toEqual(
      [],
    );

    expect(engine.flowRuns.attempts(checkpoint.id)).toEqual([]);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);

it("fetches before every worktree, pins exact upstream SHA, and suffixes duplicate scope branches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-base-"));
  const engine = await createFixtureEngine(join(dir, "ade"), () => new FixtureProvider());
  try {
    const { repo, upstream } = await fixtureRepository(engine, dir);
    const first = historicalTaskFixture(engine, repo, { scope: "Task A", issue_number: 5 });
    await engine.git.prepare(repo, first);
    engine.db.saveTask(first);
    await writeFile(join(upstream, "new-upstream.txt"), "next base\n");
    await checked("git", ["add", "."], upstream);
    await checked("git", ["commit", "-m", "new upstream base"], upstream);
    const expected = await checked("git", ["rev-parse", "HEAD"], upstream);
    const second = historicalTaskFixture(engine, repo, { scope: "Task A", issue_number: 5 });
    await engine.git.prepare(repo, second);
    engine.db.saveTask(second);
    expect(second.base_commit_sha).toBe(expected);
    expect(first.base_commit_sha).not.toBe(second.base_commit_sha);
    expect(engine.db.task(first.id).base_commit_sha).toBe(first.base_commit_sha);
    expect(second.branch_name).toBe(`${first.branch_name}-1`);

    expect(await readFile(join(second.worktree_path, "new-upstream.txt"), "utf8")).toBe(
      "next base\n",
    );
  } finally {
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);

it("explicit PR utility reasoning reuses isolation and shared slots without changing task plans or implementing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-scheduled-"));
  const engine = await createFixtureEngine(join(dir, "ade"), () => new FixtureProvider());
  try {
    const { repo } = await fixtureRepository(engine, dir);

    const task = await prepareFixtureTask(engine, repo, randomUUID(), 6);
    const before = await engine.git.fingerprint(engine.db.task(task.id));
    const artifacts = engine.db.detail(task.id).artifacts;
    const { Scheduler } = await import("../../backend/scheduled/scheduler");
    const scheduler = new Scheduler(engine);

    const watch = scheduler.add({
      url: "https://github.com/fixture/fixture/pull/6",
      task_id: task.id,
      interval_minutes: 60,
      verify_codex: true,
    });

    await scheduler.close();

    const result = await engine.utility.run({
      purpose: "PR Review Analysis",
      prompt: "Analyze PR updates. Do not edit files.",
      schema: ActionSchema,
      context: {
        taskId: task.id,
        jobId: watch.id,
        repository: "fixture/fixture",
      },
    });

    expect(result).toHaveProperty("manualActionRequired");
    expect(await engine.git.fingerprint(engine.db.task(task.id))).toBe(before);
    expect(engine.db.detail(task.id).artifacts).toEqual(artifacts);
    expect(engine.db.task(task.id).status).toBe("cancelled");
    expect(engine.db.all("SELECT id FROM scheduled_agent_runs")).toHaveLength(1);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);

it("persists local line review notes and rejects escaping paths without legacy workflow execution", async () => {
  const { ReviewService } = await import("../../backend/review/service");
  const dir = await mkdtemp(join(tmpdir(), "vibestar-review-"));
  const engine = await createFixtureEngine(join(dir, "ade"), () => new FixtureProvider());
  try {
    const { repo } = await fixtureRepository(engine, dir);

    const task = await prepareFixtureTask(engine, repo, randomUUID(), 7);
    const review = new ReviewService(engine);

    const note = await review.add({
      id: task.id,
      path: "source.txt",
      side: "working",
      line_start: 1,
      line_end: 1,
      content: "Use the established convention",
    });

    expect(note.source_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(new ReviewService(engine).list(task.id)).toEqual([note]);
    expect(engine.db.detail(task.id).runs).toHaveLength(0);

    await expect(
      review.add({
        id: task.id,
        path: "../outside.txt",
        side: "working",
        line_start: 1,
        line_end: 1,
        content: "Invalid",
      }),
    ).rejects.toThrow();

    expect(engine.db.detail(task.id).messages).toEqual([]);
    expect(engine.db.detail(task.id).runs).toHaveLength(0);
    const { Rpc } = await import("../../backend/rpc");
    const rpc = new Rpc(engine);
    try {
      await expect(rpc.call("review.send", { id: task.id })).rejects.toThrow("Unknown method");
    } finally {
      await rpc.close();
    }

    expect(engine.db.detail(task.id).runs).toHaveLength(0);
    review.remove(note.id);
    expect(review.list(task.id)).toEqual([]);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);
