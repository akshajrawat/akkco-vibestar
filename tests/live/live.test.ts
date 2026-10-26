import { it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseIssue, defaultSettings } from "../../backend/domain";
import { createFixtureEngine, fixtureRepository } from "../helpers/fixtures";
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
      const t = engine.enqueue(
        repo,
        parseIssue("https://github.com/fixture/fixture/issues/1"),
        "source.txt",
        "Change the single line in source.txt from base to vibestar verified. Do not change any other file. Use python3 to assert the exact file contents after implementation. Do not add test files.",
        {
          title: "Verify real local agent orchestration",
          body: "Change source.txt to contain exactly vibestar verified followed by a newline.",
          comments: [],
          labels: [],
          state: "OPEN",
          url: "https://github.com/fixture/fixture/issues/1",
        },
      );
      await new Promise<void>((resolve, reject) => {
        let approving = false;
        const poll = setInterval(() => void check(), 250);
        const timer = setTimeout(() => {
          clearInterval(poll);
          engine.off("event", check);
          reject(new Error("Real pipeline exceeded 25 minutes"));
        }, 1500000);
        const check = async () => {
          const task = engine.db.task(t.id);
          // This opt-in harness explicitly simulates the user's stage approvals.
          if (task.status === "awaiting_approval" && !engine.isActive(t.id) && !approving) {
            approving = true;
            try {
              await engine.approveStage(t.id);
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
          if (["ready_for_review", "failed", "interrupted", "cancelled"].includes(task.status)) {
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
      expect(task.status, task.error || "").toBe("ready_for_review");
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
