import { ActionSchema } from "../../backend/scheduled/action";
import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Scheduler } from "../../backend/scheduled/scheduler";
import { createFixtureEngine, FixtureProvider } from "../helpers/fixtures";

it("analyzes unlinked PR feedback in an isolated read-only workspace without cloning repositories or creating tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-pr-analysis-"));
  const engine = await createFixtureEngine(join(dir, "ade"), () => new FixtureProvider());
  const scheduler = new Scheduler(engine);
  try {
    const job = scheduler.add({
      url: "https://github.com/fixture/fixture/pull/7",
      task_id: null,
      interval_minutes: 60,
      verify_codex: true,
    });

    await scheduler.close();

    const result = await engine.utility.run({
      purpose: "PR Review Analysis",
      prompt: "Assess this reviewer question without editing any files.",
      schema: ActionSchema,
      context: { jobId: job.id, repository: "fixture/fixture" },
    });

    expect(result).toMatchObject({ manualActionRequired: true });
    expect(engine.db.tasks()).toEqual([]);
    expect(engine.db.repositories()).toEqual([]);

    expect(
      engine.db.all("SELECT stage,status,purpose FROM scheduled_agent_runs ORDER BY started_at"),
    ).toEqual([{ stage: 0, status: "completed", purpose: "PR Review Analysis" }]);
  } finally {
    await scheduler.close();
    await engine.close();
    await rm(dir, { recursive: true });
  }
});
