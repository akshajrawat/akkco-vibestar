import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultSettings, parseIssue } from "../../backend/domain";
import { Rpc } from "../../backend/rpc";
import { taskVerification } from "../../backend/execution/verification/task-verification";
import { missingVerificationChecks } from "../../backend/execution/verification/verification-recovery";
import {
  createFixtureEngine,
  fixtureRepository,
  finishFixtureTask,
  waitForTask,
  FixtureProvider,
} from "../helpers/fixtures";
import { ValidationBlockerProvider, IndependentReviewProvider } from "./provider";

const settings = {
  ...defaultSettings,
  antigravity: { model: "next-model", effort: "low", timeout_secs: 30 },
  codex_plan: { model: "next-model", effort: "low", timeout_secs: 30 },
  codex_implementation: {
    model: "next-model",
    effort: "low",
    timeout_secs: 30,
  },
};

it("never consumes queued feedback or starts a model when a successful saved-evidence recheck opens implementation approval", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-v2-recheck-queue-"));
  const selected: number[] = [];
  const engine = await createFixtureEngine(join(dir, "data"), (stage) => {
    selected.push(stage);
    return new FixtureProvider();
  });
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const task = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/12"),
      "One explicit implementation",
      "",
      {},
      "partial",
      settings,
    );
    await finishFixtureTask(
      engine,
      task.id,
      (status) =>
        status === "awaiting_approval" &&
        engine.db.task(task.id).approval_gate === "implementation",
    );
    await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false));
    const preparation = engine.db.task(task.id).preparation_timing;
    expect(preparation?.ended_at).toBeTruthy();
    expect(Date.parse(preparation!.ended_at!)).toBeGreaterThanOrEqual(
      Date.parse(preparation!.started_at),
    );
    const saved = engine.followUp(
      task.id,
      "Keep this feedback queued for an explicit choice",
      undefined,
      true,
    );
    engine.db.run("UPDATE task_messages SET status='queued' WHERE id=?", saved.message.id);
    await engine.recheckEvidence(task.id);
    await waitForTask(engine, task.id, (status) => status === "awaiting_approval");
    await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false));
    expect(engine.db.task(task.id).approval_gate).toBe("implementation");
    expect(selected).toEqual([1, 2, 3]);
    expect(
      engine.db.all("SELECT status,run_id FROM task_messages WHERE id=?", saved.message.id)[0],
    ).toMatchObject({ status: "queued", run_id: null });
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

it("requires current explicit gap approval, gives an independent read-only reviewer complete evidence, preserves gaps and refuses publication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-v2-review-"));
  const selected: { stage: number; provider?: string }[] = [];
  const provider = (stage: number, name?: string) => {
    selected.push({ stage, provider: name });
    return new IndependentReviewProvider();
  };
  let engine = await createFixtureEngine(join(dir, "data"), provider);
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const task = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/9"),
      "Multiplication table",
      "",
      {},
      "partial",
      settings,
    );
    await finishFixtureTask(engine, task.id, (status) => status === "verification_blocked");
    await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false));
    let rpc = new Rpc(engine);
    const original = taskVerification(engine.db, task.id);
    expect(original).toMatchObject({
      canReview: false,
      canReviewWithGaps: true,
    });
    expect(original.blockers.map((blocker) => blocker.title)).toEqual([
      "DNS resolution unavailable",
      "Loopback socket denied",
    ]);
    const preview = await engine.reviewGapsPreview(task.id);
    await expect(engine.retry(task.id, 5)).rejects.toThrow();
    const artifact = engine.db.all<{ id: string }>(
      "SELECT id FROM task_artifacts WHERE task_id=? AND stage=3 AND kind='plan'",
      task.id,
    )[0];
    const file = join(engine.db.task(task.id).worktree_path, "script.js");
    const source = await readFile(file, "utf8");
    await writeFile(file, source + "// Changed since preview\n");
    await expect(
      rpc.call("task.verification.continueReview", {
        id: task.id,
        artifact_id: artifact.id,
        acknowledge_gaps: true,
        ...preview,
        checks: undefined,
        eligible: undefined,
      }),
    ).rejects.toThrow();
    await expect(engine.approveStage(task.id, undefined, artifact.id, preview)).rejects.toThrow(
      "changed",
    );
    await writeFile(file, source);
    await engine.close();
    engine = await createFixtureEngine(join(dir, "data"), provider);
    rpc = new Rpc(engine);
    expect(selected.map((run) => run.stage)).toEqual([1, 2, 3]);
    const current = await engine.reviewGapsPreview(task.id);
    const params = {
      id: task.id,
      artifact_id: artifact.id,
      acknowledge_gaps: true,
      fingerprint: current.fingerprint,
      evidence_hash: current.evidence_hash,
    };
    await rpc.call("task.verification.continueReview", params);
    await expect(rpc.call("task.verification.continueReview", params)).rejects.toThrow();
    await waitForTask(engine, task.id, (status) =>
      ["awaiting_approval", "failed"].includes(status),
    );
    await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false));
    expect(engine.db.task(task.id), engine.db.task(task.id).error || "review").toMatchObject({
      approval_gate: "final_review",
      final_review_verdict: "code_approved_incomplete",
    });
    expect(selected.map((run) => run.stage)).toEqual([1, 2, 3, 5]);
    expect(selected.at(-1)?.provider).toBe("antigravity");
    const after = taskVerification(engine.db, task.id);
    expect(
      after.checks.find((check) => check.name === "Browser rendering and accessibility")?.outcome,
    ).toBe("blocked");
    expect(after.canReview).toBe(false);
    await engine.approveStage(task.id);
    expect(engine.db.task(task.id).status).toBe("reviewed_with_gaps");
    await expect(rpc.call("task.complete", { id: task.id })).rejects.toThrow();
    await expect(
      rpc.call("git.preview", {
        id: task.id,
        request_id: randomUUID(),
        expected_hash: "invalid",
        paths: ["script.js"],
        replace_selected_staged: false,
      }),
    ).rejects.toMatchObject({ kind: "verification_blocked" });
    expect(engine.db.all("SELECT id FROM git_finalizations")).toHaveLength(0);
    expect(await readFile(file, "utf8")).toBe(source);
    engine.fixWithCodex(task.id, randomUUID());
    const repairing = engine.db.task(task.id);
    expect(repairing.final_review_hash).toBeUndefined();
    expect(repairing.final_review_verdict).toBeUndefined();
    expect(repairing.review_gap_acknowledgment).toBeUndefined();
    await waitForTask(engine, task.id, (status) => status === "verification_blocked");
    await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false));
    expect(
      taskVerification(engine.db, task.id).checks.find(
        (check) => check.name === "Independent mobile viewport",
      ),
    ).toMatchObject({ required: true });
    expect(selected.map((run) => run.stage)).toEqual([1, 2, 3, 5, 3]);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

it("runs a selected recognizable missing check without inference and records repeat attempts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-v2-run-"));
  const selected: number[] = [];
  const engine = await createFixtureEngine(join(dir, "data"), (stage) => {
    selected.push(stage);
    return new ValidationBlockerProvider();
  });
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const task = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/10"),
      "Table",
      "",
      {},
      "partial",
      settings,
    );
    await finishFixtureTask(engine, task.id, (status) => status === "verification_blocked");
    await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false));
    const artifact = engine.db.all<{ id: string; content: string }>(
      "SELECT id,content FROM task_artifacts WHERE task_id=? AND stage=3 AND kind='plan'",
      task.id,
    )[0];
    const report = JSON.parse(artifact.content);
    report.verification.push({
      name: "Additional syntax",
      command: "/bin/bash -lc 'node --check script.js'",
      kind: "check",
      outcome: "not_run",
      required: true,
      detail: "Required explicit check",
      prerequisite: null,
    });
    engine.db.run(
      "UPDATE task_artifacts SET content=? WHERE id=?",
      JSON.stringify(report),
      artifact.id,
    );
    const rpc = new Rpc(engine);
    expect(
      missingVerificationChecks(taskVerification(engine.db, task.id)).some(
        (check) => check.command === "/bin/bash -lc 'node --check script.js'",
      ),
    ).toBe(true);
    await expect(
      rpc.call("task.verification.run", {
        id: task.id,
        command: "npm install playwright",
      }),
    ).rejects.toThrow();
    await rpc.call("task.verification.run", {
      id: task.id,
      command: "/bin/bash -lc 'node --check script.js'",
    });
    await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false));
    expect(
      taskVerification(engine.db, task.id).checks.find(
        (check) => check.name === "Additional syntax",
      )?.outcome,
    ).toBe("passed");
    await rpc.call("task.verification.recheck", { id: task.id });
    await waitForTask(engine, task.id, (status) => status === "verification_blocked");
    await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false));
    expect(selected).toEqual([1, 2, 3]);
    expect(engine.db.detail(task.id).tests.filter((row) => !row.run_id)).toHaveLength(3);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

it("blocks real assertion waivers and authorizes only one explicit Codex repair in the original worktree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-v2-fix-"));
  let implementations = 0;
  const selected: { stage: number; provider?: string }[] = [];
  const engine = await createFixtureEngine(join(dir, "data"), (stage, provider) => {
    selected.push({ stage, provider });
    return new ValidationBlockerProvider(stage === 3 && implementations++ === 0);
  });
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const task = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/11"),
      "Table",
      "",
      {},
      "partial",
      settings,
    );
    await finishFixtureTask(engine, task.id, (status) => status === "failed");
    await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false));
    expect(taskVerification(engine.db, task.id).canReviewWithGaps).toBe(false);
    await expect(engine.reviewGapsPreview(task.id)).rejects.toThrow();
    const path = engine.db.task(task.id).worktree_path;
    const request = randomUUID();
    engine.fixWithCodex(task.id, request);
    engine.fixWithCodex(task.id, request);
    await waitForTask(engine, task.id, (status) => status === "verification_blocked");
    await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false));
    expect(engine.db.task(task.id).worktree_path).toBe(path);
    expect(selected.map((run) => run.stage)).toEqual([1, 2, 3, 3]);
    expect(selected.at(-1)?.provider).toBe("codex");
    expect(
      engine.db
        .detail(task.id)
        .tests.filter(
          (test) =>
            typeof test.command === "string" &&
            test.command.includes('"install","--no-save","playwright"'),
        ),
    ).toHaveLength(1);
    expect(engine.db.detail(task.id).runs.at(-1)?.prompt).toContain("AssertionError");
    expect(engine.db.detail(task.id).runs.at(-1)?.prompt).toContain(
      "prepare repeatable test scripts",
    );
    expect(taskVerification(engine.db, task.id).outcome).toBe("blocked");
    expect(
      engine.db.all(
        "SELECT id FROM task_activity WHERE task_id=? AND kind='verification_repair'",
        task.id,
      ),
    ).toHaveLength(1);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
