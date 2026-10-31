import { it, expect, vi } from "vitest";

import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Engine } from "../../backend/execution/engine";
import { defaultSettings, parseIssue } from "../../backend/domain";
import { StreamedPlan } from "../../backend/execution/agents/streamed-plan";
import { AntigravityProvider } from "../../backend/execution/providers/antigravity";
import { Rpc } from "../../backend/rpc";
import {
  createFixtureEngine,
  fixtureRepository,
  FixtureProvider,
  waitForTask,
  plan1,
} from "../helpers/fixtures";
import type { AgentRunRequest } from "../../backend/execution/providers/contracts";

const idle = async (engine: Engine, id: string) =>
  vi.waitFor(() => expect(engine.isActive(id)).toBe(false), { timeout: 10000 });

const settings = {
  ...defaultSettings,
  antigravity: { model: "next-model", effort: "low", timeout_secs: 30 },
  codex_plan: { model: "next-model", effort: "low", timeout_secs: 30 },
  codex_implementation: {
    model: "next-model",
    effort: "low",
    timeout_secs: 30,
  },
};

it("persists each approval without starting the next provider, preserves isolation and binds final approval to the reviewed source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-gates-"));
  const root = join(dir, "data");
  const selected: { stage: number; provider?: string }[] = [];

  const provider = (stage: number, name?: string) => {
    selected.push({ stage, provider: name });
    return new FixtureProvider();
  };

  let engine = await createFixtureEngine(root, provider);
  try {
    const { repo, upstream } = await fixtureRepository(engine, dir);

    const task = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/1"),
      "Task A",
      "",
      {
        title: "Issue",
        body: "Complete requirements",
        comments: [{ body: "All comments" }],
        linkedPullRequests: [{ title: "Related PR" }],
      },
      "partial",
      {
        ...settings,
        antigravity_review: {
          model: "next-model",
          effort: "high",
          timeout_secs: 40,
        },
      },
    );

    const gate = async (name: string) => {
      await waitForTask(engine, task.id, (s) => s === "awaiting_approval" || s === "failed");
      await idle(engine, task.id);

      expect(engine.db.task(task.id)).toMatchObject({
        status: "awaiting_approval",
        approval_gate: name,
      });
    };

    await gate("antigravity_plan");
    expect(selected).toEqual([{ stage: 1, provider: "antigravity" }]);
    expect(engine.db.artifact(task.id, 1).summary).toBe("Fixture plan");

    expect(engine.db.detail(task.id).runs[0].prompt).toContain(
      "Read it carefully, search recursively through any links or files you want to for that repository and create a detailed plan to solve this issue",
    );

    await expect(engine.retry(task.id)).rejects.toThrow("approve");
    await expect(engine.retry(task.id, 2)).rejects.toThrow("Approve");
    await engine.close();
    engine = await createFixtureEngine(root, provider);
    expect(engine.db.task(task.id).approval_gate).toBe("antigravity_plan");
    expect(selected).toHaveLength(1);
    await engine.approveStage(task.id);
    await gate("codex_plan");
    expect(selected.map((r) => r.stage)).toEqual([1, 2]);

    expect(engine.db.detail(task.id).runs.at(-1)?.prompt).toContain(
      "Do not edit files or run tests",
    );

    expect(engine.db.detail(task.id).runs.at(-1)?.prompt).toContain(
      "exact applicable test, type, lint, formatting",
    );

    expect(await readFile(join(engine.db.task(task.id).worktree_path, "source.txt"), "utf8")).toBe(
      "base\n",
    );

    // Feedback at a planning gate refines that same stage before approval.
    engine.followUp(task.id, "Add regression coverage");
    await gate("codex_plan");
    expect(selected.map((r) => r.stage)).toEqual([1, 2, 2]);
    expect(engine.db.detail(task.id).runs.at(-1)?.prompt).toContain("Add regression coverage");
    await engine.approveStage(task.id);
    await gate("implementation");
    expect(selected.map((r) => r.stage)).toEqual([1, 2, 2, 3]);

    expect(engine.db.detail(task.id).runs.at(-1)?.prompt).toBe(
      [JSON.stringify(engine.db.artifact(task.id, 2), null, 2), "Add regression coverage"].join(
        "\n\n",
      ),
    );

    expect(await readFile(join(upstream, "source.txt"), "utf8")).toBe("base\n");
    await engine.approveStage(task.id);
    await waitForTask(engine, task.id, (status) => ["ready_for_review", "failed"].includes(status));
    await idle(engine, task.id);
    expect(engine.db.task(task.id).approval_gate).toBeUndefined();
    expect(selected.at(-1)).toEqual({ stage: 5, provider: "antigravity" });

    expect(engine.db.detail(task.id).runs.at(-1)?.prompt).toContain(
      "do not fix them or start another implementation run",
    );

    expect(engine.db.detail(task.id).usage.at(-1)).toMatchObject({
      purpose: "Review",
      status: "completed",
      effort: "high",
    });

    const prompts = engine.db.detail(task.id).runs;
    expect(prompts[0].prompt).toContain("This is the issue : Issue");
    expect(prompts[0].prompt).toContain("All comments");
    expect(prompts[0].prompt).not.toContain("TASK CONTEXT:");
    expect(prompts.at(-1)?.prompt).toContain("numbered points");

    const worktree = engine.db.task(task.id).worktree_path;
    await writeFile(join(worktree, "source.txt"), "modified after review\n");

    await expect(new Rpc(engine).call("task.complete", { id: task.id })).rejects.toThrow(
      "worktree changed",
    );

    await writeFile(join(worktree, "source.txt"), "A\n");
    await new Rpc(engine).call("task.complete", { id: task.id });
    expect(engine.db.task(task.id).status).toBe("completed");
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

it("reconstructs a complete streamed plan with provider metadata, but rejects incomplete or invalid plans", () => {
  const stream = new StreamedPlan(1);

  const text = JSON.stringify({
    ...plan1,
    toolAction: "Complete planning",
    toolSummary: "Done",
  });

  expect(stream.observe({ call_id: 143, text_delta: text.slice(0, 80) })).toBeUndefined();
  expect(stream.observe({ call_id: 143, text_delta: text.slice(80) })).toEqual(plan1);

  expect(
    stream.observe({
      call_id: 144,
      text: JSON.stringify({ ...plan1, arbitrary: "field" }),
    }),
  ).toBeUndefined();

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

class DraftProvider extends FixtureProvider {
  normalize = new AntigravityProvider().normalize;

  result = new AntigravityProvider().result;

  invocation = () => ({
    program: process.execPath,
    args: [
      "-e",
      `console.log(JSON.stringify({event:'step_update',step_update:{step_index:143,step_type:'agent_response',state:'DONE',text_delta:${JSON.stringify(JSON.stringify({ ...plan1, toolAction: "Complete planning" }))}}}));setInterval(()=>{},1000)`,
    ],
    input: "",
  });
}

it("shows and explicitly recovers a streamed draft without another AI call, preserving the cancelled outcome and usage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-draft-"));
  const engine = await createFixtureEngine(join(dir, "data"), () => new DraftProvider());
  try {
    const { repo } = await fixtureRepository(engine, dir);

    const task = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/2"),
      "Task A",
      "",
      {},
      "partial",
      settings,
    );

    await vi.waitFor(
      () =>
        expect(
          engine.db.detail(task.id).artifacts.some((a) => String(a.kind).startsWith("draft:")),
        ).toBe(true),
      { timeout: 10000 },
    );

    expect(() => engine.db.artifact(task.id, 1)).toThrow("No successful");
    const run = engine.db.detail(task.id).runs.at(-1)!;
    await engine.acceptDraft(task.id, String(run.id));

    expect(engine.db.task(task.id)).toMatchObject({
      status: "awaiting_approval",
      approval_gate: "antigravity_plan",
    });

    expect(engine.db.artifact(task.id, 1)).toEqual(plan1);
    expect(engine.db.detail(task.id).runs).toHaveLength(1);
    expect(engine.db.detail(task.id).runs[0].status).toBe("cancelled");
    expect(engine.db.detail(task.id).usage[0].status).toBe("cancelled");
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);

it("preserves historical cancelled drafts but requires fresh planning when integrity evidence cannot be compared", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-historical-draft-"));
  const engine = await createFixtureEngine(join(dir, "data"), () => new DraftProvider());
  try {
    const { repo } = await fixtureRepository(engine, dir);

    const task = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/2"),
      "Task A",
      "",
      {},
      "partial",
      settings,
    );

    await vi.waitFor(
      () =>
        expect(
          engine.db.detail(task.id).artifacts.some((a) => String(a.kind).startsWith("draft:")),
        ).toBe(true),
      { timeout: 10000 },
    );

    engine.cancel(task.id);
    await idle(engine, task.id);
    engine.db.run("DELETE FROM task_artifacts WHERE task_id=?", task.id);
    const run = engine.db.detail(task.id).runs.at(-1)!;

    await writeFile(
      join(engine.db.task(task.id).worktree_path, "source.txt"),
      "changed after planning\n",
    );

    await expect(engine.acceptDraft(task.id, String(run.id))).rejects.toThrow(
      "no comparable current integrity fingerprint",
    );

    await writeFile(join(engine.db.task(task.id).worktree_path, "source.txt"), "base\n");

    await expect(engine.acceptDraft(task.id, String(run.id))).rejects.toThrow(
      "no comparable current integrity fingerprint",
    );

    expect(() => engine.db.artifact(task.id, 1)).toThrow("No successful saved result");
    expect(engine.db.task(task.id).approval_gate).toBeUndefined();
    expect(engine.db.detail(task.id).events.some((event) => event.kind === "message")).toBe(true);
    expect(engine.db.detail(task.id).runs).toHaveLength(1);
    expect(engine.db.detail(task.id).usage[0].status).toBe("cancelled");
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);

class EditingReviewProvider extends FixtureProvider {
  invocation = (r: AgentRunRequest) =>
    r.stage === 5
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

it("prevents the final reviewer from editing the implementation and retains its failed run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-review-isolation-"));
  const engine = await createFixtureEngine(join(dir, "data"), () => new EditingReviewProvider());
  try {
    const { repo } = await fixtureRepository(engine, dir);

    const task = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/3"),
      "Task A",
      "",
      {},
      "partial",
      settings,
    );

    for (const gate of ["antigravity_plan", "codex_plan", "implementation"]) {
      await waitForTask(engine, task.id, (s) => s === "awaiting_approval");
      await idle(engine, task.id);
      expect(engine.db.task(task.id).approval_gate).toBe(gate);
      await engine.approveStage(task.id);
    }

    await waitForTask(engine, task.id, (s) => s === "failed");
    await idle(engine, task.id);

    expect(await readFile(join(engine.db.task(task.id).worktree_path, "source.txt"), "utf8")).toBe(
      "A\n",
    );

    expect(engine.db.detail(task.id).usage.at(-1)).toMatchObject({
      purpose: "Review",
      status: "failed",
    });
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);
