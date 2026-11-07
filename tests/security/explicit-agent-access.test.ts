import { expect, it } from "vitest";
import { z } from "zod";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { AgentRunner } from "../../backend/execution/agents/agent-runner";
import type { AgentExecution } from "../../backend/execution/contracts";
import { AgentProfileSchema } from "../../backend/flows/contracts";
import { agentNodePrompt } from "../../backend/flows/run-contracts";
import {
  createFixtureEngine,
  fixtureRepository,
  FixtureProvider,
  prepareFixtureTask,
} from "../helpers/fixtures";

it("uses explicit access for stage-free runs, retains the execution snapshot and never advances the legacy pipeline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-explicit-access-"));
  const engine = await createFixtureEngine(join(dir, "data"));
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const task = await prepareFixtureTask(engine, repo, "explicit-access");
    engine.db.saveTask({ ...task, status: "not_started", stage: 1 });
    const fixture = new FixtureProvider();
    const requests: { stage: number; access: string }[] = [];

    const runner = new AgentRunner(engine.root, engine.db, engine.git, engine.publish, () => ({
      ...fixture,
      detect: async () => ({
        ...(await fixture.detect()),
        models: [{ id: "next-model", isDefault: true, supportedEfforts: ["low", "high"] }],
      }),
      invocation: (request) => {
        requests.push({ stage: request.stage, access: request.access });
        return {
          program: process.execPath,
          args: [
            "-e",
            `
            (async () => {
              const fs = require('node:fs/promises');
              let summary;
              try {
                await fs.writeFile('source.txt', 'Explicit solo edit\\n');
                summary = 'write allowed';
              } catch (error) {
                if (error.code !== 'EROFS') throw error;
                summary = 'write denied';
              }
              console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({summary})}}));
            })().catch(error => { console.error(error); process.exitCode = 1; });
          `,
          ],
        };
      },
    }));

    const configuration: AgentExecution = {
      provider: "codex",
      model: "",
      effort: "low",
      timeout_secs: 30,
      access: "read-only",
      output: "summary",
    };

    const run = (execution: AgentExecution) =>
      runner.runConfigured(engine.db.task(task.id), new AbortController().signal, execution, {
        purpose: "Explicit agent",
        prompt: "Try an edit in the assigned workspace.",
      });

    expect(await run(configuration)).toEqual({ summary: "write denied" });

    expect(await readFile(join(task.worktree_path, "source.txt"), "utf8")).not.toBe(
      "Explicit solo edit\n",
    );

    const profile = AgentProfileSchema.parse({
      id: randomUUID(),
      revision: 1,
      name: "Solo Viber",
      instructions: "Edit the assigned workspace.",
      supported_access: ["workspace-write"],
      execution: { ...configuration, access: "workspace-write" },
    });

    engine.flows.saveProfile(profile, null);
    const flowId = randomUUID();
    const nodeId = randomUUID();

    engine.flows.saveDefinition(
      flowId,
      {
        name: "Solo flow",
        nodes: [
          {
            id: nodeId,
            name: "Solo Viber",
            type: "agent",
            profile_id: profile.id,
            instructions: "",
            overrides: {},
            completion: { verification: "record-only", review: "none" },
            inputs: [{ kind: "task-goal" }],
          },
        ],
        edges: [],
      },
      null,
      task.id,
    );

    const flowRun = engine.flowRuns.createRun({
      flow_id: flowId,
      revision: 1,
      task_id: task.id,
      request_id: randomUUID(),
      goal: "Try an edit in the assigned workspace.",
    });

    engine.flowRuns.setRunStatus(flowRun.id, "queued", "running");

    const attempt = engine.flowRuns.beginAttempt(
      flowRun.id,
      nodeId,
      [{ binding: { kind: "task-goal" }, content: flowRun.snapshot.goal }],
      await engine.git.fingerprint(task),
    );

    const nodeOptions = {
      purpose: "Solo Viber",
      prompt: agentNodePrompt(attempt),
      nodeAttemptId: attempt.id,
    };

    await expect(
      runner.runConfigured(task, new AbortController().signal, configuration, nodeOptions),
    ).rejects.toMatchObject({ kind: "isolation" });

    await expect(
      runner.runConfigured(task, new AbortController().signal, profile.execution, {
        ...nodeOptions,
        prompt: "Wrong context",
      }),
    ).rejects.toMatchObject({ kind: "isolation" });

    expect(engine.db.all("SELECT id FROM agent_runs")).toHaveLength(1);

    const result = await runner.runConfigured(
      task,
      new AbortController().signal,
      profile.execution,
      nodeOptions,
    );

    expect(result).toEqual({
      summary: "write allowed",
    });

    const settled = engine.flowRuns.finishAttempt(
      attempt.id,
      "completed",
      JSON.stringify(result),
      "missing",
    );

    expect(settled.agent_run_id).not.toBeNull();

    expect(
      engine.db.all(
        "SELECT e.id FROM agent_events e JOIN flow_node_attempts a ON a.agent_run_id=e.run_id WHERE a.id=?",
        attempt.id,
      ).length,
    ).toBeGreaterThan(0);

    expect(
      engine.db.all(
        "SELECT u.id FROM ai_usage u JOIN flow_node_attempts a ON a.agent_run_id=u.id WHERE a.id=?",
        attempt.id,
      ),
    ).toEqual([{ id: settled.agent_run_id }]);

    engine.flowRuns.setRunStatus(flowRun.id, "running", "completed");

    expect(await readFile(join(task.worktree_path, "source.txt"), "utf8")).toBe(
      "Explicit solo edit\n",
    );

    expect(requests).toEqual([
      { stage: 0, access: "read-only" },
      { stage: 0, access: "workspace-write" },
    ]);

    expect(engine.db.task(task.id)).toMatchObject({ status: "not_started", stage: 1 });
    expect(engine.db.all("SELECT * FROM task_artifacts WHERE task_id=?", task.id)).toHaveLength(0);

    const snapshots = engine.db
      .all<{ execution: string }>(
        "SELECT execution FROM agent_runs WHERE task_id=? ORDER BY rowid",
        task.id,
      )
      .map((row) => JSON.parse(row.execution));

    expect(snapshots.map((snapshot) => snapshot.configuration.access)).toEqual([
      "read-only",
      "workspace-write",
    ]);

    expect(snapshots.every((snapshot) => snapshot.configuration.model === "next-model")).toBe(true);
    expect(snapshots[1].output_schema.properties).toEqual({ summary: { type: "string" } });
    configuration.access = "workspace-write";

    expect(
      JSON.parse(
        engine.db.all<{ execution: string }>(
          "SELECT execution FROM agent_runs WHERE task_id=? ORDER BY rowid",
          task.id,
        )[0].execution,
      ).configuration.access,
    ).toBe("read-only");

    const count = engine.db.all("SELECT id FROM agent_runs").length;

    await expect(
      run({ ...configuration, access: "unknown" } as unknown as AgentExecution),
    ).rejects.toThrow();

    await expect(run({ ...configuration, output: "custom" })).rejects.toMatchObject({
      kind: "invalid_state",
    });

    await expect(
      runner.runConfigured(
        task,
        new AbortController().signal,
        { ...configuration, output: "custom" },
        {
          prompt: "Must not execute",
          purpose: "Invalid output contract",
          schema: z.string().transform((value) => value.toUpperCase()),
        },
      ),
    ).rejects.toThrow();

    expect(engine.db.all("SELECT id FROM agent_runs")).toHaveLength(count);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});
