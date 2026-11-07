import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFixtureEngine,
  fixtureRepository,
  fixtureFlowTask,
  startFixtureFlow,
  waitForFixtureFlow,
} from "../helpers/fixtures";
import { ValidationBlockerProvider } from "./provider";

it.each([false, true])(
  "retains a real failed assertion despite a success report and interrupted setup (provider failure: %s)",
  async (failProvider) => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-flow-assertion-"));
    const fixture = new ValidationBlockerProvider(true);

    const engine = await createFixtureEngine(join(dir, "data"), () => ({
      ...fixture,
      invocation: (request) => {
        const invocation = fixture.invocation(request);
        if (failProvider)
          invocation.args[1] = invocation.args[1].replace(
            "emit({ type: 'turn.completed' });",
            "emit({ type: 'turn.completed' }); process.exitCode = 9;",
          );
        return invocation;
      },
    }));

    try {
      const { repo } = await fixtureRepository(engine, dir);
      const task = fixtureFlowTask(engine, repo, "Multiplication table assertion");
      const run = startFixtureFlow(engine, task);
      await waitForFixtureFlow(engine, run, failProvider ? "failed" : "completed");
      const attempt = engine.flowRuns.attempts(run.id)[0];
      expect(attempt.verification).toBe("failed");
      expect(attempt.status).toBe(failProvider ? "failed" : "completed");
      const detail = engine.db.detail(task.id);

      expect(detail.tests.find((value) => value.call_id === "table")).toMatchObject({
        status: "failed",
        exit_code: 1,
        stdout: expect.stringContaining("AssertionError"),
      });

      expect(detail.tests.find((value) => value.call_id === "setup")).toMatchObject({
        status: "failed",
        exit_code: 130,
      });

      if (!failProvider)
        expect(JSON.parse(attempt.output!).testsPassed).toContain("Generated table");
      expect(detail.runs).toHaveLength(1);
      expect(detail.task).toMatchObject({ status: "not_started", stage: 0 });
    } finally {
      await engine.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
  30000,
);
