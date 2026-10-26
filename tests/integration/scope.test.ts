import { ActionSchema } from "../../backend/scheduled/action";
import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Scheduler } from "../../backend/scheduled/scheduler";
import { buildPrompt } from "../../backend/execution/agents/prompt";
import { parseIssue, defaultSettings } from "../../backend/domain";
import {
  createFixtureEngine,
  fixtureRepository,
  FixtureProvider,
  finishFixtureTask as waitForTask,
} from "../helpers/fixtures";

it("preserves whole vs partial scope through the user-approved pipeline and next-run provider configuration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-scope-"));
  const order: number[] = [];

  const engine = await createFixtureEngine(join(dir, "ade"), (stage) => {
    order.push(stage);
    return new FixtureProvider();
  });

  try {
    const { repo } = await fixtureRepository(engine, dir);
    const ref = parseIssue("https://github.com/fixture/fixture/issues/26831");

    const whole = engine.enqueue(
      repo,
      ref,
      "ignored",
      "Exclude unrelated docs",
      { title: "Issue", body: "All checklist items" },
      "whole_issue",
    );

    const partial = engine.enqueue(
      repo,
      ref,
      "check-improvements-tab.spec.ts",
      "",
      { title: "Issue", body: "Many checklist items" },
      "partial",
    );

    await Promise.all(
      [whole, partial].map((t) =>
        waitForTask(engine, t.id, (s) => s === "ready_for_review" || s === "failed"),
      ),
    );

    expect(engine.db.task(whole.id)).toMatchObject({
      status: "ready_for_review",
      scope_mode: "whole_issue",
      verification_policy: "repository",
      claimed_scope: "",
    });

    expect(engine.db.task(partial.id)).toMatchObject({
      status: "ready_for_review",
      scope_mode: "partial",
      claimed_scope: "check-improvements-tab.spec.ts",
    });

    expect(order.filter((s) => s === 1)).toHaveLength(2);
    for (const t of [whole, partial]) {
      const runs = engine.db.detail(t.id).runs;
      expect(runs.map((r) => r.stage)).toEqual([1, 2, 3, 5]);
      for (const run of runs)
        expect(run.prompt).toContain(
          t.scope_mode === "whole_issue"
            ? "All requirements of this issue are in scope unless explicitly excluded by notes."
            : "ONLY the claimed scope belongs to this task. Other issue requirements are explicit non-goals.",
        );
      for (const run of runs)
        expect(run.prompt).toContain("Do not require duplicate manual browser launches");
    }

    expect(buildPrompt(engine.db, { ...engine.db.task(whole.id), stage: 1 })).not.toContain(
      "ONLY the claimed scope",
    );

    const previous = engine.db.detail(partial.id).runs;

    await engine.followUp(partial.id, "Continue in the same worktree", {
      provider: "codex",
      config: {
        ...defaultSettings.codex_implementation,
        model: "next-model",
        effort: "low",
      },
    });

    await waitForTask(engine, partial.id, (s) => s === "ready_for_review" || s === "failed");
    expect(engine.db.detail(partial.id).runs.slice(0, 4)).toEqual(previous);

    expect(
      engine.db
        .detail(partial.id)
        .runs.filter((r) => r.stage === 3)
        .at(-1),
    ).toMatchObject({
      model: "next-model",
      effort: "low",
    });

    expect(engine.db.task(partial.id).worktree_path).not.toBe(
      engine.db.task(whole.id).worktree_path,
    );

    expect(engine.db.detail(partial.id).activity).not.toEqual([]);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);

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
    ).toEqual([{ stage: 1, status: "completed", purpose: "PR Review Analysis" }]);
  } finally {
    await scheduler.close();
    await engine.close();
    await rm(dir, { recursive: true });
  }
});
