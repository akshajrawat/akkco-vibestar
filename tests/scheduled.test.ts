import { it, expect, vi, afterEach } from "vitest";
import { Database } from "../backend/storage/database";
import { Scheduler } from "../backend/scheduled/scheduler";
import { GitHubMonitor } from "../backend/scheduled/github";
import {
  changedPullRequest,
  parsePullRequest,
  type PullRequestState,
} from "../backend/scheduled/contracts";
import type { Engine } from "../backend/execution/engine";
import { randomUUID } from "node:crypto";
const baseline: PullRequestState = {
  title: "PR",
  body: "Scope",
  state: "OPEN",
  mergeable: "MERGEABLE",
  reviewDecision: "REVIEW_REQUIRED",
  headRefOid: "base",
  comments: [],
  reviews: [],
  checks: [],
};
afterEach(() => vi.useRealTimers());
it("validates PR URLs and detects comments, inline review edits, requested changes, CI failures, conflicts and terminal state", () => {
  expect(
    parsePullRequest("https://github.com/oppia/oppia/pull/42").number,
  ).toBe(42);
  expect(() =>
    parsePullRequest("https://github.com/oppia/oppia/issues/42"),
  ).toThrow();
  expect(changedPullRequest(baseline, structuredClone(baseline))).toEqual({
    changes: [],
    actionable: false,
  });
  const next = {
    ...baseline,
    comments: [{ id: "inline", body: "Needs a test", updated_at: "1" }],
    reviews: [
      { id: "r", state: "CHANGES_REQUESTED", body: "Fix", submitted_at: "1" },
    ],
    checks: [
      { name: "unit", state: "FAILURE", url: "https://github.com/run/1" },
    ],
    mergeable: "CONFLICTING",
    reviewDecision: "CHANGES_REQUESTED",
  };
  expect(changedPullRequest(baseline, next).changes).toHaveLength(5);
  expect(changedPullRequest(next, structuredClone(next)).actionable).toBe(
    false,
  );
  expect(changedPullRequest(next, { ...next, state: "MERGED" })).toEqual({
    changes: ["PR state: MERGED"],
    actionable: false,
  });
});
it("persists snapshots, skips unchanged model calls, analyzes actionable changes once and separates notifications", async () => {
  vi.useFakeTimers();
  const db = new Database(":memory:");
  const taskId = randomUUID(),
    repoId = randomUUID();
  const analyze = vi.fn().mockResolvedValue({
    analysis: {
      manualActionRequired: true,
      severity: "action_required",
      summary: "Add test",
      reason: "Review",
      newActivity: [],
      recommendedNextAction: "Add test",
      affectedFiles: [],
    },
    refinement: null,
  });
  const engine = {
    root: "/tmp",
    db,
    changed: vi.fn(),
    isActive: () => false,
    cancel: vi.fn(),
    analyzeScheduled: analyze,
  } as unknown as Engine;
  db.saveRepository({
    id: repoId,
    owner: "oppia",
    name: "oppia",
    path: "/tmp/repo",
    upstream_url: "https://github.com/oppia/oppia.git",
    origin_url: null,
    base_branch: "main",
    created_at: new Date().toISOString(),
    last_fetched: null,
  });
  db.saveTask({
    id: taskId,
    repo_id: repoId,
    issue_number: 42,
    issue_url: "https://github.com/oppia/oppia/issues/42",
    claimed_scope: "test.ts",
    notes: "",
    issue: {},
    branch_name: "akkco/42-test",
    base_branch: "main",
    base_commit_sha: "base",
    worktree_path: "/tmp/task",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: "ready_for_review",
    stage: 5,
    error: null,
  });
  const monitor = new GitHubMonitor("/tmp");
  const inspect = vi
    .spyOn(monitor, "inspect")
    .mockResolvedValue(structuredClone(baseline));
  const scheduler = new Scheduler(engine, monitor);
  try {
    const job = scheduler.add({
      url: "https://github.com/oppia/oppia/pull/42",
      task_id: taskId,
      interval_minutes: 60,
      verify_codex: true,
    });
    await scheduler.tick();
    expect(analyze).not.toHaveBeenCalled();
    expect(scheduler.jobs()[0].last_snapshot).toEqual(baseline);
    scheduler.runNow(job.id);
    await scheduler.tick();
    expect(analyze).not.toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledTimes(2);
    scheduler.setEnabled(job.id, false);
    scheduler.runNow(job.id);
    await scheduler.tick();
    expect(scheduler.jobs()[0]).toMatchObject({
      enabled: false,
      check_once: false,
    });
    scheduler.setEnabled(job.id, true);
    const changed = {
      ...baseline,
      comments: [{ id: "review", body: "Add coverage", updated_at: "1" }],
    };
    inspect.mockResolvedValue(changed);
    scheduler.runNow(job.id);
    await scheduler.tick();
    expect(analyze).toHaveBeenCalledTimes(1);
    inspect.mockResolvedValue({
      ...changed,
      checks: [{ name: "CI", state: "IN_PROGRESS", url: "" }],
    });
    scheduler.runNow(job.id);
    await scheduler.tick();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(scheduler.attention()).toHaveLength(1);
    expect(analyze.mock.calls[0][0]).toBe(taskId);
    expect(analyze.mock.calls[0][1]).toContain("DO NOT edit files");
    expect(analyze.mock.calls[0][2]).toBe(true);
    expect(scheduler.attention()).toHaveLength(1);
    expect(db.all("SELECT id FROM task_messages")).toEqual([]);
    scheduler.runNow(job.id);
    await scheduler.tick();
    expect(analyze).toHaveBeenCalledTimes(1);
    inspect.mockResolvedValue({ ...changed, state: "CLOSED" });
    scheduler.runNow(job.id);
    await scheduler.tick();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(scheduler.jobs()[0].archived).toBe(true);
    expect(scheduler.attention()).toHaveLength(0);

    const reloaded = new Scheduler(engine, monitor);
    expect(reloaded.jobs()[0].last_snapshot?.state).toBe("CLOSED");
    await reloaded.close();
  } finally {
    await scheduler.close();
    db.close();
  }
});
it("defers busy worktrees and recovers interrupted model jobs without automatically rerunning them", async () => {
  vi.useFakeTimers();
  const db = new Database(":memory:");
  const engine = {
    root: "/tmp",
    db,
    changed: vi.fn(),
    publish: vi.fn(),
    isActive: () => false,
    cancel: vi.fn(),
    analyzeScheduled: vi.fn().mockResolvedValue({
      analysis: {
        manualActionRequired: true,
        severity: "action_required",
        summary: "Feedback",
        reason: "Review",
        newActivity: [],
        recommendedNextAction: "Read feedback",
        affectedFiles: [],
      },
      refinement: null,
    }),
  } as unknown as Engine;
  const id = randomUUID();
  const job = {
    id,
    url: "https://github.com/oppia/oppia/pull/1",
    task_id: null,
    interval_minutes: 120,
    verify_codex: false,
    enabled: true,
    next_run_at: new Date().toISOString(),
    status: "analyzing",
    last_checked_at: null,
    last_snapshot: baseline,
    pending_snapshot: { ...baseline, mergeable: "CONFLICTING" },
    changes: ["Merge conflicts detected"],
    error: null,
  };
  db.run("INSERT INTO scheduled_jobs VALUES(?,?)", id, JSON.stringify(job));
  const monitor = new GitHubMonitor("/tmp");
  const inspect = vi.spyOn(monitor, "inspect").mockResolvedValue({
    ...baseline,
    comments: [{ id: "new", body: "Please add a test", updated_at: "now" }],
  });
  const scheduler = new Scheduler(engine, monitor);
  try {
    scheduler.start();
    await vi.advanceTimersByTimeAsync(7200000);
    expect(scheduler.jobs()[0].status).toBe("interrupted");
    expect(inspect).not.toHaveBeenCalled();
    expect(engine.analyzeScheduled).not.toHaveBeenCalled();
    scheduler.runNow(id, true);
    await scheduler.tick();
    expect(scheduler.attention()[0].error).toBeNull();
    expect(engine.analyzeScheduled).toHaveBeenCalledTimes(1);
  } finally {
    await scheduler.close();
    db.close();
  }
});
