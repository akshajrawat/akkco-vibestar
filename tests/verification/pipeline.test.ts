import { expect, it, vi } from "vitest";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultSettings, parseIssue } from "../../backend/domain";
import { Rpc } from "../../backend/rpc";
import {
  createFixtureEngine,
  fixtureRepository,
  waitForTask,
  finishFixtureTask,
} from "../helpers/fixtures";
import { ValidationBlockerProvider } from "./provider";
import type { Detail } from "../../src/lib/types";

it("retains agent checks and setup blockers at implementation approval without a separate validation run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-validation-blocker-"));
  const root = join(dir, "data");
  const selected: number[] = [];

  const providers = (stage: number) => {
    selected.push(stage);
    return new ValidationBlockerProvider();
  };

  let engine = await createFixtureEngine(root, providers);
  try {
    const { repo, upstream } = await fixtureRepository(engine, dir);

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

    const task = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/4"),
      "Multiplication table",
      "",
      {},
      "partial",
      settings,
    );

    for (const gate of ["antigravity_plan", "codex_plan"]) {
      await waitForTask(engine, task.id, (status) =>
        ["awaiting_approval", "failed", "verification_blocked"].includes(status),
      );

      await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false));
      expect(engine.db.task(task.id).approval_gate).toBe(gate);
      await engine.approveStage(task.id);
    }

    await waitForTask(engine, task.id, (status) => status === "awaiting_approval");
    await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false));
    const rpc = new Rpc(engine);
    const detail = (await rpc.call("task.detail", { id: task.id })) as Detail;

    expect(detail.task).toMatchObject({
      stage: 5,
      status: "awaiting_approval",
      approval_gate: "implementation",
    });

    expect(detail.task.error).toBeNull();

    expect(detail.validation).toMatchObject({
      outcome: "blocked",
      canReview: false,
    });

    expect(detail.validation?.checks.filter((check) => check.outcome === "passed")).toHaveLength(3);

    expect(detail.tests.find((command) => command.call_id === "setup")).toMatchObject({
      status: "failed",
      exit_code: 130,
    });

    expect(
      detail.validation?.checks.find((check) => check.name === "Playwright installation"),
    ).toMatchObject({ kind: "setup", outcome: "interrupted" });

    expect(detail.tests.filter((command) => command.exit_code === 0)).toHaveLength(3);
    expect(await readFile(join(upstream, "source.txt"), "utf8")).toBe("base\n");
    const saved = engine.followUp(task.id, "Use the existing helper later", undefined, true);
    expect(saved.disposition).toBe("draft");
    await engine.retry(task.id, 4);
    await waitForTask(engine, task.id, (status) => status === "awaiting_approval");
    await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false));
    expect(selected).toEqual([1, 2, 3]);

    expect(
      engine.db.all("SELECT status FROM task_messages WHERE id=?", saved.message.id)[0].status,
    ).toBe("draft");

    await expect(engine.approveStage(task.id)).rejects.toThrow("saved instructions");

    engine.db.saveTask({
      ...engine.db.task(task.id),
      status: "awaiting_approval",
      approval_gate: "implementation",
      stage: 5,
    });

    await expect(engine.approveStage(task.id)).rejects.toThrow("saved instructions");

    engine.db.saveTask({
      ...engine.db.task(task.id),
      status: "verification_blocked",
      approval_gate: undefined,
      stage: 4,
    });

    await engine.close();
    engine = await createFixtureEngine(root, providers);

    const reopened = (await new Rpc(engine).call("task.detail", {
      id: task.id,
    })) as Detail;

    expect(reopened.validation).toMatchObject({
      outcome: "blocked",
      canReview: false,
    });

    expect(reopened.messages[0]).toMatchObject({
      id: saved.message.id,
      status: "draft",
    });

    expect(reopened.runs).toHaveLength(3);
    expect(selected).toEqual([1, 2, 3]);

    await engine.approveStage(task.id, {
      disposition: "keep_saved",
      message_ids: [saved.message.id],
    });

    await waitForTask(
      engine,
      task.id,
      (status) => status === "reviewed_with_gaps" || status === "failed",
    );

    await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false));

    expect(engine.db.task(task.id)).toMatchObject({
      stage: 6,
      status: "reviewed_with_gaps",
      error: null,
    });

    expect(engine.db.task(task.id).approval_gate).toBeUndefined();
    expect(selected).toEqual([1, 2, 3, 5]);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

it("retains an actual failed table assertion as failed even when the provider claims success and setup is also interrupted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-validation-assertion-"));

  const engine = await createFixtureEngine(
    join(dir, "data"),
    () => new ValidationBlockerProvider(true),
  );

  try {
    const { repo } = await fixtureRepository(engine, dir);

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

    const task = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/5"),
      "Multiplication table assertion",
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

    const detail = (await new Rpc(engine).call("task.detail", {
      id: task.id,
    })) as Detail;

    expect(detail.task, detail.task.error || "Task outcome").toMatchObject({
      status: "awaiting_approval",
      stage: 5,
      approval_gate: "implementation",
    });

    expect(detail.validation).toMatchObject({
      outcome: "failed",
      canReview: false,
    });

    expect(
      detail.validation?.checks.find((check) => check.name === "Generated table"),
    ).toMatchObject({ outcome: "failed", reportedOutcome: "passed" });

    expect(detail.tests.find((command) => command.call_id === "table")?.stdout).toContain(
      "AssertionError",
    );

    expect(detail.runs).toHaveLength(3);
    await engine.approveStage(task.id);
    await waitForTask(engine, task.id, (status) => status === "reviewed_with_gaps");
    await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false));
    expect(engine.db.task(task.id).final_review_verdict).toBe("changes_requested");
    expect(engine.db.task(task.id).approval_gate).toBeUndefined();
    await expect(new Rpc(engine).call("task.complete", { id: task.id })).rejects.toThrow();
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
