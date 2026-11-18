import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { sandboxInvocation } from "../../apps/core/execution/runtime/sandbox";
import { checked } from "../../apps/core/execution/runtime/process";
import { now, type Repository, type WorkspaceAssignment } from "../../apps/core/domain";
import { ViberStore } from "../../apps/core/vibers/store";
import { Engine } from "../../apps/core/execution/engine";
import { CodexProvider } from "../../apps/core/execution/providers/codex";
import type {
  AgentRunRequest,
  ProviderDetection,
} from "../../apps/core/execution/providers/contracts";

const fixtureTransport = (url: string) => {
  if (!isAbsolute(url)) {
    throw new Error("Fixture Git network is disabled; supply a local constructor transport.");
  }

  return url;
};

export const createFixtureEngine = async (
  root: string,
  providers?: Parameters<typeof Engine.create>[1],
  transport = fixtureTransport,
) => {
  const engine = await Engine.create(root, providers, transport);
  new ViberStore(engine.db).initialize();

  // Inert provider fixtures retain real filesystem isolation without requiring a Docker daemon.
  const readOnly = new Map<string, boolean>();

  engine.computers.ensure = async (scope, _cwd, readonly) => {
    readOnly.set(scope.profile_id, !!readonly);
  };

  engine.computers.finish = async () => {};

  engine.computers.transform = async (scope) => {
    engine.computers.authorize(scope);
    const workspace = engine.viberSessions.store.workspace(scope.session_id!);

    const invocation = await sandboxInvocation(
      engine.root,
      engine.db,
      workspace,
      { program: process.execPath, args: [] },
      !!readOnly.get(scope.profile_id),
      undefined,
      undefined,
      workspace.worktree_path,
      [],
      scope.session_id,
    );

    return (command) => ({
      program: invocation.program,
      args: [...invocation.args.slice(0, -1), command.program, ...command.args],
    });
  };

  return engine;
};

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
  understanding: "Safe mock test implementation",
  relevantFiles: ["source.txt"],
  existingPatterns: ["Linear code"],
  implementationSteps: ["Modify file"],
  tests: ["npm test"],
  risks: ["None"],
  openQuestions: [],
};

export const plan2 = {
  goal: "Execute fixture implementation",
  scope: "Single file",
  filesToModify: ["source.txt"],
  filesToAdd: [],
  filesToDelete: [],
  implementationSteps: ["Write content"],
  validationSteps: ["Verify file"],
  riskAnalysis: ["None"],
};

export class FixtureProvider extends CodexProvider {
  constructor(
    private readonly fields?: {
      approval?: boolean;
      output?: (prompt: string, stage: number) => unknown;
      verificationCode?: number;
      verificationOutput?: string;
    },
  ) {
    super();
  }

  detect = async (_cwd?: string): Promise<ProviderDetection> => ({
    provider: "codex",
    installed: true,
    version: "codex-test-fixture",
    connected: true,
    models: [
      { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", supportedEfforts: ["low", "xhigh"] },
      { id: "next-model", label: "Next Model", supportedEfforts: ["low", "high"] },
    ],
    efforts: ["low", "high", "xhigh"],
    capabilities: ["exec", "models", "native-conversations"],
    error: null,
  });

  invocation = (r: AgentRunRequest) => {
    const fields = this.fields;
    const result = fields?.output?.(r.prompt, r.stage) || (r.stage === 1 ? plan1 : plan2);

    let action = "";
    if (r.access === "workspace-write") {
      action = `await require('node:fs/promises').writeFile('source.txt',${JSON.stringify(r.prompt.includes("Task A") ? "A\n" : "B\n")});`;
    }

    if (r.access === "workspace-write" || fields?.approval) {
      action += `
        const fs = require('node:fs/promises');
        const path = require('node:path');
        const temporary = '/tmp/vibestar-fixture-check'; await fs.mkdir(temporary, {recursive:true});
        const test = path.join(temporary, 'source.test.cjs');
        await fs.writeFile(test, "const assert=require('node:assert/strict');const fs=require('node:fs');assert.match(fs.readFileSync("+JSON.stringify(path.resolve('source.txt'))+",'utf8'),/\\\\n$/);");
        const output = require('node:child_process').execFileSync(process.execPath, ['--test', test], {encoding: 'utf8'});
        console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',id:'fixture-check',command:JSON.stringify(['node','--test',test]),exit_code:0,aggregated_output:output}}));
      `;
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

export const prepareFixtureTask = async (
  engine: Engine,
  repo: Repository,
  id: string,
  _issue = 1,
): Promise<WorkspaceAssignment> => {
  const assignment: WorkspaceAssignment = {
    id,
    repo_id: repo.id,
    branch_name: "",
    base_commit_sha: "",
    worktree_path: "",
    base_branch: repo.base_branch,
    kind: "general",
    goal: "fixture-workspace",
  };

  await engine.git.prepare(repo, assignment);
  return assignment;
};
