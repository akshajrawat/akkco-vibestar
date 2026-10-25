import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createFixtureEngine } from "./fixtures";
import { Scheduler } from "../backend/scheduled/scheduler";
import { GitHubMonitor } from "../backend/scheduled/github";
import { PRAnalysisBatches } from "../backend/review/pr/batches";
import { reviewActionState } from "../backend/review/pr/inbox";
import { analysisResult, prSnapshot } from "./pr-fixtures";

let directory: string;
let engine: Awaited<ReturnType<typeof createFixtureEngine>>;
let scheduler: Scheduler;
let batches: PRAnalysisBatches;
let monitor: GitHubMonitor;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "vibestar-pr-batches-"));
  engine = await createFixtureEngine(join(directory, "data"));
  monitor = new GitHubMonitor(directory);
  vi.spyOn(monitor, "inspect").mockResolvedValue(structuredClone(prSnapshot));
  scheduler = new Scheduler(engine, monitor);
  batches = new PRAnalysisBatches(engine, scheduler);
});
afterEach(async () => {
  await batches.close();
  await scheduler.close();
  await engine.close();
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const jobs = () =>
  [1, 2, 3].map((number) =>
    scheduler.add({
      url: `https://github.com/upstream/project/pull/${number}`,
      task_id: null,
      interval_minutes: 60,
      verify_codex: false,
    }),
  );
const configuration = {
  provider: "codex" as const,
  config: { model: "fixture", effort: "low", timeout_secs: 30 },
};
const finished = async (id: string) => {
  await vi.waitFor(
    () =>
      expect(batches.list().find((batch) => batch.id === id)?.status).not.toBe(
        "running",
      ),
    { timeout: 10000 },
  );
  return batches.list().find((batch) => batch.id === id)!;
};

it("previews without AI, enforces the persisted invocation cap and retains partial per-PR evidence", async () => {
  const infer = vi
    .spyOn(engine.utility, "run")
    .mockResolvedValue(analysisResult());
  const selected = jobs();
  expect(infer).not.toHaveBeenCalled();
  const selection = {
    job_ids: selected.map((job) => job.id),
    scope: "open" as const,
  };
  expect(await batches.preview(selection)).toMatchObject({
    selected: 3,
    reusable: 0,
  });
  expect(infer).not.toHaveBeenCalled();
  const request = {
    ...selection,
    request_id: randomUUID(),
    configuration,
    max_analyses: 1,
    confirmed: true as const,
  };
  const batch = batches.start(request);
  expect(batches.start(request).id).toBe(batch.id);
  const result = await finished(batch.id);
  expect(result.analyses_used).toBe(1);
  expect(infer).toHaveBeenCalledTimes(1);
  expect(result.items.map((item) => item.status)).toEqual([
    "completed",
    "partial",
    "partial",
  ]);
  expect(
    scheduler.analysis.history(selected[1].id)[0].snapshot?.headRefOid,
  ).toBe(prSnapshot.headRefOid);
  expect(scheduler.analysis.history(selected[1].id)[0].error).toContain("cap");
  expect(() => batches.start({ ...request, max_analyses: 2 })).toThrow(
    "different",
  );
});

it("reuses an unchanged complete report with a zero-AI authorization and detects stale heads", async () => {
  const infer = vi
    .spyOn(engine.utility, "run")
    .mockResolvedValue(analysisResult());
  const [job] = jobs();
  await scheduler.analyzeBatchItem(job.id, randomUUID(), {
    configuration: { ...configuration.config, provider: "codex" },
    authorizeInference: () => {},
  });
  expect(
    await batches.preview({ job_ids: [job.id], scope: "selected" }),
  ).toMatchObject({ reusable: 1 });
  const batch = batches.start({
    job_ids: [job.id],
    scope: "selected",
    request_id: randomUUID(),
    max_analyses: 0,
    configuration,
    confirmed: true,
  });
  const result = await finished(batch.id);
  expect(result.items[0].status).toBe("completed");
  expect(result.analyses_used).toBe(0);
  expect(infer).toHaveBeenCalledTimes(1);
  const report = scheduler.analysis.history(job.id)[0];
  expect(
    reviewActionState(report, {
      url: job.url,
      repository: "upstream/project",
      number: 1,
      title: "Fixture",
      state: "OPEN",
      head_branch: "feature",
      head_repository: "contributor/project",
      task_id: null,
      updated_at: "2026-01-01T00:00:00Z",
      head_sha: "f".repeat(40),
    }),
  ).toBe("Analysis stale");
});

it("cancels without erasing completed PR results and prevents concurrent duplicate analysis", async () => {
  const selected = jobs();
  vi.spyOn(engine.utility, "run").mockResolvedValue(analysisResult());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(monitor.inspect).mockImplementation(async (url, signal) => {
    if (url.endsWith("/2")) {
      release();
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new Error("Cancelled fixture retrieval")),
          { once: true },
        );
      });
    }
    return structuredClone(prSnapshot);
  });
  const batch = batches.start({
    job_ids: selected.map((job) => job.id),
    scope: "selected",
    request_id: randomUUID(),
    max_analyses: 3,
    configuration,
    confirmed: true,
  });
  await gate;
  expect(() => scheduler.analyze(selected[1].id)).toThrow("already running");
  await batches.cancel(batch.id);
  const result = await finished(batch.id);
  expect(result.status).toBe("cancelled");
  expect(result.items.map((item) => item.status)).toEqual([
    "completed",
    "cancelled",
    "cancelled",
  ]);
  expect(scheduler.analysis.history(selected[0].id)[0].report?.complete).toBe(
    true,
  );
});

it("marks persisted unfinished batches interrupted on reopen without inference", async () => {
  const [job] = jobs();
  vi.spyOn(engine.utility, "run").mockResolvedValue(analysisResult());
  const batch = batches.start({
    job_ids: [job.id],
    scope: "open",
    request_id: randomUUID(),
    max_analyses: 0,
    configuration,
    confirmed: true,
  });
  const saved = await finished(batch.id);
  saved.status = "running";
  saved.items[0].status = "running";
  engine.db.run(
    "UPDATE pr_analysis_batches SET status='running',data=? WHERE id=?",
    JSON.stringify(saved),
    batch.id,
  );
  await batches.close();
  await scheduler.close();
  await engine.close();
  engine = await createFixtureEngine(join(directory, "data"));
  const monitor = new GitHubMonitor(directory);
  const remote = vi.spyOn(monitor, "inspect");
  scheduler = new Scheduler(engine, monitor);
  batches = new PRAnalysisBatches(engine, scheduler);
  expect(batches.list()[0]).toMatchObject({
    status: "interrupted",
    items: [{ status: "interrupted" }],
  });
  expect(remote).not.toHaveBeenCalled();
  expect(engine.db.all("SELECT * FROM ai_usage")).toEqual([]);
});
