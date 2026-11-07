import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { builtInProfiles } from "../../backend/flows/templates";
import { resolveNodeInputs } from "../../backend/flows/context";
import { createFixtureEngine, fixtureRepository } from "../helpers/fixtures";

const root = process.env.VIBESTAR_SIDEBAR_DEMO_HOME;

it.skipIf(process.env.VIBESTAR_SIDEBAR_DEMO_SEED !== "1" || !root)(
  "seeds isolated sidebar demo tasks",
  async () => {
    const engine = await createFixtureEngine(root!);

    try {
      expect(engine.db.tasks()).toHaveLength(0);

      const fixtureDir = join(root!, "fixtures");
      await mkdir(fixtureDir, { recursive: true });
      const { repo } = await fixtureRepository(engine, fixtureDir);
      engine.db.saveRepository({ ...repo, owner: "demo", name: "vibestar-sidebar-demo" });

      const create = (goal: string) =>
        engine.createGeneralTask({
          request_id: randomUUID(),
          goal,
          profile_id: builtInProfiles.implementer,
          repository_id: repo.id,
        });

      const samples = [
        "feat: add compact keyboard navigation to the task queue",
        "fix: keep selected task visible while filtering search results",
        "refactor: simplify workspace ownership checks without changing behavior",
        "docs: document local repository setup for new contributors",
        "feat: preview long task titles cleanly in narrow sidebars",
        "test: cover task list grouping and keyboard focus states",
        "fix: restore task selection after returning from the workspace",
        "perf: avoid repeated sidebar metadata work during resize",
        "feat: improve approval flow status visibility in the work queue",
        "chore: align repository labels across workspace navigation",
      ];

      const tasks = samples.map(create);
      const [completed, failed, paused, running, waiting, queued] = tasks.slice(4);

      engine.db.saveTask({ ...completed, status: "completed", stage: 6 });

      const createRun = (task: (typeof tasks)[number]) =>
        engine.flowRuns.createRun({
          flow_id: task.flow_id!,
          task_id: task.id,
          revision: 1,
          request_id: randomUUID(),
          goal: task.goal!,
        });

      const failedRun = createRun(failed);
      engine.flowRuns.setRunStatus(failedRun.id, "queued", "failed", "Demo failure state");

      const pausedRun = createRun(paused);
      engine.flowRuns.setRunStatus(pausedRun.id, "queued", "paused");

      const runningRun = createRun(running);
      engine.flowRuns.setRunStatus(runningRun.id, "queued", "running");
      const node = engine.flowRuns.definition(runningRun.id).nodes[0];

      engine.flowRuns.beginAttempt(
        runningRun.id,
        node.id,
        resolveNodeInputs(engine.db, engine.flowRuns, runningRun.id, node.id),
        "sidebar-demo-workspace",
      );

      const waitingRun = createRun(waiting);
      engine.flowRuns.setRunStatus(waitingRun.id, "queued", "running");
      engine.flowRuns.setRunStatus(waitingRun.id, "running", "waiting");

      createRun(queued);

      expect(engine.db.tasks()).toHaveLength(10);
    } finally {
      await engine.close();
    }
  },
);
