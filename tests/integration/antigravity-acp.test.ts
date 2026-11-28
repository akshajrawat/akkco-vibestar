import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { NormalizedEvent } from "../../apps/core/domain";
import { antigravityAcpConversation } from "../../apps/core/execution/providers/antigravity-acp";
import { AntigravityProvider } from "../../apps/core/execution/providers/antigravity";
import { Rpc } from "../../apps/core/rpc";
import { createFixtureEngine, detectFixtureProvider } from "../helpers/fixtures";
import { testProfileIds } from "../helpers/viber-fixtures";
import type { AgentRunRequest } from "../../apps/core/execution/providers/contracts";
import { execute } from "../../apps/core/execution/runtime/process";

const hasAgy = () => {
  try {
    const res = spawnSync("which", ["agy"], { encoding: "utf8" });
    return res.status === 0 && res.stdout.trim().length > 0;
  } catch {
    return false;
  }
};

describe("Antigravity ACP Integration", () => {
  it("executes full synthetic ACP lifecycle with streaming tool loop and resume", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibestar-acp-test-"));
    const acceptedIds: string[] = [];
    const recalledIds: string[] = [];

    // Synthetic ACP server script speaking protocol v1
    const serverScript = `
      const readline = require('node:readline');
      const emit = msg => console.log(JSON.stringify(msg));
      const rl = readline.createInterface({ input: process.stdin });

      let currentSessionId = 'acp-synthetic-session-1';

      rl.on('line', line => {
        let req;
        try { req = JSON.parse(line); } catch { return; }

        if (req.method === 'initialize') {
          emit({
            jsonrpc: '2.0',
            id: req.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: {
                loadSession: true,
                sessionCapabilities: { resume: {}, load: {} }
              },
              agentInfo: { name: 'Synthetic ACP Server', version: '1.0.0' }
            }
          });
        } else if (req.method === 'notifications/initialized') {
          // Client acknowledgement
        } else if (req.method === 'session/new') {
          emit({
            jsonrpc: '2.0',
            id: req.id,
            result: { sessionId: currentSessionId }
          });
        } else if (req.method === 'session/resume') {
          if (req.params.sessionId !== currentSessionId) {
            emit({
              jsonrpc: '2.0',
              id: req.id,
              error: { code: -32603, message: 'Session not found: ' + req.params.sessionId }
            });
            return;
          }
          emit({
            jsonrpc: '2.0',
            id: req.id,
            result: { sessionId: currentSessionId }
          });
        } else if (req.method === 'session/set_mode') {
          emit({ jsonrpc: '2.0', id: req.id, result: {} });
        } else if (req.method === 'session/set_model') {
          emit({ jsonrpc: '2.0', id: req.id, result: {} });
        } else if (req.method === 'session/set_config_option') {
          emit({ jsonrpc: '2.0', id: req.id, result: {} });
        } else if (req.method === 'session/prompt') {
          // Emit tool call
          emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: currentSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'call-read-1',
                name: 'read_file',
                kind: 'read',
                args: { Path: 'test.txt' }
              }
            }
          });

          // Emit tool update
          emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: currentSessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'call-read-1',
                name: 'read_file',
                kind: 'read',
                status: 'completed',
                output: 'hello from test.txt'
              }
            }
          });

          // Emit streaming message chunk
          emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: currentSessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'I read test.txt successfully.' }
              }
            }
          });

          // End prompt turn
          emit({
            jsonrpc: '2.0',
            id: req.id,
            result: { stopReason: 'end_turn' }
          });
        }
      });
    `;

    try {
      // First turn: New session
      const runRequest1: AgentRunRequest = {
        runId: "run-turn-1",
        cwd: tempDir,
        stage: 1,
        access: "workspace-write",
        config: { model: "gemini-2.5-pro", effort: "high", timeout_secs: 15 },
        prompt: "Please read test.txt",
        schemaPath: "/artifacts/schema.json",
        schema: { type: "object" },
        conversation: {},
        viberMemory: {
          onInputAccepted: (id) => {
            acceptedIds.push(id);
          },
        },
      };

      const invocation1 = antigravityAcpConversation(runRequest1);

      const parsedEvents1: NormalizedEvent[] = [];
      let foundSessionId: string | null = null;

      const result1 = await execute({
        program: process.execPath,
        args: ["-e", serverScript],
        cwd: tempDir,
        inputProtocol: invocation1.inputProtocol,
        onLine: (stream, line) => {
          if (stream === "stdout") {
            const raw = JSON.parse(line);
            foundSessionId = invocation1.conversationId(raw) ?? foundSessionId;
            parsedEvents1.push(...invocation1.normalize(raw));
          }
        },
      });

      expect(result1.code).toBe(0);
      expect(acceptedIds).toEqual(["acp-synthetic-session-1"]);

      expect(parsedEvents1.some((e) => e.kind === "file.read")).toBe(true);

      expect(
        parsedEvents1.some((e) => {
          if (e.kind !== "message") {
            return false;
          }

          const data =
            typeof e.data === "object" && e.data !== null
              ? (e.data as Record<string, unknown>)
              : {};

          return typeof data.text_delta === "string" && data.text_delta.includes("I read test.txt");
        }),
      ).toBe(true);

      expect(parsedEvents1.some((e) => e.kind === "run.completed")).toBe(true);

      expect(foundSessionId).toBe("acp-synthetic-session-1");

      // Second turn: Resume existing session
      const runRequest2: AgentRunRequest = {
        runId: "run-turn-2",
        cwd: tempDir,
        stage: 1,
        access: "read-only",
        config: { model: "gemini-2.5-pro", effort: "low", timeout_secs: 15 },
        prompt: "Follow up question",
        schemaPath: "/artifacts/schema.json",
        schema: { type: "object" },
        conversation: { threadId: foundSessionId! },
        viberMemory: {
          recall: (id) => {
            if (id) {
              recalledIds.push(id);
            }

            return ["User prefers concise answers."];
          },
          onInputAccepted: (id) => {
            acceptedIds.push(id);
          },
        },
      };

      const invocation2 = antigravityAcpConversation(runRequest2);
      const capturedLines2: string[] = [];

      const result2 = await execute({
        program: process.execPath,
        args: ["-e", serverScript],
        cwd: tempDir,
        inputProtocol: invocation2.inputProtocol,
        onLine: (stream, line) => {
          if (stream === "stdout") {
            capturedLines2.push(line);
          }
        },
      });

      expect(result2.code).toBe(0);
      expect(recalledIds).toEqual(["acp-synthetic-session-1"]);
      expect(acceptedIds).toEqual(["acp-synthetic-session-1", "acp-synthetic-session-1"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("cancels outstanding permission requests and closes stdin on the cancelled prompt reply", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibestar-acp-cancel-"));

    const cancelScript = `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const readline = require('node:readline');
      const emit = msg => console.log(JSON.stringify(msg));
      const rl = readline.createInterface({ input: process.stdin });
      let prompts = 0;
      const permissionIds = new Set([99, 'permission-2']);

      process.on('SIGINT', () => {
        fs.appendFileSync('cancel.marker', ' and signalled');
        process.exit(1);
      });

      rl.on('line', line => {
        let req;
        try { req = JSON.parse(line); } catch { return; }

        if (req.method === 'initialize') {
          emit({
            jsonrpc: '2.0',
            id: req.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: { sessionCapabilities: { resume: {} } }
            }
          });
        } else if (req.method === 'session/new') {
          emit({ jsonrpc: '2.0', id: req.id, result: { sessionId: 'cancel-session' } });
        } else if (req.method === 'session/set_mode') {
          emit({ jsonrpc: '2.0', id: req.id, result: {} });
        } else if (req.method === 'session/set_model') {
          emit({ jsonrpc: '2.0', id: req.id, result: {} });
        } else if (req.method === 'session/set_config_option') {
          emit({ jsonrpc: '2.0', id: req.id, result: {} });
        } else if (req.method === 'session/prompt') {
          assert.equal(++prompts, 1);
          emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'cancel-session',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Processing long calculation...' }
              }
            }
          });
          for (const id of permissionIds) {
            emit({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId: 'cancel-session' } });
          }
        } else if (req.method === 'session/cancel') {
          fs.writeFileSync('cancel.marker', 'received');
          emit({ jsonrpc: '2.0', id: 6, result: { stopReason: 'end_turn' } });
        } else if (permissionIds.delete(req.id)) {
          assert.deepEqual(req.result, { outcome: { outcome: 'cancelled' } });
          fs.appendFileSync('cancel.marker', ' and cancelled permission');
          if (!permissionIds.size) {
            emit({ jsonrpc: '2.0', id: 6, result: { stopReason: 'cancelled' } });
          }
        }
      });
      rl.on('close', () => fs.appendFileSync('cancel.marker', ' and closed stdin'));
    `;

    try {
      const abortController = new AbortController();

      const runRequest: AgentRunRequest = {
        runId: "run-cancel",
        cwd: tempDir,
        stage: 1,
        access: "read-only",
        config: { model: "gemini-2.5-pro", effort: "default", timeout_secs: 10 },
        prompt: "Perform long running task",
        schemaPath: "/artifacts/schema.json",
        schema: { type: "object" },
        conversation: {},
      };

      const invocation = antigravityAcpConversation(runRequest);
      const events: NormalizedEvent[] = [];

      // Abort after first update is received
      const execPromise = execute({
        program: process.execPath,
        args: ["-e", cancelScript],
        cwd: tempDir,
        signal: abortController.signal,
        inputProtocol: invocation.inputProtocol,
        onLine: (stream, line) => {
          if (stream === "stdout") {
            events.push(...invocation.normalize(JSON.parse(line)));
          }

          if (line.includes("agent_message_chunk")) {
            abortController.abort();
          }
        },
      });

      await expect(execPromise).rejects.toMatchObject({ kind: "cancelled" });

      expect(await readFile(join(tempDir, "cancel.marker"), "utf8")).toBe(
        "received and cancelled permission and cancelled permission and closed stdin",
      );

      expect(events.map(({ kind }) => kind)).toEqual(["run.started", "message"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it.skipIf(process.env.VIBESTAR_TEST_SIGNED_IN_AGY !== "1" || !hasAgy())(
    "negotiates ACP v1 and creates a session with the signed-in agy binary",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "vibestar-acp-real-"));
      const abortController = new AbortController();
      let sessionId: string | null = null;

      const runRequest: AgentRunRequest = {
        runId: "real-agy-acp-smoke",
        cwd: tempDir,
        stage: 1,
        access: "read-only",
        config: { model: "gemini-3.8-flash-high", effort: "high", timeout_secs: 20 },
        prompt: "Hello ACP",
        schemaPath: "/artifacts/schema.json",
        schema: { type: "object" },
        conversation: {},
      };

      const invocation = antigravityAcpConversation(runRequest);

      try {
        const execPromise = execute({
          ...invocation,
          cwd: tempDir,
          signal: abortController.signal,
          timeoutMs: 20000,
          onLine: (stream, line) => {
            if (stream === "stdout") {
              sessionId = invocation.conversationId(JSON.parse(line));
              if (sessionId) {
                abortController.abort();
              }
            }
          },
        });

        await expect(execPromise).rejects.toMatchObject({ kind: "cancelled" });
        expect(sessionId).toEqual(expect.any(String));
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    30000,
  );
});

it.each(["missing", "unavailable"])(
  "saves interleaved text and handles a saved ACP session that is %s on Continue",
  async (loadFailure) => {
    const directory = await mkdtemp(join(tmpdir(), "vibestar-acp-runner-"));

    let stopTurn = false;
    let rejectLoad = false;
    const requests: AgentRunRequest[] = [];

    const script = `
    const [newSessionId, stopTurn, rejectLoad, loadFailure] = process.argv.slice(1);
    let sessionId;
    const rl = require("node:readline").createInterface({ input: process.stdin });
    const emit = (raw) => console.log(JSON.stringify({ jsonrpc: "2.0", ...raw }));
    rl.on("line", (line) => {
      const { method, id, params } = JSON.parse(line);
      switch (method) {
        case "initialize":
          emit({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
          break;
        case "session/new":
          sessionId = newSessionId;
          emit({ id, result: { sessionId } });
          break;
        case "session/load":
          sessionId = params.sessionId;
          emit({ method: "session/update", params: {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: "replayed history" },
          } });
          emit({ method: "session/update", params: {
            sessionId,
            update: { sessionUpdate: "usage_update", inputTokens: 999 },
          } });
          if (rejectLoad === "true") {
            emit({ id, error: loadFailure === "missing"
              ? { code: -32002, message: "Resource not found", data: { sessionId } }
              : { code: -32603, message: "Session storage unavailable" },
            });
          } else {
            emit({ id, result: {} });
          }
          break;
        case "session/set_mode":
        case "session/set_model":
        case "session/set_config_option":
          emit({ id, result: {} });
          break;
        case "session/cancel":
          emit({ id: 6, result: { stopReason: "cancelled" } });
          break;
        case "session/prompt":
          emit({ method: "session/update", params: {
            sessionId,
            update: { sessionUpdate: "usage_update", outputTokens: 7 },
          } });
          if (stopTurn === "true") break;
          for (const [messageId, text] of [["A", "First"], ["A", " segment"], ["B", "Second"], ["A", "Third"]]) {
            emit({ method: "session/update", params: {
              sessionId,
              update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } },
            } });
          }
          emit({ id, result: { stopReason: "end_turn" } });
          break;
      }
    });
  `;

    const engine = await createFixtureEngine(join(directory, "data"), () => {
      const adapter = new AntigravityProvider();
      return {
        ...adapter,
        detect: async () => ({
          ...(await detectFixtureProvider()),
          provider: "antigravity",
          capabilities: ["native-conversations", "acp"],
        }),
        invocation: (request) => {
          requests.push(request);
          return {
            ...adapter.invocation(request),
            program: process.execPath,
            args: ["-e", script, request.runId, String(stopTurn), String(rejectLoad), loadFailure],
          };
        },
      };
    });

    const rpc = new Rpc(engine);
    try {
      const profileId = testProfileIds.reviewer;
      const selection = { provider: "antigravity" as const, model: "next-model", effort: "high" };

      const session = await engine.viberSessions.store.create({
        request_id: randomUUID(),
        profile_id: profileId,
        selection,
      });

      const scope = { session_id: session.id, profile_id: profileId };

      const send = (content: string, extra = {}) =>
        rpc.call("viber.session.send", {
          ...scope,
          request_id: randomUUID(),
          content,
          history_ids: [],
          selection,
          ...extra,
        });

      const detail = () => engine.viberSessions.store.detail(session.id, profileId);
      const thread = () => engine.viberSessions.store.session(session.id, profileId).thread;

      const settled = async (status: string) => {
        await expect
          .poll(() =>
            detail()
              .messages.filter(({ role }) => role === "user")
              .at(-1),
          )
          .toMatchObject({ status });

        await expect.poll(() => engine.isActive(`viber:${session.id}`)).toBe(false);
      };

      await send("Stream several assistant segments");
      await settled("completed");

      expect(detail().messages.at(-1)).toMatchObject({
        role: "assistant",
        content: "First segment\n\nSecond\n\nThird",
      });

      const threadId = requests[0].runId;
      expect(thread()).toMatchObject({ thread_id: threadId, protocol: "acp" });

      const stoppedId = randomUUID();
      stopTurn = true;
      await send("Original request to resume", { request_id: stoppedId });

      await expect
        .poll(() => {
          const runId = requests.at(-1)?.runId;
          return runId !== threadId
            ? engine.db.all<{ conversation_id: string | null }>(
                "SELECT conversation_id FROM utility_runs WHERE id=?",
                runId,
              )[0]?.conversation_id
            : null;
        })
        .toBe(threadId);

      await rpc.call("viber.session.cancel", scope);
      await settled("cancelled");

      const log = () =>
        readFile(
          join(engine.root, "logs", `viber-${session.id}`, `${requests.at(-1)?.runId}.jsonl`),
          "utf8",
        );

      const stoppedLog = await log();
      expect(stoppedLog).toContain('"id":2,"result":{}');
      expect(stoppedLog).not.toMatch(/replayed history|"inputTokens":999/);

      expect(
        engine.db.all("SELECT input_tokens FROM ai_usage WHERE id=?", requests[1].runId),
      ).toEqual([{ input_tokens: null }]);

      rejectLoad = true;
      stopTurn = false;

      await send("Continue where you left off.", {
        continue_message_id: stoppedId,
        selection: undefined,
        acknowledge_uncertain: true,
      });

      if (loadFailure === "missing") {
        await settled("completed");
        expect(requests).toHaveLength(4);
        expect(requests[2].conversation).toMatchObject({ threadId, confirmResume: true });
        expect(requests[3].conversation).toEqual({ protocol: "acp" });
        expect(requests[3].prompt).toContain("Original request to resume");
        expect(thread()?.thread_id).toBe(requests[3].runId);
        expect(await log()).toContain('"text":"First"');

        expect(
          engine.db.all(
            "SELECT input_tokens,output_tokens FROM ai_usage WHERE id=?",
            requests[3].runId,
          ),
        ).toEqual([{ input_tokens: null, output_tokens: 7 }]);
      } else {
        await settled("failed");
        expect(requests).toHaveLength(3);
        expect(thread()?.thread_id).toBe(threadId);

        expect(
          engine.db.all("SELECT conversation_id FROM utility_runs WHERE id=?", requests[2].runId),
        ).toEqual([{ conversation_id: null }]);
      }

      expect(await log()).not.toMatch(/replayed history|"inputTokens":999/);
    } finally {
      await rpc.close();
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
