import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Engine } from "../backend/execution/engine";
import { parseIssue, now } from "../backend/domain";
import { checked } from "../backend/execution/process";
import { fixtureRepository, FixtureProvider, waitForTask } from "./fixtures";
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
  const engine = await Engine.create(
    join(dir, "ade"),
    (stage) =>
      new FixtureProvider(
        stage === 1
          ? async () => {
              planning++;
              if (planning === 2) reached();
              await gate;
            }
          : undefined,
      ),
  );
  try {
    const { repo, upstream } = await fixtureRepository(engine, dir);
    const ref = parseIssue("https://github.com/fixture/fixture/issues/1");
    const a = engine.enqueue(repo, ref, "Task A", "", {
      title: "fixture",
      body: "test",
    });
    const b = engine.enqueue(repo, ref, "Task B", "", {
      title: "fixture",
      body: "test",
    });
    await both;
    const taskA = engine.db.task(a.id),
      taskB = engine.db.task(b.id);
    expect(taskA.worktree_path).not.toBe(taskB.worktree_path);
    expect(taskA.base_commit_sha).toBe(taskB.base_commit_sha);
    await checked(
      "git",
      ["switch", "-c", "personal-unrelated-branch"],
      upstream,
    );
    release();
    await Promise.all([
      waitForTask(
        engine,
        a.id,
        (s) => s === "ready_for_review" || s === "failed",
      ),
      waitForTask(
        engine,
        b.id,
        (s) => s === "ready_for_review" || s === "failed",
      ),
    ]);
    expect(engine.db.task(a.id).status).toBe("ready_for_review");
    expect(engine.db.task(b.id).status).toBe("ready_for_review");
    expect(
      await readFile(join(taskA.worktree_path, "source.txt"), "utf8"),
    ).toBe("A\n");
    expect(
      await readFile(join(taskB.worktree_path, "source.txt"), "utf8"),
    ).toBe("B\n");
    expect(await readFile(join(upstream, "source.txt"), "utf8")).toBe("base\n");
    expect(
      await checked("git", ["branch", "--show-current"], taskA.worktree_path),
    ).toBe(taskA.branch_name);
    const diff = await engine.git.diff(engine.db.task(a.id));
    expect(
      diff.files.some((f) => f.path === "source.txt" && f.status === "M"),
    ).toBe(true);
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
  const engine = await Engine.create(
    join(dir, "ade"),
    () => new FixtureProvider(),
  );
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const t = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/2"),
      "Task A",
      "",
      {},
    );
    await waitForTask(
      engine,
      t.id,
      (s) => s === "ready_for_review" || s === "failed",
    );
    const task = engine.db.task(t.id);
    await writeFile(join(task.worktree_path, "new.txt"), "new\nline\n");
    await rm(join(task.worktree_path, "deleted.txt"));
    await rename(
      join(task.worktree_path, "rename.txt"),
      join(task.worktree_path, "renamed.txt"),
    );
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
    expect(await readFile(join(task.worktree_path, "source.txt"), "utf8")).toBe(
      "base\n",
    );
  } finally {
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);
it("retries only the failed stage and continues from locally persisted plans", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-retry-"));
  const fail = { value: true };
  const engine = await Engine.create(
    join(dir, "ade"),
    () => new FixtureProvider(undefined, fail),
  );
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const t = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/3"),
      "Task A",
      "",
      {},
    );
    await waitForTask(engine, t.id, (s) => s === "failed");
    expect(engine.db.task(t.id).stage).toBe(2);
    expect(engine.db.task(t.id).error).toContain("29");
    expect(engine.db.artifact(t.id, 1)).toHaveProperty("summary");
    engine.retry(t.id);
    await waitForTask(
      engine,
      t.id,
      (s) => s === "ready_for_review" || s === "failed",
    );
    expect(engine.db.task(t.id).status).toBe("ready_for_review");
    expect(
      engine.db.all(
        "SELECT id FROM agent_runs WHERE task_id=? AND stage=1",
        t.id,
      ),
    ).toHaveLength(1);
    expect(
      engine.db.all(
        "SELECT id FROM agent_runs WHERE task_id=? AND stage=2",
        t.id,
      ),
    ).toHaveLength(2);
    engine.followUp(t.id, "Inspect the same task again.");
    await waitForTask(
      engine,
      t.id,
      (s) => s === "ready_for_review" || s === "failed",
    );
    expect(engine.db.detail(t.id).messages).toHaveLength(1);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);
it("reconciles crash records as Interrupted without automatically spending model quota", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-recovery-"));
  let engine = await Engine.create(
    join(dir, "ade"),
    () => new FixtureProvider(),
  );
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const t = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/4"),
      "Task A",
      "",
      {},
    );
    await waitForTask(
      engine,
      t.id,
      (s) => s === "ready_for_review" || s === "failed",
    );
    const crashed = {
      ...engine.db.task(t.id),
      stage: 3,
      status: "implementing" as const,
    };
    engine.db.saveTask(crashed);
    engine.db.run(
      "INSERT INTO agent_runs(id,task_id,stage,provider,model,effort,prompt,status,started_at) VALUES(?,?,3,'codex','','high','fixture','running',?)",
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
    engine = await Engine.create(join(dir, "ade"), () => new FixtureProvider());
    engine.start();
    expect(engine.db.task(t.id).status).toBe("interrupted");
    expect(
      engine.db.all("SELECT id FROM agent_runs WHERE status='running'"),
    ).toEqual([]);
    expect(engine.db.all("SELECT status FROM terminal_sessions")).toEqual([
      { status: "interrupted" },
    ]);
    engine.retry(t.id);
    await waitForTask(
      engine,
      t.id,
      (s) => s === "ready_for_review" || s === "failed",
    );
    expect(engine.db.task(t.id).status).toBe("ready_for_review");
  } finally {
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);
it("fetches before every worktree, pins exact upstream SHA, and suffixes duplicate scope branches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-base-"));
  const engine = await Engine.create(
    join(dir, "ade"),
    () => new FixtureProvider(),
  );
  try {
    const { repo, upstream } = await fixtureRepository(engine, dir);
    const ref = parseIssue("https://github.com/fixture/fixture/issues/5");
    const a = engine.enqueue(repo, ref, "Task A", "", {});
    await waitForTask(
      engine,
      a.id,
      (s) => s === "ready_for_review" || s === "failed",
    );
    const first = engine.db.task(a.id);
    await writeFile(join(upstream, "new-upstream.txt"), "next base\n");
    await checked("git", ["add", "."], upstream);
    await checked("git", ["commit", "-m", "new upstream base"], upstream);
    const expected = await checked("git", ["rev-parse", "HEAD"], upstream);
    const b = engine.enqueue(repo, ref, "Task A", "", {});
    await waitForTask(
      engine,
      b.id,
      (s) => s === "ready_for_review" || s === "failed",
    );
    const second = engine.db.task(b.id);
    expect(second.base_commit_sha).toBe(expected);
    expect(first.base_commit_sha).not.toBe(second.base_commit_sha);
    expect(engine.db.task(first.id).base_commit_sha).toBe(
      first.base_commit_sha,
    );
    expect(second.branch_name).toBe(`${first.branch_name}-1`);
    expect(
      await readFile(join(second.worktree_path, "new-upstream.txt"), "utf8"),
    ).toBe("next base\n");
  } finally {
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);
it("scheduled planning reuses isolation and shared slots without changing task plans or implementing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-scheduled-"));
  const engine = await Engine.create(
    join(dir, "ade"),
    () => new FixtureProvider(),
  );
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const task = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/6"),
      "Task A",
      "",
      {},
    );
    await waitForTask(
      engine,
      task.id,
      (s) => s === "ready_for_review" || s === "failed",
    );
    const before = await engine.git.fingerprint(engine.db.task(task.id));
    const artifacts = engine.db.detail(task.id).artifacts;
    const { Scheduler } = await import("../backend/scheduled/scheduler");
    const scheduler = new Scheduler(engine);
    const watch = scheduler.add({
      url: "https://github.com/fixture/fixture/pull/6",
      task_id: task.id,
      interval_minutes: 60,
      verify_codex: true,
    });
    await scheduler.close();
    const result = await engine.analyzeScheduled(
      task.id,
      "Analyze PR updates. Do not edit files.",
      true,
      watch.id,
    );
    expect(result?.analysis).toHaveProperty("summary");
    expect(result?.refinement).toHaveProperty("manualActionRequired");
    expect(await engine.git.fingerprint(engine.db.task(task.id))).toBe(before);
    expect(engine.db.detail(task.id).artifacts).toEqual(artifacts);
    expect(engine.db.task(task.id).status).toBe("ready_for_review");
    expect(engine.db.all("SELECT id FROM scheduled_agent_runs")).toHaveLength(
      2,
    );
  } finally {
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);
it("persists local line review notes, rejects escaping paths and sends feedback only on explicit action", async () => {
  const { ReviewService } = await import("../backend/review/service");
  const dir = await mkdtemp(join(tmpdir(), "vibestar-review-"));
  const engine = await Engine.create(
    join(dir, "ade"),
    () => new FixtureProvider(),
  );
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const task = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/7"),
      "Task A",
      "",
      {},
    );
    await waitForTask(
      engine,
      task.id,
      (s) => s === "ready_for_review" || s === "failed",
    );
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
    expect(engine.db.detail(task.id).runs).toHaveLength(3);
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
    await review.send(task.id);
    await waitForTask(
      engine,
      task.id,
      (s) => s === "ready_for_review" || s === "failed",
    );
    expect(engine.db.detail(task.id).messages[0].content).toContain(
      "Use the established convention",
    );
    expect(engine.db.detail(task.id).runs).toHaveLength(4);
    review.remove(note.id);
    expect(review.list(task.id)).toEqual([]);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);
