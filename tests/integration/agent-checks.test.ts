import { expect, it } from "vitest";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { randomUUID } from "node:crypto";
import {
  createFixtureEngine,
  fixtureRepository,
  FixtureProvider,
  fixtureFlowTask,
  startFixtureFlow,
  waitForFixtureFlow,
} from "../helpers/fixtures";

it("keeps missing implementation checks separate from independently observed read-only reviewer checks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibestar-agent-checks-"));
  const access: string[] = [];
  const fixture = new FixtureProvider();
  const argv = ["node", "--check", "source.js"];

  const check = {
    name: "Required syntax",
    command: JSON.stringify(argv),
    kind: "check",
    required: true,
    scope: "repository",
    prerequisite: null,
  };

  const engine = await createFixtureEngine(join(directory, "data"), () => ({
    ...fixture,
    invocation: (request) => {
      access.push(request.access);

      const report =
        request.access === "workspace-write"
          ? {
              summary: "Implementation ready; syntax check not run",
              filesChanged: ["source.js"],
              testsPassed: [],
              testsFailed: [],
              testsSkipped: [check.name],
              remainingRisks: [],
              verification: [
                { ...check, outcome: "not_run", detail: "Awaiting independent execution" },
              ],
            }
          : {
              approval: "approved",
              summary: "Independently checked source",
              findings: [],
              testsRun: [check.name],
              testsNotRun: [],
              verification: [
                { ...check, outcome: "passed", detail: "Observed syntax check passed" },
              ],
            };

      const action =
        request.access === "workspace-write"
          ? "await require('node:fs/promises').writeFile('source.js', 'const answer = 42;\\n');"
          : `const output = require('node:child_process').execFileSync('node', ['--check', 'source.js'], {encoding:'utf8'});
          let denied=false;try{await require('node:fs/promises').writeFile('source.js','bad')}catch(e){if(e.code!=='EROFS')throw e;denied=true}
          if(!denied)throw Error('Review source was writable');
          console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',id:'syntax',command:${JSON.stringify(JSON.stringify(argv))},exit_code:0,aggregated_output:output}}));`;

      return {
        program: process.execPath,
        args: [
          "-e",
          `(async()=>{${action}console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(JSON.stringify(report))}}}));})().catch(e=>{console.error(e);process.exitCode=1});`,
        ],
      };
    },
  }));

  try {
    const { repo } = await fixtureRepository(engine, directory);

    const task = fixtureFlowTask(engine, repo);
    const saved = engine.flows.definition(task.flow_id!);
    const implementation = saved.definition.nodes[0];
    if (implementation.type !== "agent") throw new Error("Missing fixture agent");
    const profile = engine.flows.profile(implementation.profile_id);

    const reviewer = {
      ...profile,
      id: randomUUID(),
      name: "Independent reviewer",
      execution: { ...profile.execution, access: "read-only" as const, output: "review" as const },
    };

    engine.flows.saveProfile(reviewer, null);

    const review = {
      ...implementation,
      id: randomUUID(),
      name: reviewer.name,
      profile_id: reviewer.id,
      inputs: [{ kind: "output" as const, node_id: implementation.id }],
      completion: { verification: "require-passing" as const, review: "require-approved" as const },
    };

    engine.flows.saveDefinition(
      task.flow_id!,
      {
        name: "Independent checks",
        nodes: [implementation, review],
        edges: [{ id: randomUUID(), source: implementation.id, target: review.id }],
      },
      1,
    );

    const run = startFixtureFlow(engine, task);
    await waitForFixtureFlow(engine, run);
    const attempts = engine.flowRuns.attempts(run.id);
    expect(attempts.map((value) => value.verification)).toEqual(["missing", "passed"]);
    expect(access).toEqual(["workspace-write", "read-only"]);
    expect(engine.db.task(task.id)).toMatchObject({ stage: 0, status: "not_started" });

    expect(
      engine.db.all(
        "SELECT status,exit_code FROM test_runs WHERE run_id=?",
        attempts[1].agent_run_id,
      ),
    ).toEqual([{ status: "passed", exit_code: 0 }]);

    expect(await readFile(join(engine.db.task(task.id).worktree_path, "source.js"), "utf8")).toBe(
      "const answer = 42;\n",
    );
  } finally {
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
