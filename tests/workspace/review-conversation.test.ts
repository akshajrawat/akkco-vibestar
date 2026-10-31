import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseIssue } from "../../backend/domain";
import type { AgentRunRequest } from "../../backend/execution/providers/contracts";
import { isConversationOnly } from "../../backend/execution/workflow";
import { Rpc } from "../../backend/rpc";
import {
  createFixtureEngine,
  fixtureRepository,
  FixtureProvider,
  waitForTask,
} from "../helpers/fixtures";

let directory: string;
let engine: Awaited<ReturnType<typeof createFixtureEngine>>;
let provider: FixtureProvider;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "vibestar-review-chat-"));
  provider = new FixtureProvider();
  engine = await createFixtureEngine(join(directory, "data"), () => provider);
});

afterEach(async () => {
  await engine.close();
  await rm(directory, { recursive: true, force: true });
});

const reviewTask = async () => {
  const { repo } = await fixtureRepository(engine, directory);

  const task = engine.enqueue(
    repo,
    parseIssue("https://github.com/fixture/fixture/issues/1"),
    "Task A",
    "Reuse helpers",
    {
      title: "Fix source",
      body: "Handle the edge case",
      comments: [{ user: { login: "maintainer" }, body: "Include regression coverage" }],
    },
  );

  for (const gate of ["antigravity_plan", "codex_plan", "implementation"]) {
    await waitForTask(engine, task.id, (status) =>
      ["awaiting_approval", "failed"].includes(status),
    );

    await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false));
    expect(engine.db.task(task.id).approval_gate).toBe(gate);
    await engine.approveStage(task.id);
  }

  return { task, repo };
};

it("ends a rejected review without replaying queued feedback, and retains findings across restart", async () => {
  vi.spyOn(provider, "invocation").mockImplementation((request) => {
    if (request.stage !== 5) return new FixtureProvider().invocation(request);

    const result = {
      approval: "changes_requested",
      summary: "The edge case still fails. Fix it before opening a PR.",
      findings: ["The empty input case is missing"],
      testsRun: [],
      testsNotRun: ["Remote stress test"],
      recommendedNextActions: [
        "Fix empty input",
        "Run the fork stress test manually",
        "Share results before claiming the issue",
      ],
      issues: [
        {
          severity: "high",
          file: "source.txt",
          summary: "Missing edge case",
          evidence: "Empty input fails",
        },
      ],
    };

    return {
      program: process.execPath,
      args: [
        "-e",
        `setTimeout(()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(JSON.stringify(result))}}}));console.log(JSON.stringify({type:'turn.completed'}));},100)`,
      ],
      input: "",
    };
  });

  const { task } = await reviewTask();
  await vi.waitFor(() => expect(engine.db.detail(task.id).runs.at(-1)?.stage).toBe(5));
  const feedback = engine.followUp(task.id, "Do not automatically execute this queued feedback");
  expect(feedback.disposition).toBe("queued");
  await waitForTask(engine, task.id, (status) => status === "reviewed_with_gaps");
  await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false));

  expect(engine.db.task(task.id)).toMatchObject({
    stage: 6,
    final_review_verdict: "changes_requested",
  });

  expect(engine.db.task(task.id).approval_gate).toBeUndefined();
  expect(engine.db.detail(task.id).runs.map((run) => run.stage)).toEqual([1, 2, 3, 5]);

  expect(
    engine.db.detail(task.id).messages.find((message) => message.id === feedback.message.id)
      ?.status,
  ).toBe("draft");

  expect(engine.db.artifact(task.id, 5).findings).toEqual(["The empty input case is missing"]);

  expect(engine.db.detail(task.id).runs[0].prompt).toContain(
    "Comment by maintainer:\nInclude regression coverage",
  );

  expect(engine.db.detail(task.id).runs[2].prompt).toBe(
    JSON.stringify(engine.db.artifact(task.id, 2), null, 2),
  );

  await engine.close();
  engine = await createFixtureEngine(join(directory, "data"), () => provider);
  engine.start();
  await engine.drain();
  expect(engine.db.detail(task.id).runs).toHaveLength(4);
  expect(engine.db.task(task.id).final_review_verdict).toBe("changes_requested");
});

it.each([false, true])(
  "runs one selected-model chat fix after review and invalidates review authority even on failure (%s)",
  async (fail) => {
    const { task, repo } = await reviewTask();
    await waitForTask(engine, task.id, (status) => status === "ready_for_review");
    await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false));
    const reviewHash = engine.db.task(task.id).final_review_hash;
    expect(reviewHash).toBeTruthy();
    const artifacts = engine.db.detail(task.id).artifacts;
    const requests: AgentRunRequest[] = [];

    vi.spyOn(provider, "invocation").mockImplementation((request) => {
      requests.push(request);
      return {
        program: process.execPath,
        args: [
          "-e",
          `(async()=>{const fs=require('node:fs/promises');let denied=false;try{await fs.writeFile(${JSON.stringify(join(repo.path, "source.txt"))},'forbidden',{flag:'r+'})}catch{denied=true}if(!denied)throw Error('Source checkout writable');await fs.writeFile('source.txt','Fixed in chat\\n');${fail ? "throw Error('Fixture provider failed after editing');" : "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Fixed the edge case in the task worktree.'}}));console.log(JSON.stringify({type:'turn.completed'}));"}})().catch(e=>{console.error(e.message);process.exitCode=1});`,
        ],
        input: "",
      };
    });

    const message = {
      id: task.id,
      request_id: randomUUID(),
      content: "Okay, fix the review findings",
      configuration: {
        provider: "codex" as const,
        access: "workspace" as const,
        config: { model: "next-model", effort: "high", timeout_secs: 30 },
      },
    };

    engine.chat(message);
    engine.chat(message);
    await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false), { timeout: 15000 });
    const detail = engine.db.detail(task.id);
    expect(requests).toHaveLength(1);

    expect(requests[0]).toMatchObject({
      stage: 3,
      config: message.configuration.config,
      conversation: {},
    });

    expect(requests[0].prompt).toContain("Fixture final review");
    expect(requests[0].prompt).toContain("Okay, fix the review findings");

    expect(detail.runs.at(-1), String(detail.runs.at(-1)?.error || "Chat result")).toMatchObject({
      purpose: "Workspace conversation",
      status: fail ? "failed" : "completed",
      effort: "high",
    });

    expect(detail.runs).toHaveLength(5);
    expect(detail.artifacts).toEqual(artifacts);

    expect(detail.task, String(detail.runs.at(-1)?.error || "Chat result")).toMatchObject({
      stage: 6,
      status: "reviewed_with_gaps",
    });

    expect(detail.task.final_review_hash).toBeUndefined();
    expect(detail.task.final_review_verdict).toBeUndefined();
    expect(await readFile(join(repo.path, "source.txt"), "utf8")).toBe("base\n");

    expect(await readFile(join(detail.task.worktree_path, "source.txt"), "utf8")).toBe(
      "Fixed in chat\n",
    );

    await expect(new Rpc(engine).call("task.complete", { id: task.id })).rejects.toThrow();
  },
);

it.each([
  "what ide am i using",
  "who are you",
  "what app is this?",
  "wassup and who are you and what ide am i using?",
])("routes the complete app question through a lightweight provider turn: %s", (content) => {
  expect(isConversationOnly(content)).toBe(true);
  expect(isConversationOnly(`${content} and fix source.txt`)).toBe(false);
});

it("refuses workspace access before review without saving or executing the message", async () => {
  const { repo } = await fixtureRepository(engine, directory);

  const task = engine.enqueue(
    repo,
    parseIssue("https://github.com/fixture/fixture/issues/1"),
    "Task A",
    "",
    {},
  );

  expect(() =>
    engine.chat({
      id: task.id,
      request_id: randomUUID(),
      content: "Make changes now",
      configuration: {
        provider: "codex",
        access: "workspace",
        config: { model: "next-model", effort: "low", timeout_secs: 30 },
      },
    }),
  ).toThrow("after final review");

  expect(engine.db.detail(task.id).messages).toEqual([]);
});

it("keeps legacy read-only chat read-only after review and preserves the reviewed fingerprint", async () => {
  const { task } = await reviewTask();
  await waitForTask(engine, task.id, (status) => status === "ready_for_review");
  await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false));
  const hash = engine.db.task(task.id).final_review_hash;
  const requests: AgentRunRequest[] = [];

  vi.spyOn(provider, "invocation").mockImplementation((request) => {
    requests.push(request);
    return {
      program: process.execPath,
      input: "",
      args: [
        "-e",
        `(async()=>{let refused=false;try{await require('node:fs/promises').writeFile('source.txt','forbidden')}catch{refused=true}if(!refused)throw Error('Legacy read-only request received write access');console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'The reviewed files remain unchanged.'}}));console.log(JSON.stringify({type:'turn.completed'}));})().catch(e=>{console.error(e.message);process.exitCode=1});`,
      ],
    };
  });

  engine.chat({
    id: task.id,
    request_id: randomUUID(),
    content: "Explain the result without editing",
    configuration: {
      provider: "codex",
      config: { model: "next-model", effort: "low", timeout_secs: 30 },
    },
  });

  await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false), { timeout: 15000 });
  expect(requests[0].stage).toBe(1);

  expect(engine.db.detail(task.id).runs.at(-1)).toMatchObject({
    status: "completed",
    purpose: "Read-only conversation",
  });

  expect(engine.db.task(task.id).final_review_hash).toBe(hash);
  expect(engine.db.task(task.id).status).toBe("ready_for_review");
});
