import { expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultSettings, parseIssue } from "../../backend/domain";
import { Rpc } from "../../backend/rpc";
import {
  createFixtureEngine,
  fixtureRepository,
  FixtureProvider,
  waitForTask,
} from "../helpers/fixtures";

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

it("keeps saved instructions independent of retry, feedback and approval across restart, with exact-once explicit delivery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-instructions-"));
  const root = join(dir, "data");
  let engine = await createFixtureEngine(root, () => new FixtureProvider());
  try {
    const { repo } = await fixtureRepository(engine, dir);

    const task = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/1"),
      "Instructions",
      "",
      {},
      "partial",
      settings,
    );

    const gate = async (name: string) => {
      await waitForTask(engine, task.id, (status) =>
        ["awaiting_approval", "failed"].includes(status),
      );

      await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false));
      expect(engine.db.task(task.id).approval_gate).toBe(name);
    };

    await gate("antigravity_plan");
    const requestId = randomUUID();

    const savedConfiguration = {
      provider: "antigravity" as const,
      config: { ...settings.antigravity, effort: "high" },
    };

    const saved = engine.followUp(
      task.id,
      "SAVED_ONLY_HELPER",
      savedConfiguration,
      true,
      requestId,
    );

    expect(
      engine.followUp(task.id, "SAVED_ONLY_HELPER", savedConfiguration, true, requestId).message.id,
    ).toBe(saved.message.id);

    expect(() => engine.followUp(task.id, "Changed request", undefined, true, requestId)).toThrow(
      "different instruction",
    );

    expect(engine.db.detail(task.id).messages).toHaveLength(1);
    expect(engine.db.detail(task.id).runs).toHaveLength(1);
    await engine.close();
    engine = await createFixtureEngine(root, () => new FixtureProvider());
    await engine.retry(task.id, 1);
    await gate("antigravity_plan");
    expect(engine.db.detail(task.id).runs.at(-1)?.prompt).not.toContain("SAVED_ONLY_HELPER");
    const feedbackRequest = randomUUID();

    const saveFailure = vi.spyOn(engine.db, "saveTask").mockImplementationOnce(() => {
      throw new Error("Persistence interrupted");
    });

    expect(() =>
      engine.followUp(task.id, "FEEDBACK_NOW", undefined, false, feedbackRequest),
    ).toThrow("Persistence interrupted");

    saveFailure.mockRestore();

    expect(
      engine.db.detail(task.id).messages.some((message) => message.content === "FEEDBACK_NOW"),
    ).toBe(false);

    expect(engine.db.artifact(task.id, 1).summary).toBe("Fixture plan");
    expect(engine.db.task(task.id).approval_gate).toBe("antigravity_plan");
    engine.followUp(task.id, "FEEDBACK_NOW", undefined, false, feedbackRequest);
    await gate("antigravity_plan");
    expect(engine.db.detail(task.id).runs.at(-1)?.prompt).toContain("FEEDBACK_NOW");
    expect(engine.db.detail(task.id).runs.at(-1)?.prompt).not.toContain("SAVED_ONLY_HELPER");
    await expect(engine.approveStage(task.id)).rejects.toThrow("choose");

    await expect(
      engine.approveStage(task.id, {
        disposition: "keep_saved",
        message_ids: [],
      }),
    ).rejects.toThrow("choose");

    await expect(
      engine.approveStage(
        task.id,
        { disposition: "keep_saved", message_ids: [saved.message.id] },
        randomUUID(),
      ),
    ).rejects.toThrow("artifact changed");

    await engine.approveStage(task.id, {
      disposition: "keep_saved",
      message_ids: [saved.message.id],
    });

    await gate("codex_plan");
    expect(engine.db.detail(task.id).runs.at(-1)?.prompt).not.toContain("SAVED_ONLY_HELPER");

    expect(
      engine.db.detail(task.id).messages.find((message) => message.id === saved.message.id)?.status,
    ).toBe("draft");

    await engine.approveStage(task.id, {
      disposition: "include_next_stage",
      message_ids: [saved.message.id],
    });

    await gate("implementation");
    expect(engine.db.detail(task.id).runs.at(-1)?.effort).toBe("low");

    const delivered = engine.db
      .detail(task.id)
      .messages.find((message) => message.id === saved.message.id)!;

    expect(delivered).toMatchObject({
      status: "delivered",
      run_id: engine.db.detail(task.id).runs.at(-1)?.id,
    });

    expect(engine.db.detail(task.id).runs.at(-1)?.prompt).toContain("SAVED_ONLY_HELPER");
    expect(engine.db.detail(task.id).runs.at(-1)?.provider).toBe("codex");

    const second = engine.followUp(
      task.id,
      "SEND_THIS_EXACT_MESSAGE",
      undefined,
      true,
      randomUUID(),
    );

    const third = engine.followUp(task.id, "LEAVE_THIS_SAVED", undefined, true, randomUUID());

    engine.sendSavedMessage(task.id, second.message.id, {
      provider: "codex",
      config: settings.codex_implementation,
    });

    engine.sendSavedMessage(task.id, second.message.id);
    await gate("implementation");

    expect(
      engine.db
        .detail(task.id)
        .messages.filter((message) => message.content === "SEND_THIS_EXACT_MESSAGE"),
    ).toHaveLength(1);

    expect(engine.db.detail(task.id).runs.at(-1)?.prompt).toContain("SEND_THIS_EXACT_MESSAGE");
    expect(engine.db.detail(task.id).runs.at(-1)?.prompt).not.toContain("LEAVE_THIS_SAVED");
    const count = engine.db.detail(task.id).runs.length;
    engine.followUp(task.id, "SAVED_ONLY_HELPER", savedConfiguration, true, requestId);
    expect(engine.db.detail(task.id).runs).toHaveLength(count);

    await engine.approveStage(task.id, {
      disposition: "keep_saved",
      message_ids: [third.message.id],
    });

    await gate("final_review");

    await expect(
      engine.approveStage(task.id, {
        disposition: "include_next_stage",
        message_ids: [third.message.id],
      }),
    ).rejects.toThrow("starts no agent");

    await engine.approveStage(task.id, {
      disposition: "keep_saved",
      message_ids: [third.message.id],
    });

    expect(engine.db.task(task.id).status).toBe("ready_for_review");
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

it("edits only unstarted future stage settings and keeps actual run history and fixed stage providers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-future-models-"));
  const root = join(dir, "data");
  const selected: { stage: number; provider?: string }[] = [];

  const provider = (stage: number, name?: string) => {
    selected.push({ stage, provider: name });
    return new FixtureProvider();
  };

  let engine = await createFixtureEngine(root, provider);
  try {
    const { repo } = await fixtureRepository(engine, dir);

    const task = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/1"),
      "Future models",
      "",
      {},
      "partial",
      settings,
    );

    const gate = async (name: string) => {
      await waitForTask(engine, task.id, (status) =>
        ["awaiting_approval", "failed"].includes(status),
      );

      await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false));
      expect(engine.db.task(task.id).approval_gate).toBe(name);
    };

    await gate("antigravity_plan");
    const original = engine.db.detail(task.id).runs[0];
    const rpc = new Rpc(engine);
    const config = { ...settings.antigravity, effort: "high" };

    await expect(
      rpc.call("task.configureStage", { id: task.id, stage: 1, config }),
    ).rejects.toThrow("never started");

    await expect(
      rpc.call("task.configureStage", { id: task.id, stage: 4, config }),
    ).rejects.toThrow();

    await expect(
      rpc.call("task.configureStage", {
        id: task.id,
        stage: 2,
        config,
        provider: "antigravity",
      }),
    ).rejects.toThrow();

    await rpc.call("task.configureStage", { id: task.id, stage: 2, config });
    await rpc.call("task.configureStage", { id: task.id, stage: 5, config });
    expect(engine.db.detail(task.id).runs[0]).toEqual(original);
    expect(engine.db.task(task.id).execution_settings).toEqual(settings);
    await engine.close();
    engine = await createFixtureEngine(root, provider);

    expect(engine.db.task(task.id).stage_settings).toEqual({
      2: config,
      5: config,
    });

    await engine.approveStage(task.id);
    await gate("codex_plan");

    expect(engine.db.detail(task.id).runs.at(-1)).toMatchObject({
      stage: 2,
      effort: "high",
    });

    await expect(
      new Rpc(engine).call("task.configureStage", {
        id: task.id,
        stage: 2,
        config,
      }),
    ).rejects.toThrow("never started");

    await engine.approveStage(task.id);
    await gate("implementation");

    expect(engine.db.detail(task.id).runs.at(-1)).toMatchObject({
      stage: 3,
      effort: "low",
    });

    await engine.approveStage(task.id);
    await gate("final_review");

    expect(engine.db.detail(task.id).runs.at(-1)).toMatchObject({
      stage: 5,
      effort: "high",
    });

    expect(selected.at(-1)).toEqual({ stage: 5, provider: "antigravity" });
    expect(engine.db.detail(task.id).runs[0]).toEqual(original);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
