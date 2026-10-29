import { expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultSettings, parseIssue } from "../../backend/domain";
import {
  createFixtureEngine,
  fixtureRepository,
  FixtureProvider,
  finishFixtureTask,
} from "../helpers/fixtures";

it.each(["codex", "antigravity"] as const)(
  "runs every role with %s while keeping planning and review read-only",
  async (name) => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-pipeline-provider-"));
    const selected: { stage: number; provider?: string }[] = [];

    const engine = await createFixtureEngine(join(dir, "data"), (stage, provider) => {
      selected.push({ stage, provider });
      const fixture = new FixtureProvider();
      return {
        ...fixture,
        name: provider || name,
        invocation: (request) => {
          const invocation = fixture.invocation(request);
          if (request.stage !== 3) {
            const probe =
              "try{require('node:fs').writeFileSync('source.txt','forbidden');throw Error('Read-only stage could edit source')}catch(e){if(!['EROFS','EACCES'].includes(e.code))throw e;}";

            invocation.args[1] = probe + invocation.args[1];
          }

          return invocation;
        },
      };
    });

    try {
      const { repo } = await fixtureRepository(engine, dir);
      const config = { provider: name, model: "next-model", effort: "low", timeout_secs: 30 };

      const task = engine.enqueue(
        repo,
        parseIssue("https://github.com/fixture/fixture/issues/1"),
        "Task A",
        "",
        {},
        "partial",
        {
          ...defaultSettings,
          antigravity: config,
          codex_plan: config,
          codex_implementation: config,
          antigravity_review: config,
        },
      );

      await finishFixtureTask(engine, task.id, (status) =>
        ["ready_for_review", "failed"].includes(status),
      );

      expect(engine.db.task(task.id), engine.db.task(task.id).error || "review").toMatchObject({
        status: "ready_for_review",
      });

      expect(selected).toEqual([1, 2, 3, 5].map((stage) => ({ stage, provider: name })));

      expect(engine.db.detail(task.id).runs.map((run) => run.provider)).toEqual([
        name,
        name,
        name,
        name,
      ]);

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
