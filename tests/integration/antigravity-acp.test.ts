import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  antigravityAcpConversation,
  antigravityAcpConversationId,
  antigravityAcpNormalize,
} from "../../apps/core/execution/providers/antigravity-acp";
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

      const capturedLines1: string[] = [];

      const result1 = await execute({
        program: process.execPath,
        args: ["-e", serverScript],
        cwd: tempDir,
        inputProtocol: invocation1.inputProtocol,
        onLine: (stream, line) => {
          if (stream === "stdout") {
            capturedLines1.push(line);
          }
        },
      });

      expect(result1.code).toBe(0);
      expect(acceptedIds).toEqual(["acp-synthetic-session-1"]);

      // Verify normalization of all emitted events
      const parsedEvents1 = capturedLines1
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .flatMap((msg) => antigravityAcpNormalize(msg));

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

      // Verify conversation identity extraction
      const foundSessionId = capturedLines1
        .map((line) => antigravityAcpConversationId(JSON.parse(line)))
        .find((id): id is string => typeof id === "string" && id.length > 0);

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
        conversation: { threadId: foundSessionId },
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

  it("handles prompt cancellation through process execute with session/cancel", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibestar-acp-cancel-"));

    const cancelScript = `
      const fs = require('node:fs');
      const readline = require('node:readline');
      const emit = msg => console.log(JSON.stringify(msg));
      const rl = readline.createInterface({ input: process.stdin });

      process.on('SIGINT', () => {
        // Allow in-flight stdin cancel to be processed
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
        } else if (req.method === 'session/cancel') {
          fs.writeFileSync('cancel.marker', 'received');
          emit({ jsonrpc: '2.0', id: 6, result: { stopReason: 'cancelled' } });
          process.exit(0);
        }
      });
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

      // Abort after first update is received
      const execPromise = execute({
        program: process.execPath,
        args: ["-e", cancelScript],
        cwd: tempDir,
        signal: abortController.signal,
        inputProtocol: invocation.inputProtocol,
        onLine: (_stream, line) => {
          if (line.includes("agent_message_chunk")) {
            abortController.abort();
          }
        },
      });

      await expect(execPromise).rejects.toThrow();
      const markerPath = join(tempDir, "cancel.marker");
      const { existsSync } = await import("node:fs");
      expect(existsSync(markerPath)).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it.skipIf(!hasAgy())(
    "runs real agy acp stdio smoke test against local binary",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "vibestar-acp-real-"));
      const abortController = new AbortController();
      const capturedStdout: string[] = [];

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
          program: "agy",
          args: ["acp", "--sandbox"],
          cwd: tempDir,
          signal: abortController.signal,
          inputProtocol: invocation.inputProtocol,
          onLine: (stream, line) => {
            if (stream === "stdout") {
              capturedStdout.push(line);
              // Once prompt or session update is dispatched, abort cleanly
              if (line.includes('"sessionId":') || line.includes("session/update")) {
                abortController.abort();
              }
            }
          },
        });

        // The execution will abort cleanly after observing real ACP server initialization & session setup
        await expect(execPromise).rejects.toThrow();

        // Check captured lines for real ACP protocol responses
        const hasInitResponse = capturedStdout.some((l) => l.includes('"protocolVersion":1'));
        const hasSessionCreated = capturedStdout.some((l) => l.includes('"sessionId":'));

        expect(hasInitResponse).toBe(true);
        expect(hasSessionCreated).toBe(true);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    30000,
  );
});
