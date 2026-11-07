import { it, expect } from "vitest";

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { defaultSettings } from "../../backend/domain";
import { randomUUID } from "node:crypto";
import { builtInProfiles } from "../../backend/flows/templates";
import { createFixtureEngine, fixtureRepository, startFixtureFlow } from "../helpers/fixtures";
import { AntigravityProvider } from "../../backend/execution/providers/antigravity";

it.skipIf(process.env.VIBESTAR_LIVE_TEST !== "1")(
  "executes the entire pipeline with REAL authenticated Antigravity and Codex CLIs",
  async () => {
    const dir = await mkdtemp(join(homedir(), "tmp/vibestar-live-"));
    const engine = await createFixtureEngine(join(dir, "ade"));
    try {
      const detection = await new AntigravityProvider().detect(dir);

      const model =
        process.env.VIBESTAR_AG_MODEL ||
        detection.models.find((m) => m.id.endsWith("-low"))?.id ||
        detection.models[0]?.id ||
        "";

      expect(model).toBeTruthy();

      engine.db.saveSettings({
        ...defaultSettings,
        concurrency: 2,
        antigravity: { model, effort: "low", timeout_secs: 600 },
        codex_plan: {
          model: process.env.VIBESTAR_CODEX_MODEL || "",
          effort: "low",
          timeout_secs: 600,
        },
        codex_implementation: {
          model: process.env.VIBESTAR_CODEX_MODEL || "",
          effort: "low",
          timeout_secs: 600,
        },
      });

      const { repo } = await fixtureRepository(engine, dir);

      for (const [role, id] of Object.entries(builtInProfiles)) {
        const profile = engine.flows.profile(id);

        engine.flows.saveProfile(
          {
            ...profile,
            revision: profile.revision + 1,
            execution: {
              ...profile.execution,
              provider: role === "planner" || role === "reviewer" ? "antigravity" : "codex",
              model:
                role === "planner" || role === "reviewer"
                  ? model
                  : process.env.VIBESTAR_CODEX_MODEL || "",
              effort: "low",
              timeout_secs: 600,
            },
          },
          profile.revision,
        );
      }

      const t = engine.createGeneralTask({
        request_id: randomUUID(),
        goal: "Change the single line in source.txt from base to vibestar verified followed by a newline. Do not change any other file. Use python3 to assert the exact contents. Do not add test files.",
        repository_id: repo.id,
        profile_id: builtInProfiles.implementer,
        template: "full",
      });

      const run = startFixtureFlow(engine, t);

      await new Promise<void>((resolve, reject) => {
        let approving = false;
        const poll = setInterval(() => void check(), 250);

        const timer = setTimeout(() => {
          clearInterval(poll);
          engine.off("event", check);
          reject(new Error("Real pipeline exceeded 25 minutes"));
        }, 1500000);

        const check = async () => {
          const state = engine.flowRuns.run(run.id);
          // This opt-in harness explicitly simulates decisions against captured node inputs.
          if (state.status === "waiting" && !engine.isActive(t.id) && !approving) {
            approving = true;
            try {
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
            } catch (error) {
              clearInterval(poll);
              clearTimeout(timer);
              engine.off("event", check);
              reject(error);
            } finally {
              approving = false;
            }

            return;
          }

          if (["completed", "failed", "interrupted", "cancelled"].includes(state.status)) {
            clearInterval(poll);
            clearTimeout(timer);
            engine.off("event", check);
            resolve();
          }
        };

        engine.on("event", check);
        check();
      });

      const task = engine.db.task(t.id);

      await writeFile(
        join(dir, "verification.json"),
        JSON.stringify(engine.db.detail(t.id), null, 2),
      );

      console.log(`Real-provider evidence: ${dir}`);

      expect(engine.flowRuns.run(run.id).status, engine.flowRuns.run(run.id).error || "").toBe(
        "completed",
      );

      expect(await readFile(join(task.worktree_path, "source.txt"), "utf8")).toBe(
        "vibestar verified\n",
      );

      const diff = await engine.git.diff(task);
      expect(diff.files.map((f) => f.path)).toEqual(["source.txt"]);
      expect(engine.db.detail(t.id).runs).toHaveLength(4);
    } finally {
      await engine.close();
    }
  },
  1600000,
);
