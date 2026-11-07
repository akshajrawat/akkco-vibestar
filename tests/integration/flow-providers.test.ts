import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { builtInProfiles } from "../../backend/flows/templates";
import {
  createFixtureEngine,
  fixtureRepository,
  FixtureProvider,
  startFixtureFlow,
  waitForFixtureFlow,
} from "../helpers/fixtures";

it.each(["codex", "antigravity"] as const)(
  "runs the editable full template with %s and explicit read-only planning/review",
  async (name) => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-flow-provider-"));
    const selected: { stage: number; provider?: string; access: string }[] = [];

    const engine = await createFixtureEngine(join(dir, "data"), (_stage, provider) => {
      const fixture = new FixtureProvider();
      return {
        ...fixture,
        name: provider || name,
        invocation: (request) => {
          selected.push({ stage: request.stage, provider, access: request.access });
          const invocation = fixture.invocation(request);
          if (request.access === "read-only") {
            const probe =
              "try{require('node:fs').writeFileSync('source.txt','forbidden');throw Error('Read-only Viber could edit source')}catch(e){if(!['EROFS','EACCES'].includes(e.code))throw e;}";

            invocation.args[1] = probe + invocation.args[1];
          }

          return invocation;
        },
      };
    });

    try {
      const { repo } = await fixtureRepository(engine, dir);
      for (const id of Object.values(builtInProfiles)) {
        const profile = engine.flows.profile(id);

        engine.flows.saveProfile(
          {
            ...profile,
            revision: profile.revision + 1,
            execution: {
              ...profile.execution,
              provider: name,
              model: "next-model",
              effort: "low",
              timeout_secs: 30,
            },
          },
          profile.revision,
        );
      }

      const task = engine.createGeneralTask({
        request_id: randomUUID(),
        goal: "Task A",
        repository_id: repo.id,
        profile_id: builtInProfiles.implementer,
        template: "full",
      });

      const run = startFixtureFlow(engine, task);
      // This fixture explicitly simulates the user's four decisions against captured inputs.
      for (let gate = 0; gate < 4; gate++) {
        await waitForFixtureFlow(engine, run, "waiting");

        const attempt = engine.flowRuns
          .attempts(run.id)
          .filter((value) => value.status === "waiting")
          .at(-1)!;

        await engine.approveFlowNode({
          request_id: randomUUID(),
          attempt_id: attempt.id,
          configuration_hash: attempt.configuration_hash,
          inputs_hash: attempt.inputs_hash,
          workspace_fingerprint: attempt.workspace_fingerprint,
          decision: "accepted",
        });
      }

      await waitForFixtureFlow(engine, run);

      expect(selected).toEqual(
        ["read-only", "read-only", "workspace-write", "read-only"].map((access) => ({
          stage: 0,
          provider: name,
          access,
        })),
      );

      expect(engine.db.detail(task.id).runs.map((value) => value.provider)).toEqual([
        name,
        name,
        name,
        name,
      ]);

      expect(engine.flowRuns.attempts(run.id)).toHaveLength(8);
      expect(engine.db.task(task.id)).toMatchObject({ stage: 0, status: "not_started" });

      expect(
        await readFile(join(engine.db.task(task.id).worktree_path, "source.txt"), "utf8"),
      ).toBe("A\n");

      expect(await readFile(join(repo.path, "source.txt"), "utf8")).toBe("base\n");
    } finally {
      await engine.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
  30000,
);
