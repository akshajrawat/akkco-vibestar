import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { fetchIssue } from "../../backend/workspace/issue";
import { Rpc } from "../../backend/rpc";
import type { Task } from "../../backend/domain";
import { builtInProfiles } from "../../backend/flows/templates";
import type { AgentRunRequest } from "../../backend/execution/providers/contracts";
import { createFixtureEngine, fixtureRepository, FixtureProvider } from "../helpers/fixtures";

vi.mock("../../backend/workspace/issue", () => ({ fetchIssue: vi.fn() }));

class IssueFixture extends FixtureProvider {
  readonly requests: AgentRunRequest[] = [];

  invocation = (request: AgentRunRequest) => {
    this.requests.push(request);
    return {
      program: process.execPath,
      input: "",
      args: [
        "-e",
        "require('node:fs').writeFileSync('source.txt','An explicit solo edit\\n'); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Updated the selected source file.'}})); console.log(JSON.stringify({type:'turn.completed'}));",
      ],
    };
  };
}

let dir: string;
let engine: Awaited<ReturnType<typeof createFixtureEngine>>;
let rpc: Rpc;
let provider: IssueFixture;

beforeEach(async () => {
  vi.clearAllMocks();

  vi.mocked(fetchIssue).mockResolvedValue({
    title: "Fix the actual issue",
    body: "Requirements",
    labels: [],
    state: "open",
    comments: [],
    linkedPullRequests: [],
    contextWarnings: [],
    url: "https://github.com/fixture/fixture/issues/1",
    number: 1,
    context_fetched_at: new Date().toISOString(),
  });

  dir = await mkdtemp(join(tmpdir(), "vibestar-issue-flow-"));
  provider = new IssueFixture();
  engine = await createFixtureEngine(join(dir, "data"), () => provider);
  rpc = new Rpc(engine);
  const profile = engine.flows.profile(builtInProfiles.implementer);

  engine.flows.saveProfile(
    {
      ...profile,
      revision: 2,
      execution: {
        ...profile.execution,
        provider: "codex",
        model: "next-model",
        effort: "low",
        timeout_secs: 30,
      },
    },
    1,
  );
});

afterEach(async () => {
  await rpc.close();
  await engine.close();
  await rm(dir, { recursive: true, force: true });
});

it("creates issue-backed solo tasks idempotently without a historical pipeline or inference and edits only on explicit execution", async () => {
  const { repo } = await fixtureRepository(engine, dir);

  const request = {
    request_id: randomUUID(),
    repository_id: repo.id,
    issue_url: "https://github.com/fixture/fixture/issues/1",
    scope_mode: "partial",
    claimed_scope: "Only source.txt",
    notes: "Keep existing APIs",
    profile_id: builtInProfiles.implementer,
  };

  const [a, b] = (await Promise.all([
    rpc.call("task.createIssue", request),
    rpc.call("task.createIssue", request),
  ])) as [Task, Task];

  expect(a.id).toBe(b.id);

  expect(a).toMatchObject({
    kind: "issue",
    goal: "Only source.txt",
    status: "not_started",
    stage: 0,
    worktree_path: "",
  });

  expect(fetchIssue).toHaveBeenCalledTimes(1);
  expect(engine.db.all("SELECT task_id FROM flow_task_migrations")).toEqual([]);
  expect(engine.db.all("SELECT id FROM agent_runs")).toEqual([]);
  const saved = engine.flows.definition(a.flow_id!);
  expect(saved.definition.nodes).toHaveLength(1);

  expect(saved.definition.nodes[0].inputs).toEqual([
    { kind: "task-goal" },
    { kind: "repository" },
    { kind: "issue" },
    { kind: "task-brief" },
  ]);

  expect(provider.requests).toEqual([]);

  const run = engine.startFlow({
    task_id: a.id,
    flow_id: a.flow_id!,
    revision: 1,
    request_id: randomUUID(),
    goal: a.goal!,
  });

  await expect.poll(() => engine.flowRuns.run(run.id).status, { timeout: 10000 }).toBe("completed");
  expect(provider.requests).toHaveLength(1);
  expect(provider.requests[0]).toMatchObject({ stage: 0, access: "workspace-write" });
  const task = engine.db.task(a.id);
  expect(task.stage).toBe(0);

  expect(await readFile(join(task.worktree_path, "source.txt"), "utf8")).toBe(
    "An explicit solo edit\n",
  );

  expect(
    engine.flowRuns
      .attempts(run.id)[0]
      .inputs.some(
        (input) =>
          input.binding.kind === "task-brief" && input.content.includes("Keep existing APIs"),
      ),
  ).toBe(true);
});

it("creates editable issue templates with the selected issue and scoped brief on every agent", async () => {
  const { repo } = await fixtureRepository(engine, dir);

  const request = {
    request_id: randomUUID(),
    repository_id: repo.id,
    issue_url: "https://github.com/fixture/fixture/issues/1",
    scope_mode: "whole_issue",
    claimed_scope: "",
    notes: "Exclusions",
    profile_id: builtInProfiles.implementer,
    template: "full",
  };

  const task = (await rpc.call("task.createIssue", request)) as Task;
  expect(task.goal).toBe("Fix the actual issue");
  const graph = engine.flows.definition(task.flow_id!).definition;
  expect(graph.nodes).toHaveLength(8);
  for (const node of graph.nodes.filter((node) => node.type === "agent"))
    expect(node.inputs).toEqual(
      expect.arrayContaining([{ kind: "issue" }, { kind: "task-brief" }, { kind: "repository" }]),
    );

  await expect(
    rpc.call("task.createIssue", { ...request, template: "build-review" }),
  ).rejects.toThrow("different payload");

  expect(fetchIssue).toHaveBeenCalledTimes(1);
  expect(provider.requests).toEqual([]);
});

it("rejects unknown profiles transactionally and does not fetch issues for a foreign repository", async () => {
  const { repo } = await fixtureRepository(engine, dir);

  const request = {
    request_id: randomUUID(),
    repository_id: repo.id,
    issue_url: "https://github.com/fixture/fixture/issues/1",
    scope_mode: "whole_issue",
    profile_id: randomUUID(),
  };

  await expect(rpc.call("task.createIssue", request)).rejects.toThrow();
  expect(engine.db.all("SELECT id FROM tasks")).toEqual([]);
  expect(engine.db.all("SELECT request_id FROM task_requests")).toEqual([]);
  expect(engine.db.all("SELECT * FROM issues")).toEqual([]);

  await expect(
    rpc.call("task.createIssue", {
      ...request,
      issue_url: "https://github.com/other/repository/issues/1",
    }),
  ).rejects.toThrow("mismatch");

  expect(fetchIssue).toHaveBeenCalledTimes(1);
  expect(engine.db.all("PRAGMA foreign_key_check")).toEqual([]);
});
