import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { checked } from "../../backend/execution/runtime/process";
import { now, type Repository, type Task } from "../../backend/domain";
import { Engine } from "../../backend/execution/engine";
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
  constructor(
    private readonly gate?: () => Promise<void>,
    private readonly failOnce?: { value: boolean },
  ) {
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
    const result = (r.schema.properties as Record<string, unknown>)?.manualActionRequired
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
      : r.stage === 1
        ? plan1
        : r.stage === 2
          ? plan2
          : r.stage === 5
            ? {
                approval: "approved",
                summary: "Fixture final review",
                findings: [],
                testsRun: ["fixture inspection"],
                testsNotRun: ["remote CI"],
              }
            : {
                summary: "Implemented by TEST fixture",
                filesChanged: ["source.txt"],
                testsPassed: [],
                testsFailed: [],
                testsSkipped: [],
                remainingRisks: [],
              };
    let action = "";
    if (r.stage === 3)
      action = `await require('node:fs/promises').writeFile('source.txt',${JSON.stringify(r.prompt.includes("Task A") ? "A\n" : "B\n")});`;
    if (r.stage === 2 && this.failOnce?.value) {
      this.failOnce.value = false;
      return {
        program: process.execPath,
        input: "",
        args: ["-e", "console.error('fixture quota error');process.exit(29)"],
      };
    }
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
export const waitForTask = (engine: Engine, id: string, predicate: (status: string) => boolean) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      engine.off("event", check);
      reject(new Error("Task transition deadline exceeded"));
    }, 30000);
    const check = () => {
      if (predicate(engine.db.task(id).status)) {
        clearTimeout(timer);
        engine.off("event", check);
        resolve();
      }
    };
    engine.on("event", check);
    check();
  });

// Existing integration scenarios explicitly simulate the user's approvals.
// Gate-specific tests use waitForTask directly and assert no autonomous progress.
export const finishFixtureTask = async (
  engine: Engine,
  id: string,
  predicate: (status: string) => boolean,
) => {
  let approving = false;
  let failure: unknown;
  const approve = () => {
    const task = engine.db.task(id);
    if (
      task.status !== "awaiting_approval" ||
      predicate(task.status) ||
      engine.isActive(id) ||
      approving ||
      failure
    )
      return;
    approving = true;
    void engine
      .approveStage(id)
      .catch((error) => {
        failure = error;
      })
      .finally(() => {
        approving = false;
      });
  };
  engine.on("event", approve);
  const timer = setInterval(approve, 20);
  try {
    await waitForTask(engine, id, (status) => !!failure || predicate(status));
    if (failure) throw failure;
  } finally {
    clearInterval(timer);
    engine.off("event", approve);
  }
};

export const prepareFixtureTask = async (
  engine: Engine,
  repo: Repository,
  id: string,
  issue = 1,
) => {
  const task: Task = {
    id,
    repo_id: repo.id,
    issue_number: issue,
    issue_url: `https://github.com/fixture/fixture/issues/${issue}`,
    claimed_scope: id,
    notes: "",
    issue: {},
    branch_name: "",
    base_branch: "main",
    base_commit_sha: "",
    worktree_path: "",
    stage: 1,
    status: "cancelled",
    error: null,
    created_at: now(),
    updated_at: now(),
  };
  engine.db.saveTask(task);
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
