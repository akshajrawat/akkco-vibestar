import { createFixtureEngine } from "../helpers/fixtures";
import { it, expect, vi, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Engine } from "../../backend/execution/engine";
import { Rpc } from "../../backend/rpc";
import { Scheduler } from "../../backend/scheduled/scheduler";
import { GitHubMonitor } from "../../backend/scheduled/github";
import { GitHubService } from "../../backend/github/service";
import { changedPullRequest, parsePullRequest } from "../../backend/scheduled/contracts";
import { PRFixtureProvider, prSnapshot, analysisResult, reviewBody } from "../helpers/pr-fixtures";

const resources: { dir: string; engine: Engine; scheduler: Scheduler }[] = [];
const setup = async (realRunner = false) => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-manual-pr-"));
  const engine = await createFixtureEngine(join(dir, "data"), () => new PRFixtureProvider());
  const monitor = new GitHubMonitor(dir);
  const inspect = vi.spyOn(monitor, "inspect").mockResolvedValue(structuredClone(prSnapshot));
  const scheduler = new Scheduler(engine, monitor);
  resources.push({ dir, engine, scheduler });
  const infer = realRunner
    ? undefined
    : vi.spyOn(engine.utility, "run").mockResolvedValue(analysisResult());
  const job = scheduler.add({
    url: "https://github.com/upstream/project/pull/1",
    task_id: null,
    interval_minutes: 60,
    verify_codex: true,
  });
  return { dir, engine, monitor, inspect, scheduler, infer, job };
};
const finished = async (scheduler: Scheduler, jobId: string) => {
  await vi.waitFor(() => expect(scheduler.analysis.history(jobId)[0]?.status).not.toBe("running"), {
    timeout: 10000,
  });
  return scheduler.analysis.history(jobId)[0];
};
afterEach(async () => {
  vi.useRealTimers();
  for (const resource of resources.splice(0)) {
    await resource.scheduler.close();
    await resource.engine.close();
    await rm(resource.dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

it("defaults to manual PR policy; startup, tracking, imports and timers do not inspect or infer", async () => {
  const { engine, scheduler, inspect, infer, job } = await setup();
  const github = new GitHubService(engine, scheduler);
  const sync = vi.spyOn(github, "sync");
  expect(github.settings().auto_watch).toBe(false);
  github.start();
  scheduler.start();
  engine.start();
  await scheduler.tick();
  expect(job).toMatchObject({ enabled: false, verify_codex: false });
  scheduler.discovered({
    url: "https://github.com/upstream/project/pull/2",
    repository: "upstream/project",
    number: 2,
    title: "Discovered",
    state: "OPEN",
    head_branch: "other",
    head_repository: "contributor/project",
    task_id: null,
    updated_at: "now",
  });
  expect(scheduler.jobs()).toHaveLength(2);
  expect(() => scheduler.setEnabled(job.id, true)).toThrow("Automatic PR inspection");
  expect(() =>
    github.configure({
      auto_watch: true,
      interval_minutes: 60,
      verify_codex: false,
    }),
  ).toThrow("explicit user action");
  expect(() => scheduler.fix()).toThrow("Use Solve Review");
  expect(sync).not.toHaveBeenCalled();
  expect(inspect).not.toHaveBeenCalled();
  expect(infer).not.toHaveBeenCalled();
  await github.close();
});

it("legacy Check now only reads GitHub; Analyze explicitly extracts separate observations without marking replies/fixes", async () => {
  const { scheduler, infer, job, engine } = await setup();
  scheduler.runNow(job.id);
  await finished(scheduler, job.id);
  expect(infer).not.toHaveBeenCalled();
  const requestId = randomUUID();
  scheduler.analyze(job.id, requestId);
  const session = await finished(scheduler, job.id);
  expect(session).toMatchObject({
    id: requestId,
    status: "completed",
    method: "utility_ai",
  });
  expect(infer).toHaveBeenCalledOnce();
  expect(session.report?.actions).toHaveLength(4);
  expect(scheduler.jobs()[0].action?.outstandingRequests).toHaveLength(3);
  expect(
    session.report?.actions.filter((a) => a.classification === "positive_feedback"),
  ).toHaveLength(1);
  expect(session.report?.actions.every((a) => a.codeStatus === "unverified")).toBe(true);
  expect(session.snapshot?.discussion?.[0].body).toBe(reviewBody);
  expect(engine.db.tasks()).toEqual([]);
  expect(engine.db.repositories()).toEqual([]);
  expect(
    await readFile(
      join(engine.root, "cache", "utility", job.id, `analysis-${requestId}`, "source-0-0.json"),
      "utf8",
    ),
  ).toContain(JSON.stringify(reviewBody));
});

it("makes explicit requests idempotent and reuses unchanged complete reports with stable action IDs and no inference", async () => {
  const { scheduler, infer, job } = await setup();
  const requestId = randomUUID();
  scheduler.analyze(job.id, requestId);
  expect(scheduler.analyze(job.id, requestId)).toEqual({
    analysis_id: requestId,
  });
  const first = await finished(scheduler, job.id);
  scheduler.analyze(job.id);
  const second = await finished(scheduler, job.id);
  expect(second.method).toBe("reused");
  expect(second.report?.actions.map((a) => a.id)).toEqual(first.report?.actions.map((a) => a.id));
  expect(infer).toHaveBeenCalledOnce();
  expect(scheduler.analysis.history(job.id)).toHaveLength(2);
});

it("distinguishes the PR author from the viewer and preserves unverified code after an author's reply and push", async () => {
  const { scheduler, infer, inspect, job } = await setup();
  scheduler.analyze(job.id);
  const first = await finished(scheduler, job.id);
  const snapshot = structuredClone(prSnapshot);
  snapshot.authenticatedUser = "maintainer-viewer";
  snapshot.headRefOid = "c".repeat(40);
  snapshot.commits = [
    {
      sha: snapshot.headRefOid,
      author: "contributor",
      message: "Fix feedback",
      date: "2026-10-02T10:00:00Z",
      url: "https://github.com/contributor/project/commit/abc",
    },
  ];
  snapshot.discussion!.push({
    id: "author-reply",
    type: "issue_comment",
    author: "contributor",
    body: "Fixed in the latest commit.",
    createdAt: "2026-10-02T11:00:00Z",
    updatedAt: "2026-10-02T11:00:00Z",
  });
  const output = analysisResult(snapshot);
  output.observations[0].authorReplyIds = ["author-reply"];
  output.observations[0].responseState = "author_replied";
  output.observations[0].commitShas = [snapshot.headRefOid];
  inspect.mockResolvedValue(snapshot);
  infer!.mockResolvedValue(output);
  scheduler.analyze(job.id);
  const second = await finished(scheduler, job.id);
  expect(second.report?.actions[0]).toMatchObject({
    id: first.report!.actions[0].id,
    responseState: "author_replied",
    codeStatus: "unverified",
    commitShas: [snapshot.headRefOid],
  });
  expect(scheduler.jobs()[0].action?.outstandingRequests).toHaveLength(3);
});

it("keeps answered questions distinct, and retains a new reviewer request after the reply", async () => {
  const { scheduler, infer, inspect, job } = await setup();
  const snapshot = structuredClone(prSnapshot);
  snapshot.discussion!.push({
    id: "answer",
    type: "issue_comment",
    author: "contributor",
    body: "The exploration changed intentionally because of the new fixture.",
    createdAt: "2026-10-02T10:00:00Z",
    updatedAt: "2026-10-02T10:00:00Z",
  });
  snapshot.discussion!.push({
    id: "followup",
    type: "issue_comment",
    author: "reviewer",
    body: "Please restore the original exploration.",
    createdAt: "2026-10-03T10:00:00Z",
    updatedAt: "2026-10-03T10:00:00Z",
  });
  const output = analysisResult(snapshot);
  output.observations[1].authorReplyIds = ["answer"];
  output.observations[1].responseState = "answered";
  output.observations.push({
    ...output.observations[0],
    sourceId: "followup",
    originalText: snapshot.discussion![2].body,
    classification: "required_change",
  });
  inspect.mockResolvedValue(snapshot);
  infer!.mockResolvedValue(output);
  scheduler.analyze(job.id);
  const session = await finished(scheduler, job.id);
  expect(session.report?.actions[1].responseState).toBe("answered");
  expect(session.report?.actions.at(-1)).toMatchObject({
    sourceId: "followup",
    responseState: "no_author_reply",
  });
  expect(scheduler.jobs()[0].action?.outstandingRequests).toHaveLength(3);
});

it("reassesses edited quotations using their existing identity without erasing prior assessments", async () => {
  const { scheduler, infer, inspect, job, engine } = await setup();
  scheduler.analyze(job.id);
  const first = await finished(scheduler, job.id);
  const snapshot = structuredClone(prSnapshot);
  snapshot.discussion![0].body = snapshot.discussion![0].body.replace(
    "spec file directly.",
    "spec file itself.",
  );
  snapshot.discussion![0].updatedAt = "2026-10-03T10:00:00Z";
  const output = analysisResult(snapshot);
  output.observations[0].existingActionId = first.report!.actions[0].id;
  output.observations[0].originalText = output.observations[0].originalText.replace(
    "spec file directly.",
    "spec file itself.",
  );
  inspect.mockResolvedValue(snapshot);
  infer!.mockResolvedValue(output);
  scheduler.analyze(job.id);
  const second = await finished(scheduler, job.id);
  expect(second.status).toBe("completed");
  expect(second.report?.actions[0].id).toBe(first.report!.actions[0].id);
  expect(scheduler.analysis.history(job.id)[1].report?.actions[0].originalText).toContain(
    "directly",
  );
  expect(engine.db.all("SELECT * FROM pr_action_assessments")).toHaveLength(8);
});

it("does not exclude resolved/outdated review concerns or stop discussion analysis because CI fails", async () => {
  const { scheduler, infer, inspect, job } = await setup();
  const snapshot = structuredClone(prSnapshot);
  snapshot.discussion![0].threadId = "thread";
  snapshot.discussion![0].resolved = true;
  snapshot.discussion![0].outdated = true;
  snapshot.checks = [{ name: "CI", state: "FAILURE", url: "" }];
  inspect.mockResolvedValue(snapshot);
  infer!.mockResolvedValue(analysisResult(snapshot));
  scheduler.analyze(job.id);
  const session = await finished(scheduler, job.id);
  expect(infer).toHaveBeenCalledOnce();
  expect(session.report?.actions[0]).toMatchObject({
    threadResolved: true,
    outdated: true,
    codeStatus: "unverified",
  });
  expect(session.snapshot?.checks[0].state).toBe("FAILURE");
});

it.each(["quote", "reply", "commit", "coverage"])(
  "rejects fabricated %s evidence without partially persisting actions",
  async (invalid) => {
    const { scheduler, infer, job, engine } = await setup();
    const output = analysisResult();
    if (invalid === "quote") output.observations[1].originalText = "Invented request";
    if (invalid === "reply") {
      output.observations[1].authorReplyIds = ["review-1"];
      output.observations[1].responseState = "answered";
    }
    if (invalid === "commit") output.observations[1].commitShas = ["invented"];
    if (invalid === "coverage") output.coverage[0].segmentIds = ["unknown"];
    infer!.mockResolvedValue(output);
    scheduler.analyze(job.id);
    const session = await finished(scheduler, job.id);
    expect(session.status).toBe("failed");
    expect(engine.db.all("SELECT * FROM pr_action_assessments")).toEqual([]);
    expect(engine.db.all("SELECT * FROM pr_review_actions")).toEqual([]);
  },
);

it("preserves full long comments in bounded packets and exposes missing segment/retrieval coverage", async () => {
  const { scheduler, infer, inspect, job, engine } = await setup();
  const snapshot = structuredClone(prSnapshot);
  snapshot.discussion![0].body += "\nLong context 🧪".repeat(3000);
  snapshot.coverage = {
    complete: false,
    missing: ["checks"],
    warnings: ["Check pagination incomplete."],
  };
  const output = analysisResult(snapshot);
  output.coverage[0].segmentIds = ["review-1:0"];
  inspect.mockResolvedValue(snapshot);
  infer!.mockResolvedValue(output);
  const { analysis_id } = scheduler.analyze(job.id);
  const session = await finished(scheduler, job.id);
  expect(session.status).toBe("partial");
  expect(session.report?.warnings).toContain("Check pagination incomplete.");
  const dir = join(engine.root, "cache", "utility", job.id, `analysis-${analysis_id}`);
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  const bodies = await Promise.all(
    manifest.sources[0].segments.map(
      async (segment: { path: string }) =>
        JSON.parse(await readFile(join(dir, segment.path), "utf8")).body,
    ),
  );
  expect(bodies.join("")).toBe(snapshot.discussion![0].body);
  expect(Buffer.byteLength(infer!.mock.calls[0][0].prompt)).toBeLessThan(64000);
});

it("cancels an explicit semantic operation without retry and preserves the last complete report", async () => {
  const { scheduler, infer, inspect, job } = await setup();
  scheduler.analyze(job.id);
  const first = await finished(scheduler, job.id);
  // A changed context makes this another semantic operation.
  const next = structuredClone(prSnapshot);
  next.headRefOid = "d".repeat(40);
  inspect.mockResolvedValue(next);
  infer!.mockImplementation(
    async (request) =>
      new Promise((_resolve, reject) =>
        request.signal!.addEventListener("abort", () => reject(new Error("Cancelled")), {
          once: true,
        }),
      ),
  );
  scheduler.analyze(job.id);
  await vi.waitFor(() => expect(infer).toHaveBeenCalledTimes(2));
  await scheduler.cancel(job.id);
  const stopped = await finished(scheduler, job.id);
  expect(stopped.status).toBe("cancelled");
  scheduler.start();
  await scheduler.tick();
  expect(infer).toHaveBeenCalledTimes(2);
  expect(scheduler.analysis.history(job.id)[1].report).toEqual(first.report);
});

it("uses the existing real runner, read-only sandbox, saved prompts/logs and actual reported usage once", async () => {
  const { scheduler, job, engine } = await setup(true);
  const { analysis_id } = scheduler.analyze(job.id);
  const session = await finished(scheduler, job.id);
  expect(session.status, session.error).toBe("completed");
  const runs = engine.db.all<{
    id: string;
    prompt: string;
    analysis_id: string;
    status: string;
  }>("SELECT * FROM scheduled_agent_runs WHERE job_id=?", job.id);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ analysis_id, status: "completed" });
  expect(runs[0].prompt).toContain("read-only workspace");
  expect(
    engine.db.all(
      "SELECT analysis_id,input_tokens,output_tokens,reasoning_tokens FROM ai_usage WHERE job_id=?",
      job.id,
    ),
  ).toEqual([
    {
      analysis_id,
      input_tokens: 50,
      output_tokens: 10,
      reasoning_tokens: null,
    },
  ]);
  expect(
    await readFile(join(engine.root, "logs", `pr-watch-${job.id}`, `${runs[0].id}.jsonl`), "utf8"),
  ).toContain("pr-fixture-session");
  expect(engine.db.tasks()).toEqual([]);
});

it("classifies exact reviewer acknowledgments without invoking a model", async () => {
  const { scheduler, inspect, infer, job } = await setup();
  const snapshot = structuredClone(prSnapshot);
  snapshot.discussion![0].body = "LGTM";
  snapshot.reviewDecision = "APPROVED";
  inspect.mockResolvedValue(snapshot);
  scheduler.analyze(job.id);
  const session = await finished(scheduler, job.id);
  expect(session).toMatchObject({
    status: "completed",
    method: "deterministic",
  });
  expect(session.report?.actions).toHaveLength(1);
  expect(session.report?.actions[0].classification).toBe("positive_feedback");
  expect(scheduler.jobs()[0].action?.outstandingRequests).toEqual([]);
  expect(infer).not.toHaveBeenCalled();
});

it("blocks removal as soon as an explicit analysis is registered and permits cancellation before retrieval", async () => {
  const { engine, monitor, inspect, job } = await setup();
  const rpc = new Rpc(engine, monitor);
  try {
    rpc.scheduler.analyze(job.id);
    const removal = rpc.call("scheduled.remove", {
      id: job.id,
      confirmed: true,
    });
    const cancellation = rpc.scheduler.cancel(job.id);
    await expect(removal).rejects.toThrow("Wait for inspection to finish");
    await cancellation;
    expect(inspect).not.toHaveBeenCalled();
    expect(rpc.scheduler.analysis.history(job.id)[0].status).toBe("cancelled");
    expect(engine.cleanupBlockers()).toEqual([]);
  } finally {
    await rpc.close();
  }
});

it("retains the complete report when a fresh GitHub inspection fails", async () => {
  const { scheduler, inspect, infer, job } = await setup();
  scheduler.analyze(job.id);
  const complete = await finished(scheduler, job.id);
  inspect.mockRejectedValue(new Error("Review pagination unavailable"));
  scheduler.analyze(job.id);
  const failed = await finished(scheduler, job.id);
  expect(failed).toMatchObject({
    status: "failed",
    error: "Review pagination unavailable",
  });
  expect(scheduler.analysis.history(job.id)[1].report).toEqual(complete.report);
  expect(scheduler.jobs()[0].last_snapshot).toEqual(prSnapshot);
  expect(infer).toHaveBeenCalledOnce();
});

it("interrupts an in-flight analysis on shutdown and does not replay it after reopening", async () => {
  const { scheduler, inspect, infer, job, dir, engine } = await setup();
  scheduler.analyze(job.id);
  const complete = await finished(scheduler, job.id);
  inspect.mockResolvedValue({ ...prSnapshot, headRefOid: "e".repeat(40) });
  infer!.mockImplementation(
    async (request) =>
      new Promise((_resolve, reject) =>
        request.signal!.addEventListener("abort", () => reject(new Error("Interrupted")), {
          once: true,
        }),
      ),
  );
  scheduler.analyze(job.id);
  await vi.waitFor(() => expect(infer).toHaveBeenCalledTimes(2));
  await scheduler.close();
  expect(scheduler.analysis.history(job.id)[0].status).toBe("interrupted");
  expect(engine.cleanupBlockers()).toEqual([]);
  await engine.close();
  resources.splice(
    resources.findIndex((resource) => resource.engine === engine),
    1,
  );
  const reopened = await createFixtureEngine(join(dir, "data"), () => new PRFixtureProvider());
  const freshMonitor = new GitHubMonitor(dir);
  const freshInspect = vi.spyOn(freshMonitor, "inspect");
  const freshInfer = vi.spyOn(reopened.utility, "run");
  const freshScheduler = new Scheduler(reopened, freshMonitor);
  try {
    freshScheduler.start();
    reopened.start();
    await freshScheduler.tick();
    expect(freshScheduler.analysis.history(job.id)[0].status).toBe("interrupted");
    expect(freshScheduler.analysis.history(job.id)[1].report).toEqual(complete.report);
    expect(freshScheduler.jobs()[0].enabled).toBe(false);
    expect(freshInspect).not.toHaveBeenCalled();
    expect(freshInfer).not.toHaveBeenCalled();
  } finally {
    await freshScheduler.close();
    await reopened.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("validates PR URLs and retains legacy change detection", () => {
  expect(parsePullRequest("https://github.com/oppia/oppia/pull/42").number).toBe(42);
  for (const url of [
    "https://github.com/oppia/oppia/issues/42",
    "https://github.com/oppia/oppia/pull/42?x=1",
    "https://github.com:8080/oppia/oppia/pull/42",
  ])
    expect(() => parsePullRequest(url)).toThrow();
  expect(changedPullRequest(prSnapshot, structuredClone(prSnapshot)).actionable).toBe(false);
  expect(changedPullRequest(prSnapshot, { ...prSnapshot, state: "MERGED" })).toMatchObject({
    actionable: false,
    changes: ["PR state: MERGED"],
  });
});
