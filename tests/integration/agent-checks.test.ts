import { expect, it, vi } from "vitest";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseIssue } from "../../backend/domain";
import { taskVerification } from "../../backend/execution/verification/task-verification";
import {
  createFixtureEngine,
  fixtureRepository,
  FixtureProvider,
  finishFixtureTask,
  waitForTask,
} from "../helpers/fixtures";

it("lets the independent reviewer run missing implementation checks and complete the task without a validation stage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibestar-agent-checks-"));
  const stages: number[] = [];
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

  const engine = await createFixtureEngine(join(directory, "data"), (stage) => ({
    ...fixture,
    invocation: (request) => {
      stages.push(stage);
      if (stage !== 3 && stage !== 5) return fixture.invocation(request);

      const report =
        stage === 3
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
        stage === 3
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

    const task = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/1"),
      "Task A",
      "",
      {},
    );

    await finishFixtureTask(
      engine,
      task.id,
      (status) =>
        status === "awaiting_approval" &&
        engine.db.task(task.id).approval_gate === "implementation",
    );

    await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false));
    expect(engine.db.task(task.id)).toMatchObject({ stage: 5, error: null });
    expect(taskVerification(engine.db, task.id).canReview).toBe(false);
    expect(stages).toEqual([1, 2, 3]);
    await engine.approveStage(task.id);

    await waitForTask(
      engine,
      task.id,
      (status) => status === "awaiting_approval" || status === "failed",
    );

    await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false));

    expect(engine.db.task(task.id), engine.db.task(task.id).error || "Review result").toMatchObject(
      { final_review_verdict: "verified", approval_gate: "final_review" },
    );

    expect(stages).toEqual([1, 2, 3, 5]);

    expect(
      taskVerification(engine.db, task.id).checks.find((item) => item.name === check.name),
    ).toMatchObject({ outcome: "passed", source: "observed_command" });

    await engine.approveStage(task.id);
    expect(engine.db.task(task.id).status).toBe("ready_for_review");

    expect(await readFile(join(engine.db.task(task.id).worktree_path, "source.js"), "utf8")).toBe(
      "const answer = 42;\n",
    );
  } finally {
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
