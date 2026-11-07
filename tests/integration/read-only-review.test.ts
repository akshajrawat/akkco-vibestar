import { it, expect } from "vitest";

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AntigravityProvider } from "../../backend/execution/providers/antigravity";
import {
  createFixtureEngine,
  fixtureRepository,
  FixtureProvider,
  fixtureFlowTask,
  startFixtureFlow,
  waitForFixtureFlow,
  plan1,
} from "../helpers/fixtures";
import type { AgentRunRequest } from "../../backend/execution/providers/contracts";

it("keeps Antigravity output schema metadata separate from the canonical result", () => {
  const adapter = new AntigravityProvider();

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: { summary: { type: "string" } },
    required: ["summary"],
  };

  expect(adapter.outputSchema(schema)).toMatchObject({
    required: ["summary"],
    additionalProperties: false,
    properties: {
      toolAction: { type: "string" },
      toolSummary: { type: "string" },
      summary: { type: "string" },
    },
  });

  expect(schema.properties).not.toHaveProperty("toolAction");

  expect(
    new AntigravityProvider().parseStructuredOutput(
      { properties: {} },
      { ...plan1, toolAction: "Complete", toolSummary: "Done" },
    ),
  ).toEqual(plan1);
});

class EditingReviewProvider extends FixtureProvider {
  invocation = (r: AgentRunRequest) =>
    r.access === "read-only"
      ? {
          program: process.execPath,
          args: [
            "-e",
            "require('node:fs/promises').writeFile('source.txt','forbidden').catch(e=>{console.error(e.message);process.exitCode=1;})",
          ],
          input: "",
        }
      : new FixtureProvider().invocation(r);
}

it("prevents an explicit read-only reviewer from editing source and retains its failed run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-review-isolation-"));
  const engine = await createFixtureEngine(join(dir, "data"), () => new EditingReviewProvider());
  try {
    const { repo } = await fixtureRepository(engine, dir);

    const task = fixtureFlowTask(engine, repo, "Review source", {
      access: "read-only",
      output: "review",
    });

    await waitForFixtureFlow(engine, startFixtureFlow(engine, task), "failed");

    expect(await readFile(join(engine.db.task(task.id).worktree_path, "source.txt"), "utf8")).toBe(
      "base\n",
    );

    expect(engine.db.detail(task.id).usage.at(-1)).toMatchObject({
      purpose: "Fixture Viber",
      status: "failed",
    });
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);
