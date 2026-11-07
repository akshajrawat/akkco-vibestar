import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { checked } from "../../backend/execution/runtime/process";
import { now, type Repository, type Task } from "../../backend/domain";
import { Engine } from "../../backend/execution/engine";
import { AgentProfileSchema, type AgentProfile } from "../../backend/flows/contracts";
import type { FlowRun } from "../../backend/flows/run-contracts";
import { CodexProvider } from "../../backend/execution/providers/codex";
import type {
  AgentRunRequest,
  ProviderDetection,
} from "../../backend/execution/providers/contracts";

const fixtureTransport = (url: string) => {
  if (!isAbsolute(url))
    throw new Error("Fixture Git network is disabled; supply a local constructor transport.");
  return url;
};

export const createFixtureEngine = (
  root: string,
  providers?: Parameters<typeof Engine.create>[1],
  transport = fixtureTransport,
) => Engine.create(root, providers, transport);

export const fixtureRepository = async (engine: Engine, dir: string) => {
  const upstream = join(dir, "upstream");
  await mkdir(upstream);
  await checked("git", ["init", "-b", "main"], upstream);
  await checked("git", ["config", "user.email", "test@example.invalid"], upstream);
  await checked("git", ["config", "user.name", "Integration Test"], upstream);
  await writeFile(join(upstream, "source.txt"), "base\n");
  await writeFile(join(upstream, "deleted.txt"), "delete me\n");
  await writeFile(join(upstream, "rename.txt"), "rename me\n");
  await writeFile(join(upstream, ".gitignore"), "ignored.txt\n");
  await checked("git", ["add", "."], upstream);
  await checked("git", ["commit", "-m", "base"], upstream);
  const id = randomUUID();
  const path = join(engine.root, "repos", id);
  await engine.git.clone(upstream, path);

  const repo: Repository = {
    id,
    owner: "fixture",
    name: "fixture",
    upstream_url: upstream,
    origin_url: null,
    base_branch: "main",
    path,
    last_fetched: null,
    created_at: now(),
  };

  engine.db.saveRepository(repo);
  return { repo, upstream };
};

/** Stored historical/ownership data only: no dispatch, model discovery or provider execution. */
export const historicalTaskFixture = (
  engine: Engine,
  repo: Repository,
  input: {
    id?: string;
    issue_number?: number;
    scope?: string;
    status?: Task["status"];
    stage?: number;
  } = {},
) => {
  const timestamp = now();
  const issue = input.issue_number ?? 1;

  const task: Task = {
    id: input.id || randomUUID(),
    repo_id: repo.id,
    issue_number: issue,
    issue_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue}`,
    claimed_scope: input.scope || "Task A",
    notes: "",
    issue: {},
    branch_name: "",
    base_branch: repo.base_branch,
    base_commit_sha: "",
    worktree_path: "",
    stage: input.stage ?? 0,
    status: input.status || "not_started",
    error: null,
    created_at: timestamp,
    updated_at: timestamp,
  };

  engine.db.saveTask(task);
  return task;
};

export const plan1 = {
  summary: "Fixture plan",
  understanding: "One file only",
  relevantFiles: ["source.txt"],
  existingPatterns: ["text"],
  implementationSteps: ["edit source"],
  tests: ["git diff --check"],
  risks: [],
  openQuestions: [],
};

export const plan2 = {
  goal: "Change source",
  scope: "source.txt",
  filesToModify: ["source.txt"],
  filesToAdd: [],
  filesToDelete: [],
  implementationSteps: ["edit"],
  validationSteps: ["git diff --check"],
  riskAnalysis: [],
  explicitNonGoals: ["remote writes"],
};

export class FixtureProvider extends CodexProvider {
  constructor(private readonly gate?: () => Promise<void>) {
    super();
  }

  detect = async (): Promise<ProviderDetection> => {
    await this.gate?.();
    return {
      provider: "test-fixture",
      installed: true,
      version: "TEST ONLY",
      connected: true,
      accountLabel: "ChatGPT subscription",
      models: [{ id: "next-model", supportedEfforts: ["low", "high"] }],
      efforts: ["low", "medium", "high"],
      capabilities: ["test-fixture"],
      error: null,
    };
  };

  invocation = (r: AgentRunRequest) => {
    const fields = r.schema.properties as Record<string, unknown>;

    const result = fields?.manualActionRequired
      ? {
          manualActionRequired: true,
          severity: "action_required",
          conversationState: "waiting_for_me",
          outstandingRequests: [],
          alreadyAddressed: [],
          summary: "Add test",
          reason: "Review feedback",
          newActivity: ["Add coverage"],
          recommendedNextAction: "Add coverage",
          affectedFiles: ["source.txt"],
        }
      : fields?.understanding
        ? plan1
        : fields?.filesToModify
          ? { ...plan2, scope: /(?:^|\n)Scope: ([^\n]+)/.exec(r.prompt)?.[1] || plan2.scope }
          : fields?.approval
            ? {
                approval: "approved",
                summary: "Fixture final review",
                findings: [],
                testsRun: ["fixture inspection"],
                testsNotRun: ["remote CI"],
              }
            : fields?.filesChanged
              ? {
                  summary: "Implemented by TEST fixture",
                  filesChanged: ["source.txt"],
                  testsPassed: [],
                  testsFailed: [],
                  testsSkipped: [],
                  remainingRisks: [],
                }
              : { summary: "Fixture response" };

    let action = "";
    if (r.access === "workspace-write")
      action = `await require('node:fs/promises').writeFile('source.txt',${JSON.stringify(r.prompt.includes("Task A") ? "A\n" : "B\n")});`;
    if (r.access === "workspace-write" || fields?.approval)
      action += `
        const fs = require('node:fs/promises');
        const path = require('node:path');
        const temporary = '/tmp/vibestar-fixture-check'; await fs.mkdir(temporary, {recursive:true});
        const test = path.join(temporary, 'source.test.cjs');
        await fs.writeFile(test, "const assert=require('node:assert/strict');const fs=require('node:fs');assert.match(fs.readFileSync("+JSON.stringify(path.resolve('source.txt'))+",'utf8'),/\\\\n$/);");
        const output = require('node:child_process').execFileSync(process.execPath, ['--test', test], {encoding: 'utf8'});
        console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',id:'fixture-check',command:JSON.stringify(['node','--test',test]),exit_code:0,aggregated_output:output}}));
      `;

    return {
      program: process.execPath,
      input: "",
      args: [
        "-e",
        `(async()=>{${action}console.log(JSON.stringify({type:'thread.started',thread_id:'test-only-conversation'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(JSON.stringify(result))}}}));console.log(JSON.stringify({type:'turn.completed'}));})();`,
      ],
    };
  };
}

/** A current task with explicit settings; creating it never starts a provider. */
export const fixtureFlowTask = (
  engine: Engine,
  repo: Repository | null,
  goal = "Task A",
  execution: Partial<AgentProfile["execution"]> = {},
) => {
  const profile = AgentProfileSchema.parse({
    id: randomUUID(),
    revision: 1,
    name: "Fixture Viber",
    instructions: "Use the selected task goal.",
    supported_access: ["read-only", "workspace-write"],
    execution: {
      provider: "codex",
      model: "next-model",
      effort: "low",
      timeout_secs: 30,
      access: "workspace-write",
      output: "implementation",
      ...execution,
    },
  });

  engine.flows.saveProfile(profile, null);
  return engine.createGeneralTask({
    request_id: randomUUID(),
    goal,
    ...(repo ? { repository_id: repo.id } : {}),
    profile_id: profile.id,
  });
};

export const startFixtureFlow = (engine: Engine, task: Task) => {
  if (!task.flow_id || !task.goal) throw new Error("Fixture requires a current task and flow.");
  return engine.startFlow({
    task_id: task.id,
    flow_id: task.flow_id,
    revision: engine.flows.definition(task.flow_id).revision,
    request_id: randomUUID(),
    goal: task.goal,
  });
};

export const waitForFixtureFlow = (
  engine: Engine,
  run: FlowRun,
  status: FlowRun["status"] = "completed",
) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      engine.off("event", check);
      const latest = engine.flowRuns.run(run.id);

      reject(
        new Error(`Flow transition deadline: ${latest.status}: ${latest.error || "no diagnostic"}`),
      );
    }, 30000);

    const check = () => {
      const latest = engine.flowRuns.run(run.id);
      if (
        !engine.isExecuting(run.task_id) &&
        latest.status !== status &&
        ["completed", "failed", "cancelled", "interrupted"].includes(latest.status)
      ) {
        clearTimeout(timer);
        engine.off("event", check);

        reject(
          new Error(
            `Expected flow ${status}; got ${latest.status}: ${latest.error || "no diagnostic"}`,
          ),
        );

        return;
      }

      if (latest.status === status && !engine.isExecuting(run.task_id)) {
        clearTimeout(timer);
        engine.off("event", check);
        resolve();
      }
    };

    engine.on("event", check);
    check();
  });

export const prepareFixtureTask = async (
  engine: Engine,
  repo: Repository,
  id: string,
  issue = 1,
) => {
  const task = historicalTaskFixture(engine, repo, {
    id,
    issue_number: issue,
    scope: id,
    stage: 1,
    status: "cancelled",
  });

  await engine.git.prepare(
    repo,
    task,
    undefined,
    (value) => engine.db.saveTask(value),
    async (record) => {
      engine.db.run(
        "INSERT INTO task_activity(task_id,kind,data,timestamp) VALUES(?,'preparation',?,?)",
        task.id,
        JSON.stringify(record),
        now(),
      );
    },
  );

  engine.db.saveTask(task);
  return task;
};
