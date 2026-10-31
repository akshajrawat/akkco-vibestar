import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fetchIssue } from "../../backend/workspace/issue";
import type { AgentRunRequest } from "../../backend/execution/providers/contracts";
import { Rpc } from "../../backend/rpc";
import {
  createFixtureEngine,
  fixtureRepository,
  FixtureProvider,
  waitForTask,
} from "../helpers/fixtures";

vi.mock("../../backend/workspace/issue", () => ({ fetchIssue: vi.fn() }));

const context = {
  title: "Explain before implementing",
  body: "Do not alter the imported checkout",
  labels: [],
  state: "open",
  comments: [],
  linkedPullRequests: [],
  contextWarnings: [],
  url: "https://github.com/fixture/fixture/issues/1",
  number: 1,
  context_fetched_at: "2026-10-25T00:00:00Z",
};

const configuration = {
  provider: "codex" as const,
  config: { model: "next-model", effort: "low", timeout_secs: 30 },
};

class ConversationProvider extends FixtureProvider {
  invocation = (request: AgentRunRequest) => {
    if (
      !(request.schema.properties as Record<string, unknown>)?.summary ||
      Object.keys(request.schema.properties as object).length !== 1
    )
      return new FixtureProvider().invocation(request);

    // These are real write probes inside the production read-only sandbox.
    const script = `
      (async()=>{
        const fs=require('node:fs/promises');
        const source=await fs.readFile('source.txt','utf8');
        let denied=false;
        try{await fs.writeFile('source.txt','UNAUTHORIZED')}catch{denied=true}
        if(!denied)throw Error('Source was writable');
        const git=await fs.readFile('.git','utf8');
        const metadata=git.trim().replace('gitdir: ','');
        denied=false;
        try{await fs.writeFile(require('node:path').join(metadata,'index'),'UNAUTHORIZED')}catch{denied=true}
        if(!denied)throw Error('Git metadata was writable');
        const summary='Repository answer: '+source.trim()+'; writes denied';
        console.log(JSON.stringify({type:'item.completed',item:{id:'commentary',type:'agent_message',text:'Inspecting the requested source.'}}));
        console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:summary}}));
        console.log(JSON.stringify({type:'turn.completed'}));
      })().catch(e=>{console.error(e);process.exitCode=1});
    `;

    return { program: process.execPath, args: ["-e", script], input: "" };
  };
}

let directory: string;
let provider: ConversationProvider;
let engine: Awaited<ReturnType<typeof createFixtureEngine>>;

beforeEach(async () => {
  vi.mocked(fetchIssue).mockResolvedValue(context);
  directory = await mkdtemp(join(tmpdir(), "vibestar-workflow-"));
  provider = new ConversationProvider();
  engine = await createFixtureEngine(join(directory, "data"), () => provider);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await engine.close();
  await rm(directory, { recursive: true, force: true });
});

const idleTask = async () => {
  const { repo } = await fixtureRepository(engine, directory);
  const task = await engine.createTask(repo.id, context.url, "", "", "whole_issue");
  return { repo, task };
};

it("creates and reopens an idle conversation without preparing files, consuming usage or reserving capacity", async () => {
  const { task } = await idleTask();
  const invoke = vi.spyOn(provider, "invocation");
  engine.start();
  await engine.drain();

  expect(engine.db.task(task.id)).toMatchObject({
    status: "not_started",
    stage: 0,
    worktree_path: "",
  });

  expect(engine.cleanupBlockers()).toEqual([]);
  expect(engine.db.detail(task.id).usage).toEqual([]);
  await expect(engine.retry(task.id, 0, true)).rejects.toThrow("Start workflow");
  expect(() => engine.followUp(task.id, "Implement now")).toThrow("Start workflow");
  engine.cancel(task.id);
  expect(engine.db.task(task.id).status).toBe("not_started");
  await engine.close();
  engine = await createFixtureEngine(join(directory, "data"), () => provider);
  engine.start();
  await engine.drain();
  expect(engine.db.task(task.id).status).toBe("not_started");
  expect(invoke).not.toHaveBeenCalled();
});

it("streams and saves read-only answers, preserves the source and keeps chat out of the pipeline unless selected", async () => {
  const { task, repo } = await idleTask();

  const request = {
    id: task.id,
    request_id: randomUUID(),
    content: "EXCLUDED_CONVERSATION_SECRET",
    configuration,
  };

  const invoke = vi.spyOn(provider, "invocation");
  engine.chat(request);
  engine.chat(request);

  await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false), {
    timeout: 15000,
  });

  expect(engine.db.task(task.id)).toMatchObject({
    status: "not_started",
    stage: 0,
  });

  expect(engine.db.detail(task.id).artifacts).toEqual([]);
  expect(invoke).toHaveBeenCalledTimes(1);
  const detail = engine.db.detail(task.id);
  expect(detail.runs[0].error).toBeNull();

  expect(detail.messages).toMatchObject([
    {
      role: "user",
      purpose: "chat",
      status: "chat_completed",
      run_id: detail.runs[0].id,
    },
    {
      role: "assistant",
      purpose: "chat",
      content: "Repository answer: base; writes denied",
    },
  ]);

  expect(detail.events.length).toBeGreaterThan(0);

  expect(detail.usage[0]).toMatchObject({
    purpose: "Read-only conversation",
    effort: "low",
    provider: "codex",
  });

  expect(await readFile(join(repo.path, "source.txt"), "utf8")).toBe("base\n");

  expect(await readFile(join(engine.db.task(task.id).worktree_path, "source.txt"), "utf8")).toBe(
    "base\n",
  );

  await engine.close();
  engine = await createFixtureEngine(join(directory, "data"), () => provider);
  engine.start();
  await engine.drain();

  expect(engine.db.task(task.id)).toMatchObject({
    status: "not_started",
    stage: 0,
  });

  expect(engine.db.detail(task.id).runs).toHaveLength(1);
  // Chat does not consume the never-started planning stage's model controls.
  const rpc = new Rpc(engine);

  await rpc.call("task.configureStage", {
    id: task.id,
    stage: 1,
    config: configuration.config,
  });

  const start = {
    id: task.id,
    request_id: randomUUID(),
    summary: "REVIEWED_START_INSTRUCTION",
  };

  await Promise.all([engine.startWorkflow(start), engine.startWorkflow(start)]);
  await waitForTask(engine, task.id, (status) => ["awaiting_approval", "failed"].includes(status));
  expect(engine.db.task(task.id).status).toBe("awaiting_approval");
  const plan = engine.db.detail(task.id).runs.at(-1)!;
  expect(plan.prompt).toContain("REVIEWED_START_INSTRUCTION");
  expect(plan.prompt).not.toContain(request.content);
  expect(engine.db.detail(task.id).runs).toHaveLength(2);
  await engine.startWorkflow(start);
  expect(engine.db.detail(task.id).runs).toHaveLength(2);
  const approval = engine.db.task(task.id).approval_gate;

  engine.chat({
    ...request,
    request_id: randomUUID(),
    content: "Explain the plan without editing",
  });

  await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false), {
    timeout: 15000,
  });

  expect(engine.db.task(task.id)).toMatchObject({
    status: "awaiting_approval",
    approval_gate: approval,
  });

  expect(engine.db.detail(task.id).runs).toHaveLength(3);
  expect(engine.db.detail(task.id).runs.at(-1)?.purpose).toBe("Read-only conversation");
  expect(await readFile(join(repo.path, "source.txt"), "utf8")).toBe("base\n");
  await expect(engine.startWorkflow({ ...start, summary: "changed" })).rejects.toThrow();
}, 30000);

it("includes only explicitly selected completed messages and refuses foreign message identities", async () => {
  const { task } = await idleTask();

  engine.chat({
    id: task.id,
    request_id: randomUUID(),
    content: "SELECTED_CHAT_INSTRUCTION",
    configuration,
  });

  await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false), {
    timeout: 15000,
  });

  const message = engine.db.detail(task.id).messages[0];

  await expect(
    engine.startWorkflow({
      id: task.id,
      request_id: randomUUID(),
      message_ids: [randomUUID()],
    }),
  ).rejects.toThrow("belong to this task");

  expect(engine.db.task(task.id).status).toBe("not_started");

  await engine.startWorkflow({
    id: task.id,
    request_id: randomUUID(),
    message_ids: [String(message.id)],
  });

  await waitForTask(engine, task.id, (status) => ["awaiting_approval", "failed"].includes(status));
  expect(engine.db.detail(task.id).runs.at(-1)!.prompt).toContain("SELECTED_CHAT_INSTRUCTION");
});

it("retains historical queue authorization through restart while new idle tasks stay idle", async () => {
  const { task, repo } = await idleTask();

  const legacy = {
    ...task,
    id: randomUUID(),
    status: "queued" as const,
    workflow_version: undefined,
  };

  engine.db.saveTask(legacy);
  await engine.close();
  engine = await createFixtureEngine(join(directory, "data"), () => provider);
  engine.start();

  await waitForTask(engine, legacy.id, (status) =>
    ["awaiting_approval", "failed"].includes(status),
  );

  expect(engine.db.task(legacy.id).status).toBe("awaiting_approval");
  expect(engine.db.task(task.id).status).toBe("not_started");
  expect(await readFile(join(repo.path, "source.txt"), "utf8")).toBe("base\n");
});

it("cancels a read-only conversation without authorizing a workflow or replaying the question", async () => {
  const { task } = await idleTask();
  const detection = await provider.detect();
  let release!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const detect = vi.spyOn(provider, "detect").mockImplementationOnce(async () => {
    await gate;
    return detection;
  });

  const invoke = vi.spyOn(provider, "invocation");

  const request = {
    id: task.id,
    request_id: randomUUID(),
    content: "Explain the task",
    configuration,
  };

  engine.chat(request);

  await vi.waitFor(() => expect(detect).toHaveBeenCalledOnce(), {
    timeout: 10000,
  });

  engine.cancel(task.id);
  release();
  await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false));
  expect(engine.db.task(task.id).status).toBe("not_started");
  expect(engine.db.detail(task.id).messages[0].status).toBe("chat_cancelled");
  engine.chat(request);
  expect(invoke).not.toHaveBeenCalled();
  expect(engine.db.detail(task.id).runs).toHaveLength(1);
});

it("keeps failed startup validation idle and permits a fresh explicit retry after configuration repair", async () => {
  const { task } = await idleTask();
  const detection = await provider.detect();

  const detect = vi.spyOn(provider, "detect").mockResolvedValue({
    ...detection,
    connected: false,
    error: "Connect fixture provider",
  });

  const invoke = vi.spyOn(provider, "invocation");
  const request = { id: task.id, request_id: randomUUID() };
  await expect(engine.startWorkflow(request)).rejects.toThrow("Connect fixture provider");

  expect(engine.db.task(task.id)).toMatchObject({
    status: "not_started",
    worktree_path: "",
  });

  expect(engine.db.task(task.id).workflow_start).toBeUndefined();
  expect(engine.cleanupBlockers(task.id)).toEqual([]);
  expect(invoke).not.toHaveBeenCalled();
  detect.mockResolvedValue(detection);
  await engine.startWorkflow(request);
  await waitForTask(engine, task.id, (status) => ["awaiting_approval", "failed"].includes(status));
  expect(engine.db.task(task.id).status).toBe("awaiting_approval");
  expect(invoke).toHaveBeenCalledOnce();
});

it("continues only the most recent completed conversation with matching provider configuration", async () => {
  const { task } = await idleTask();
  const requests: AgentRunRequest[] = [];

  vi.spyOn(provider, "invocation").mockImplementation((request) => {
    requests.push(request);
    const invocation = new ConversationProvider().invocation(request);

    invocation.args[1] =
      `console.log(JSON.stringify({type:'thread.started',thread_id:'owned-thread'}));` +
      invocation.args[1];

    return invocation;
  });

  const ask = async (content: string, effort = "low") => {
    engine.chat({
      id: task.id,
      request_id: randomUUID(),
      content,
      configuration: { ...configuration, config: { ...configuration.config, effort } },
    });

    await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false), { timeout: 15000 });
    expect(engine.db.detail(task.id).runs.at(-1)?.status).toBe("completed");
  };

  await ask("First question");
  expect(requests[0].conversation).toEqual({ threadId: undefined });
  await ask("Follow-up question");
  expect(requests[1].conversation).toEqual({ threadId: "owned-thread" });
  expect(requests[1].prompt).toBe("Follow-up question");
  expect(requests[1].prompt).not.toContain('"history":[');
  await ask("Another repository question");
  expect(requests[2].conversation).toEqual({ threadId: "owned-thread" });
  expect(requests[2].prompt).toBe("Another repository question");
  await ask("Different effort", "high");
  expect(requests[3].conversation).toEqual({ threadId: undefined });
  const latest = engine.db.detail(task.id).runs.at(-1)!;
  engine.db.run("UPDATE agent_runs SET status='cancelled' WHERE id=?", latest.id);
  await ask("After interruption", "high");
  expect(requests[4].conversation).toEqual({ threadId: undefined });

  engine.db.run(
    "UPDATE agent_runs SET prompt='Legacy prompt without app context' WHERE task_id=?",
    task.id,
  );

  await ask("After upgrading the app", "high");
  expect(requests[5].conversation).toEqual({ threadId: undefined });
  expect(requests[5].prompt).toContain("Akkco Vibestar");
});

it("answers a greeting through the provider without cloning, preparing a worktree or mounting repository files", async () => {
  const { task } = await idleTask();
  const requests: AgentRunRequest[] = [];

  vi.spyOn(provider, "invocation").mockImplementation((request) => {
    requests.push(request);
    return {
      program: process.execPath,
      input: "",
      args: [
        "-e",
        `const fs=require('node:fs');if(fs.existsSync('source.txt')||fs.existsSync('.git'))throw Error('Repository exposed to conversational turn');console.log(JSON.stringify({type:'thread.started',thread_id:'greeting-thread'}));console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:'Hello from the fixture provider'}}));console.log(JSON.stringify({type:'turn.completed'}));`,
      ],
    };
  });

  const prepare = vi.spyOn(engine.git, "prepare");
  engine.chat({ id: task.id, request_id: randomUUID(), content: "hi!", configuration });
  await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false), { timeout: 15000 });
  const saved = engine.db.detail(task.id);
  expect(saved.task).toMatchObject({ status: "not_started", stage: 0, worktree_path: "" });
  expect(saved.runs[0]).toMatchObject({ status: "completed", purpose: "Read-only conversation" });
  expect(saved.messages.at(-1)?.content).toBe("Hello from the fixture provider");
  expect(saved.events.some((event) => event.kind === "message")).toBe(true);
  expect(saved.artifacts).toEqual([]);
  expect(prepare).not.toHaveBeenCalled();
  expect(requests[0].cwd).toContain("/cache/utility/conversation-");
  expect(requests[0].prompt).toContain("Akkco Vibestar");
  expect(requests[0].prompt).toMatch(/hi!$/);
  expect(requests[0].prompt).not.toContain(context.body);

  expect(
    await readFile(join(engine.root, "logs", task.id, `${saved.runs[0].id}.jsonl`), "utf8"),
  ).toContain("Hello from the fixture provider");

  engine.chat({ id: task.id, request_id: randomUUID(), content: "hello", configuration });
  await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false), { timeout: 15000 });
  expect(requests[1].conversation?.threadId).toBe("greeting-thread");
  expect(engine.db.task(task.id).worktree_path).toBe("");
  await engine.close();
  engine = await createFixtureEngine(join(directory, "data"), () => provider);
  engine.start();
  await engine.drain();
  expect(requests).toHaveLength(2);
  expect(engine.db.task(task.id).worktree_path).toBe("");
  vi.mocked(provider.invocation).mockRestore();
  const repositoryQuestion = vi.spyOn(provider, "invocation");

  engine.chat({
    id: task.id,
    request_id: randomUUID(),
    content: "Explain source.txt",
    configuration,
  });

  await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false), { timeout: 15000 });
  expect(engine.db.detail(task.id).runs.at(-1)?.status).toBe("completed");
  expect(repositoryQuestion.mock.calls[0][0].conversation?.threadId).toBeUndefined();
  expect(repositoryQuestion.mock.calls[0][0].prompt).toContain("Hello from the fixture provider");
  expect(engine.db.task(task.id).worktree_path).not.toBe("");
});

it("keeps workflow history available without injecting it into ordinary conversation prompts", async () => {
  const { task } = await idleTask();

  engine.db.run(
    "INSERT INTO agent_runs(id,task_id,stage,provider,model,effort,prompt,status,started_at,purpose) VALUES(?,?,4,'codex','next-model','low','legacy','completed',?,'Validation')",
    randomUUID(),
    task.id,
    task.updated_at,
  );

  const { chatPrompt } = await import("../../backend/execution/workflow");
  const prompt = chatPrompt(engine.db, task, "What happened during validation?");
  expect(prompt).not.toContain('"stage":4');
  expect(prompt).not.toContain('"output":null');
  expect(prompt).not.toContain("Return the answer in summary");
  expect(engine.db.detail(task.id).runs[0].stage).toBe(4);
});
