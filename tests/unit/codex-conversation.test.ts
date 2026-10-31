import { expect, it } from "vitest";

import { codexConversation } from "../../backend/execution/providers/codex-conversation";
import { CodexProvider } from "../../backend/execution/providers/codex";
import { execute } from "../../backend/execution/runtime/process";
import type { AgentRunRequest } from "../../backend/execution/providers/contracts";

const request: AgentRunRequest = {
  runId: "run",
  cwd: process.cwd(),
  stage: 1,
  config: { model: "requested-model", effort: "low", timeout_secs: 10 },
  prompt: "hello",
  schemaPath: "/schema",
  schema: { type: "object" },
  conversation: {},
};

it.each([undefined, "saved-thread"])(
  "starts or resumes exactly one authorized chat turn (%s)",
  (threadId) => {
    const messages: Record<string, unknown>[] = [];
    let ended = false;
    const invocation = codexConversation({ ...request, conversation: { threadId } });
    expect(invocation.args).toContain("app-server");
    expect(invocation.isolateProviderConfig).toBe(true);

    invocation.inputProtocol.start(
      (message) => messages.push(message as Record<string, unknown>),
      () => {
        ended = true;
      },
    );

    expect(messages.map((message) => message.method)).toEqual(["initialize"]);
    invocation.inputProtocol.receive(JSON.stringify({ id: 0, result: {} }));

    expect(messages[2]).toMatchObject({
      method: threadId ? "thread/resume" : "thread/start",
      params: { cwd: request.cwd, sandbox: "read-only", approvalPolicy: "never" },
    });

    invocation.inputProtocol.receive(
      JSON.stringify({ id: 1, result: { thread: { id: "real-thread" } } }),
    );

    expect(messages[3]).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "real-thread",
        model: "requested-model",
        sandboxPolicy: { type: "readOnly" },
        input: [{ type: "text", text: "hello" }],
      },
    });

    expect(messages[3].params).not.toHaveProperty("outputSchema");

    invocation.inputProtocol.receive(
      JSON.stringify({ method: "item/commandExecution/requestApproval", id: 99, params: {} }),
    );

    expect(messages.at(-1)).toMatchObject({ id: 99, error: { code: -32601 } });

    invocation.inputProtocol.receive(
      JSON.stringify({ method: "turn/completed", params: { turn: { status: "completed" } } }),
    );

    expect(ended).toBe(true);
    const length = messages.length;

    invocation.inputProtocol.receive(
      JSON.stringify({ id: 1, result: { thread: { id: "another" } } }),
    );

    expect(messages).toHaveLength(length);
  },
);

it("streams official app-server events through existing persisted provider contracts", () => {
  const provider = new CodexProvider();
  expect(provider.conversationId({ id: 1, result: { thread: { id: "thread" } } })).toBe("thread");

  expect(
    provider.normalize({
      method: "item/agentMessage/delta",
      params: { itemId: "message", delta: "hello" },
    }),
  ).toMatchObject([{ kind: "message", data: { call_id: "message", text_delta: "hello" } }]);

  expect(
    provider.normalize({
      method: "item/completed",
      params: {
        item: {
          id: "command",
          type: "commandExecution",
          command: "npm test",
          exitCode: 1,
          status: "failed",
          aggregatedOutput: "assertion failure",
        },
      },
    }),
  ).toMatchObject([
    {
      kind: "command.finished",
      data: { exit_code: 1, stdout: "assertion failure", status: "failed" },
    },
  ]);

  expect(
    provider.result({
      method: "item/completed",
      params: { item: { type: "agentMessage", text: '{"summary":"hello"}' } },
    }),
  ).toEqual({ summary: "hello" });

  expect(
    provider.normalize({ method: "turn/completed", params: { turn: { status: "interrupted" } } })[0]
      .kind,
  ).toBe("run.failed");
});

it("fails closed on protocol errors and unknown turn outcomes", () => {
  const protocol = codexConversation(request).inputProtocol;

  protocol.start(
    () => {},
    () => {},
  );

  expect(() => protocol.receive('{"id":0,"error":{"message":"authentication revoked"}}')).toThrow(
    "authentication revoked",
  );

  protocol.receive('{"id":0,"result":{}}');
  protocol.receive('{"id":1,"result":{"thread":{"id":"thread"}}}');

  expect(() =>
    protocol.receive('{"method":"turn/completed","params":{"turn":{"status":"unknown"}}}'),
  ).toThrow("unknown turn outcome");
});

it("keeps a provider's reported transport retry separate from a failed turn", () => {
  const provider = new CodexProvider();

  expect(
    provider.normalize({
      method: "error",
      params: { willRetry: true, error: { message: "Connection interrupted; retrying" } },
    }),
  ).toMatchObject([
    {
      kind: "analysis.status",
      data: { status: "retrying", text: "Connection interrupted; retrying" },
    },
  ]);

  expect(
    provider.normalize({
      method: "error",
      params: { willRetry: false, error: { message: "Request failed" } },
    })[0].kind,
  ).toBe("run.failed");
});

it("keeps stdin open through the real process transport and closes after one completed turn", async () => {
  const conversation = codexConversation(request);
  const lines: string[] = [];

  const output = await execute({
    program: process.execPath,
    cwd: process.cwd(),
    timeoutMs: 5000,
    inputProtocol: conversation.inputProtocol,
    args: [
      "-e",
      `
      const readline=require('node:readline');
      readline.createInterface({input:process.stdin}).on('line',line=>{
        const r=JSON.parse(line);
        if(r.method==='initialize')console.log(JSON.stringify({id:r.id,result:{}}));
        else if(r.method==='thread/start')console.log(JSON.stringify({id:r.id,result:{thread:{id:'inert-thread'}}}));
        else if(r.method==='turn/start'){
          console.log(JSON.stringify({method:'item/agentMessage/delta',params:{itemId:'answer',delta:'hello'}}));
          console.log(JSON.stringify({method:'turn/completed',params:{turn:{status:'completed'}}}));
        }
      });
    `,
    ],
    onLine: (stream, line) => {
      if (stream === "stdout") lines.push(line);
    },
  });

  expect(output.code).toBe(0);
  expect(lines.some((line) => line.includes("hello"))).toBe(true);
});

it("counts only this turn's reported usage when a resumed thread has older totals", async () => {
  const { Database } = await import("../../backend/storage/database");
  const { Usage } = await import("../../backend/execution/output/usage");
  const db = new Database(":memory:");
  try {
    const usage = new Usage(db);

    usage.start("run", {
      task_id: null,
      job_id: null,
      repository: null,
      purpose: "chat",
      provider: "codex",
      model: "fixture",
      effort: "low",
    });

    const observe = (total: number, last: number) =>
      usage.observe("run", {
        method: "thread/tokenUsage/updated",
        params: { tokenUsage: { total: { inputTokens: total }, last: { inputTokens: last } } },
      });

    observe(1000, 12);
    observe(1007, 7);
    observe(1007, 7);

    expect(usage.list()[0]).toMatchObject({
      input_tokens: 19,
      output_tokens: null,
      total_tokens: null,
    });
  } finally {
    db.close();
  }
});

it("interrupts an owned app-server process during handshake without dispatching another turn", async () => {
  const controller = new AbortController();
  const messages: string[] = [];

  await expect(
    execute({
      program: process.execPath,
      cwd: process.cwd(),
      signal: controller.signal,
      timeoutMs: 5000,
      inputProtocol: codexConversation(request).inputProtocol,
      args: [
        "-e",
        `require('node:readline').createInterface({input:process.stdin}).on('line',line=>console.log(JSON.stringify({type:'handshake',received:JSON.parse(line).method})));`,
      ],
      onLine: (_stream, line) => {
        messages.push(line);
        controller.abort();
      },
    }),
  ).rejects.toThrow("Run cancelled");

  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("initialize");
});

it("limits writable chat turns to the task workspace in both thread and turn policy", () => {
  const messages: Record<string, unknown>[] = [];
  const protocol = codexConversation({ ...request, stage: 3 }).inputProtocol;

  protocol.start(
    (message) => messages.push(message as Record<string, unknown>),
    () => {},
  );

  protocol.receive('{"id":0,"result":{}}');
  protocol.receive('{"id":1,"result":{"thread":{"id":"chat-fix"}}}');

  expect(messages[2]).toMatchObject({
    params: { sandbox: "workspace-write", approvalPolicy: "never" },
  });

  expect(messages[3]).toMatchObject({
    params: {
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [request.cwd], networkAccess: true },
    },
  });

  expect(messages[3].params).not.toHaveProperty("outputSchema");
});

it.each(["item/started", "item/completed"])(
  "keeps %s user-message echoes out of tool activity",
  (method) => {
    expect(
      new CodexProvider().normalize({
        method,
        params: {
          item: { id: "user", type: "userMessage", content: [{ type: "text", text: "hi" }] },
        },
      }),
    ).toEqual([]);
  },
);
