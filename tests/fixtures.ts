import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checked } from "../backend/execution/process";
import { now, type Repository } from "../backend/domain";
import { Engine } from "../backend/execution/engine";
import { CodexProvider } from "../backend/execution/providers/codex";
import type {
  AgentRunRequest,
  ProviderDetection,
} from "../backend/execution/providers/contracts";
export const fixtureRepository = async (engine: Engine, dir: string) => {
  const upstream = join(dir, "upstream");
  await mkdir(upstream);
  await checked("git", ["init", "-b", "main"], upstream);
  await checked(
    "git",
    ["config", "user.email", "test@example.invalid"],
    upstream,
  );
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
      authentication: "Connected · ChatGPT subscription",
      models: [],
      efforts: ["high"],
      capabilities: ["test-fixture"],
      error: null,
    };
  };
  invocation = (r: AgentRunRequest) => {
    const result = (r.schema.properties as Record<string, unknown>)
      ?.manualActionRequired
      ? {
          manualActionRequired: true,
          severity: "action_required",
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
          : {
              summary: "Implemented by TEST fixture",
              filesChanged: ["source.txt"],
              testsPassed: [],
              testsFailed: [],
              testsSkipped: ["fixture"],
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
export const waitForTask = (
  engine: Engine,
  id: string,
  predicate: (status: string) => boolean,
) =>
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
