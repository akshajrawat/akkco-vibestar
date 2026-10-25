import { IssueWatchFixtureProvider as SemanticProvider } from "./provider";
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { migrateDataRoot } from "../../backend/storage/migrate-root";
import { StorageService } from "../../backend/storage/service";
import { IssueWatchStore } from "../../backend/issue-watch/store";
import { createFixtureEngine } from "../fixtures";
import { validateSemanticReport } from "../../backend/issue-watch/semantic";
import { watchConfiguration, watchFixture } from "./fixtures";

const resources: Awaited<ReturnType<typeof watchFixture>>[] = [];
const setup = async () => {
  const provider = new SemanticProvider();
  const f = await watchFixture(() => provider);
  resources.push(f);
  return { f, provider };
};
afterEach(async () => {
  for (const f of resources.splice(0)) await f.close();
  vi.restoreAllMocks();
});

it("uses one existing sandboxed utility run, real reported usage and owner-checked readable/raw history", async () => {
  const { f, provider } = await setup();
  const { watch } = await f.create(
    watchConfiguration("Open issues. Prefer focused test changes."),
  );
  const infer = vi.spyOn(f.engine.utility, "run");
  const scan = await f.scan(watch.id);
  expect(scan).toMatchObject({
    status: "completed",
    semantic_attempts: 1,
    utility_run_id: expect.any(String),
    coverage: { semantic_complete: true, semantic_checked: 3 },
  });
  expect(provider.calls).toBe(1);
  expect(infer).toHaveBeenCalledOnce();
  expect(f.engine.db.tasks()).toEqual([]);
  expect(f.engine.db.repositories()).toEqual([]);
  const usage = f.engine.db.all<{
    watch_id: string;
    scan_id: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  }>("SELECT * FROM ai_usage WHERE scan_id=?", scan.id);
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({
    watch_id: watch.id,
    scan_id: scan.id,
    input_tokens: 100,
    output_tokens: 25,
    total_tokens: 125,
  });
  expect(f.engine.db.all("SELECT * FROM agent_runs")).toEqual([]);
  const output = (await f.service.call("events", {
    watch_id: watch.id,
    scan_id: scan.id,
    run_id: scan.utility_run_id,
  })) as { events: unknown[] };
  expect(output.events.length).toBeGreaterThan(0);
  const logs = (await f.service.call("logs", {
    watch_id: watch.id,
    scan_id: scan.id,
    run_id: scan.utility_run_id,
  })) as { text: string };
  expect(logs.text).toContain("Focused fixture issue");
  await expect(
    f.service.call("events", {
      watch_id: watch.id,
      scan_id: scan.id,
      run_id: randomUUID(),
    }),
  ).rejects.toThrow("does not belong");
  const prompt = await readFile(
    join(f.engine.root, "artifacts", "issue-watch", scan.id, "prompt.txt"),
    "utf8",
  );
  expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(128 * 1024);
  expect(prompt).toContain("untrusted data");
  await f.service.call("scanDetail", { watch_id: watch.id, scan_id: scan.id });
  await f.service.call("candidateDetail", {
    watch_id: watch.id,
    scan_id: scan.id,
    issue_id: "I_1",
  });
  await f.restart();
  expect(provider.calls).toBe(1);
  expect(f.service.store.scan(watch.id, scan.id).utility_run_id).toBe(
    scan.utility_run_id,
  );
});

it.each(["unknown", "forged-citation", "quota"])(
  "preserves GitHub-only evidence on %s without retries, fallback or baseline advancement",
  async (mode) => {
    const { f, provider } = await setup();
    const { watch } = await f.create(
      watchConfiguration("Open issues. Prefer focused changes."),
    );
    const baseline = await f.scan(watch.id);
    provider.mode = mode;
    const failed = await f.scan(watch.id);
    expect(failed).toMatchObject({
      status: "partial",
      semantic_attempts: 1,
      coverage: { semantic_complete: false },
    });
    expect(provider.calls).toBe(2);
    expect(f.service.store.get(watch.id).last_complete_scan_id).toBe(
      baseline.id,
    );
    expect(f.service.store.candidates(watch.id, failed.id)).toHaveLength(3);
    expect(
      f.service.store
        .candidates(watch.id, failed.id)
        .every(
          (candidate) =>
            candidate.semantic_state ===
            (mode === "quota" ? "unavailable" : "invalid"),
        ),
    ).toBe(true);
    const usage = f.engine.db.all<{ total_tokens: number | null }>(
      "SELECT * FROM ai_usage WHERE scan_id=?",
      failed.id,
    )[0];
    expect(usage.total_tokens).toBe(mode === "quota" ? null : 125);
  },
);

it("skips inference when deterministic exclusions reject every candidate", async () => {
  const { f, provider } = await setup();
  const { watch } = await f.create(
    watchConfiguration("Open issues. Prefer focused changes.", {
      excluded_issues: [1, 2, 27409].map((number) => ({
        repository: "oppia/oppia",
        number,
      })),
    }),
  );
  const scan = await f.scan(watch.id);
  expect(scan).toMatchObject({
    status: "completed",
    semantic_attempts: 0,
    coverage: { semantic_checked: 0 },
  });
  expect(provider.calls).toBe(0);
  expect(f.engine.db.all("SELECT * FROM ai_usage")).toEqual([]);
});

it("bounds semantic candidates and complete packets without invoking an automatic second model", async () => {
  const { f, provider } = await setup();
  const configuration = watchConfiguration(
    "Open issues. Prefer focused changes.",
  );
  configuration.limits.max_semantic_candidates = 1;
  const { watch } = await f.create(configuration);
  const scan = await f.scan(watch.id);
  expect(scan).toMatchObject({
    status: "partial",
    semantic_attempts: 1,
    coverage: { semantic_checked: 1 },
  });
  expect(provider.calls).toBe(1);
  expect(f.service.store.get(watch.id).last_complete_scan_id).toBeNull();
  for (const issue of f.issues.values()) issue.body = "x".repeat(200000);
  const oversized = await f.scan(watch.id);
  expect(oversized).toMatchObject({ status: "partial", semantic_attempts: 0 });
  expect(provider.calls).toBe(1);
});

it("awaits cancellation of the real fixture process and preserves the consumed slot across restart", async () => {
  const { f, provider } = await setup();
  const { watch } = await f.create(
    watchConfiguration("Open issues. Prefer focused changes."),
  );
  const baseline = await f.scan(watch.id);
  provider.mode = "hang";
  const operation = f.service.launch({
    watch_id: watch.id,
    expected_revision: 1,
    request_id: randomUUID(),
  });
  await vi.waitFor(() =>
    expect(
      f.engine.db.all<{ pid: number | null }>(
        "SELECT pid FROM utility_runs WHERE scan_id=?",
        operation.scan_id,
      )[0]?.pid,
    ).toBeTypeOf("number"),
  );
  const cancelled = await f.service.cancel(watch.id, operation.scan_id);
  expect(cancelled).toMatchObject({
    status: "cancelled",
    semantic_attempts: 1,
    utility_run_id: expect.any(String),
  });
  expect(
    f.engine.db.all<{ status: string }>(
      "SELECT status FROM utility_runs WHERE scan_id=?",
      cancelled.id,
    )[0].status,
  ).toBe("cancelled");
  expect(f.service.store.get(watch.id).last_complete_scan_id).toBe(baseline.id);
  await f.restart();
  expect(provider.calls).toBe(2);
});

it("rejects duplicate identities, unsupported actors and false factual blockers before any result is promoted", async () => {
  const { f } = await setup();
  const { watch } = await f.create(
    watchConfiguration("Open issues. Prefer focused changes."),
  );
  const scan = await f.scan(watch.id);
  const candidates = f.service.store.candidates(watch.id, scan.id);
  const sources = f.service.store.sources(watch.id, scan.id);
  const result = candidates[0].semantic!;
  expect(() =>
    validateSemanticReport({ results: [result, result] }, candidates, sources),
  ).toThrow("duplicate");
  expect(() =>
    validateSemanticReport(
      {
        results: [
          { ...result, description: "@invented-maintainer approves this" },
        ],
      },
      candidates,
      sources,
    ),
  ).toThrow("actor absent");
  expect(() =>
    validateSemanticReport(
      { results: [{ ...result, claim_assessment: "assigned" }] },
      candidates,
      sources,
    ),
  ).toThrow("invented a factual");
});

it("reapplies current hard facts after the model and refuses a fresh label exclusion", async () => {
  const { f, provider } = await setup();
  const { watch } = await f.create(
    watchConfiguration("Open issues. Prefer focused changes.", {
      excluded_labels: ["triage needed"],
    }),
  );
  provider.onInvoke = () => {
    f.issues.get(1)!.labels = [{ name: "Triage Needed" }];
  };
  const scan = await f.scan(watch.id);
  expect(provider.calls).toBe(1);
  expect(scan.status).toBe("partial");
  expect(f.service.store.candidate(watch.id, scan.id, "I_1")).toMatchObject({
    eligible: false,
    claim_state: "ineligible",
    semantic_state: "unavailable",
  });
  expect(f.service.store.get(watch.id).last_complete_scan_id).toBeNull();
});

it("requires explicit continuation selection and gives it a new one-call attempt with fresh trackers", async () => {
  const { f, provider } = await setup();
  const configuration = watchConfiguration(
    "Open issues. Prefer focused changes.",
    {
      trackers: [
        {
          url: "https://github.com/oppia/oppia/issues/27409",
          comments: "none",
        },
      ],
    },
  );
  configuration.limits.max_semantic_candidates = 1;
  f.issues.get(27409)!.body = "No exclusions yet.";
  const { watch } = await f.create(configuration);
  const first = await f.scan(watch.id);
  expect(first.status).toBe("partial");
  await expect(
    f.service.call("continue", {
      watch_id: watch.id,
      scan_id: first.id,
      request_id: randomUUID(),
    }),
  ).rejects.toThrow("Confirm the candidate selection");
  const pending = f.service.store
    .candidates(watch.id, first.id)
    .filter((candidate) => candidate.semantic_state === "unavailable")[0];
  f.issues.get(27409)!.body = `#${pending.issue.number}`;
  const operation = (await f.service.call("continue", {
    watch_id: watch.id,
    scan_id: first.id,
    request_id: randomUUID(),
    candidate_ids: [pending.issue.id],
  })) as { scan_id: string };
  const next = await f.finished(watch.id, operation.scan_id);
  expect(next).toMatchObject({
    status: "partial",
    semantic_attempts: 0,
    parent_scan_id: first.id,
  });
  expect(
    f.service.store.candidate(watch.id, next.id, pending.issue.id).eligible,
  ).toBe(false);
  expect(provider.calls).toBe(1);
  expect(f.service.store.get(watch.id).last_complete_scan_id).toBeNull();
});

it("keeps a consumed host slot without launching a CLI when shared execution capacity is unavailable", async () => {
  const { f, provider } = await setup();
  const { watch } = await f.create(
    watchConfiguration("Open issues. Prefer focused changes."),
  );
  const infer = vi
    .spyOn(f.engine.utility, "run")
    .mockRejectedValue(new Error("Shared task execution capacity unavailable"));
  const scan = await f.scan(watch.id);
  expect(scan).toMatchObject({
    status: "partial",
    semantic_attempts: 1,
    utility_run_id: null,
  });
  expect(infer).toHaveBeenCalledOnce();
  expect(provider.calls).toBe(0);
  expect(f.engine.db.all("SELECT * FROM ai_usage")).toEqual([]);
  expect(() =>
    f.service.store.reserveSemantic(scan, scan.context_hash!),
  ).toThrow("no unused");
  await f.restart();
  expect(provider.calls).toBe(0);
});

it("records missing model candidates as partial coverage and requires another explicit attempt", async () => {
  const { f, provider } = await setup();
  provider.mode = "missing";
  const { watch } = await f.create(
    watchConfiguration("Open issues. Prefer focused changes."),
  );
  const scan = await f.scan(watch.id);
  expect(scan).toMatchObject({
    status: "partial",
    semantic_attempts: 1,
    coverage: { semantic_checked: 2, semantic_complete: false },
  });
  expect(provider.calls).toBe(1);
  expect(
    f.service.store
      .candidates(watch.id, scan.id)
      .filter((candidate) => candidate.semantic_state === "unavailable"),
  ).toHaveLength(1);
});

it("migrates prompts, utility events and reported usage together, and resets their FK ownership explicitly", async () => {
  const { f, provider } = await setup();
  const { watch } = await f.create(
    watchConfiguration("Open issues. Prefer focused changes."),
  );
  const scan = await f.scan(watch.id);
  const prompt = await readFile(
    join(f.engine.root, "artifacts", "issue-watch", scan.id, "prompt.txt"),
    "utf8",
  );
  await f.service.close();
  await f.engine.close();
  const destination = join(f.dir, "semantic-migrated");
  await migrateDataRoot(join(f.dir, "data"), destination);
  const engine = await createFixtureEngine(destination, () => provider);
  try {
    expect(
      new IssueWatchStore(engine.db).scan(watch.id, scan.id).utility_run_id,
    ).toBe(scan.utility_run_id);
    expect(
      engine.db.all(
        "SELECT id FROM utility_events WHERE run_id=?",
        scan.utility_run_id!,
      ),
    ).not.toEqual([]);
    expect(
      engine.db.all<{ total_tokens: number }>(
        "SELECT total_tokens FROM ai_usage WHERE scan_id=?",
        scan.id,
      )[0].total_tokens,
    ).toBe(125);
    expect(
      await readFile(
        join(destination, "artifacts", "issue-watch", scan.id, "prompt.txt"),
        "utf8",
      ),
    ).toBe(prompt);
    const storage = new StorageService(engine);
    const resetPreview = await storage.previewReset();
    await storage.reset(resetPreview.token);
    // Task-only reset preserves independently owned watches and their evidence.
    expect(engine.db.all("SELECT * FROM issue_watches")).not.toEqual([]);
    expect(engine.db.all("SELECT * FROM utility_events")).not.toEqual([]);
    expect(engine.db.all("SELECT * FROM utility_runs")).not.toEqual([]);
    expect(engine.db.all("PRAGMA foreign_key_check")).toEqual([]);
  } finally {
    await engine.close();
  }
});
