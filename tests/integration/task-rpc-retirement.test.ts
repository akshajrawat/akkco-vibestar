import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { Rpc } from "../../backend/rpc";
import { builtInProfiles } from "../../backend/flows/templates";
import { createFixtureEngine } from "../helpers/fixtures";

it("rejects retired task execution endpoints without mutating task history or starting providers", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibestar-retired-rpc-"));
  let invocations = 0;

  const engine = await createFixtureEngine(root, () => {
    invocations++;
    throw new Error("Retired endpoints must not discover or invoke providers");
  });

  const rpc = new Rpc(engine);
  try {
    const task = engine.createGeneralTask({
      request_id: randomUUID(),
      goal: "Use explicit flow authority",
      profile_id: builtInProfiles.implementer,
    });

    const original = engine.db.detail(task.id);
    for (const method of [
      "task.create",
      "task.startWorkflow",
      "task.chat",
      "task.retry",
      "task.approve",
      "task.acceptDraft",
      "task.followup",
      "task.complete",
      "task.message.retry",
      "task.message.send",
      "task.configure",
      "task.configureStage",
      "task.verification.recheck",
      "task.verification.policy",
      "task.verification.run",
      "task.verification.fix",
      "task.verification.reviewPreview",
      "task.verification.continueReview",
    ])
      await expect(
        rpc.call(method, {
          id: task.id,
          request_id: randomUUID(),
          content: "Do not execute legacy work",
          confirmed: true,
        }),
      ).rejects.toMatchObject({ kind: "invalid_method" });
    expect(engine.db.detail(task.id)).toEqual(original);
    expect(engine.db.all("SELECT id FROM flow_runs")).toEqual([]);
    expect(engine.db.all("SELECT id FROM agent_runs")).toEqual([]);
    expect(invocations).toBe(0);
  } finally {
    await rpc.close();
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
});
