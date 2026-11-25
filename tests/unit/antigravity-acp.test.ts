import { describe, expect, it, vi } from "vitest";

import { AdeError } from "../../apps/core/domain";
import {
  antigravityAcpConversation,
  antigravityAcpNormalize,
} from "../../apps/core/execution/providers/antigravity-acp";
import type { AgentRunRequest } from "../../apps/core/execution/providers/contracts";

const baseRequest: AgentRunRequest = {
  runId: "run-1",
  cwd: "/workspace",
  stage: 1,
  access: "read-only",
  config: { model: "gemini-2.5-pro", effort: "high", timeout_secs: 30 },
  prompt: "Investigate ACP support",
  schemaPath: "/artifacts/schema.json",
  schema: { type: "object" },
  conversation: {},
};

describe("antigravityAcpConversation protocol", () => {
  it("negotiates ACP initialize and creates a new session with plan mode", () => {
    const sent: unknown[] = [];
    let closed = false;
    const accepted: string[] = [];

    const invocation = antigravityAcpConversation({
      ...baseRequest,
      access: "read-only",
      config: { model: "gemini-2.5-pro", effort: "medium", timeout_secs: 30 },
      viberMemory: {
        onInputAccepted: (id) => {
          accepted.push(id);
        },
      },
    });

    invocation.inputProtocol.start(
      (msg) => {
        sent.push(msg);
      },
      () => {
        closed = true;
      },
    );

    expect(sent[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1 },
    });

    const receive = (msg: unknown) => {
      invocation.inputProtocol.receive(JSON.stringify(msg));
    };

    // Agent response to initialize
    receive({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          sessionCapabilities: { resume: {}, load: {} },
        },
      },
    });

    // Expect notifications/initialized followed by session/new
    expect(sent[1]).toMatchObject({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    expect(sent[2]).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: "/workspace", mcpServers: [] },
    });

    // Agent response to session/new
    receive({
      jsonrpc: "2.0",
      id: 2,
      result: { sessionId: "sess-123" },
    });

    // Mode is set to "plan" for read-only access
    expect(sent[3]).toMatchObject({
      jsonrpc: "2.0",
      id: 3,
      method: "session/set_mode",
      params: { sessionId: "sess-123", modeId: "plan" },
    });

    // Confirm mode setting
    receive({
      jsonrpc: "2.0",
      id: 3,
      result: {},
    });

    // Model set
    expect(sent[4]).toMatchObject({
      jsonrpc: "2.0",
      id: 4,
      method: "session/set_model",
      params: { sessionId: "sess-123", modelId: "gemini-2.5-pro" },
    });

    // Confirm model setting
    receive({
      jsonrpc: "2.0",
      id: 4,
      result: {},
    });

    // Config option set for thought_level
    expect(sent[5]).toMatchObject({
      jsonrpc: "2.0",
      id: 5,
      method: "session/set_config_option",
      params: { sessionId: "sess-123", configId: "thought_level", value: "medium" },
    });

    // Confirm config option setting
    receive({
      jsonrpc: "2.0",
      id: 5,
      result: {},
    });

    // Prompt dispatched
    expect(sent[6]).toMatchObject({
      jsonrpc: "2.0",
      id: 6,
      method: "session/prompt",
      params: {
        sessionId: "sess-123",
        prompt: [{ type: "text", text: expect.stringContaining("Investigate ACP support") }],
      },
    });

    // First session update marks input accepted once
    receive({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-123",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello" },
        },
      },
    });

    expect(accepted).toEqual(["sess-123"]);

    // Subsequent updates do not re-accept
    receive({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-123",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: " world" },
        },
      },
    });

    expect(accepted).toHaveLength(1);

    // Prompt turn ends
    receive({
      jsonrpc: "2.0",
      id: 6,
      result: { stopReason: "end_turn" },
    });

    expect(closed).toBe(true);
  });

  it("sets accept-edits mode for workspace-write access", () => {
    const sent: unknown[] = [];

    const invocation = antigravityAcpConversation({
      ...baseRequest,
      access: "workspace-write",
      config: { model: "gemini-2.5-pro", effort: "default", timeout_secs: 30 },
    });

    invocation.inputProtocol.start(
      (msg) => {
        sent.push(msg);
      },
      () => {},
    );

    const receive = (msg: unknown) => {
      invocation.inputProtocol.receive(JSON.stringify(msg));
    };

    receive({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { resume: {} } },
      },
    });

    receive({
      jsonrpc: "2.0",
      id: 2,
      result: { sessionId: "sess-write" },
    });

    expect(sent[3]).toMatchObject({
      jsonrpc: "2.0",
      id: 3,
      method: "session/set_mode",
      params: { sessionId: "sess-write", modeId: "accept-edits" },
    });

    receive({
      jsonrpc: "2.0",
      id: 3,
      result: {},
    });

    expect(sent[4]).toMatchObject({
      jsonrpc: "2.0",
      id: 4,
      method: "session/set_model",
      params: { sessionId: "sess-write", modelId: "gemini-2.5-pro" },
    });

    receive({
      jsonrpc: "2.0",
      id: 4,
      result: {},
    });

    // Since effort is "default", session/set_config_option is omitted and prompt is sent
    expect(
      sent.some(
        (msg) =>
          typeof msg === "object" &&
          msg !== null &&
          "method" in msg &&
          msg.method === "session/set_config_option",
      ),
    ).toBe(false);

    expect(sent[5]).toMatchObject({
      jsonrpc: "2.0",
      id: 6,
      method: "session/prompt",
      params: { sessionId: "sess-write" },
    });
  });

  it("resumes an existing session via session/resume when advertised", () => {
    const sent: unknown[] = [];
    const recalled: string[] = [];

    const invocation = antigravityAcpConversation({
      ...baseRequest,
      conversation: { threadId: "saved-sess-99" },
      viberMemory: {
        recall: (id) => {
          if (id) {
            recalled.push(id);
          }

          return ["Rule: always write clean code."];
        },
      },
    });

    invocation.inputProtocol.start(
      (msg) => {
        sent.push(msg);
      },
      () => {},
    );

    const receive = (msg: unknown) => {
      invocation.inputProtocol.receive(JSON.stringify(msg));
    };

    receive({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          sessionCapabilities: { resume: {} },
        },
      },
    });

    // Verifies session/resume is invoked with threadId
    expect(sent[2]).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      method: "session/resume",
      params: { sessionId: "saved-sess-99", cwd: "/workspace", mcpServers: [] },
    });

    // Memory recall must NOT be called before session confirmation
    expect(recalled).toEqual([]);

    receive({
      jsonrpc: "2.0",
      id: 2,
      result: { sessionId: "saved-sess-99" },
    });

    receive({ jsonrpc: "2.0", id: 3, result: {} });
    receive({ jsonrpc: "2.0", id: 4, result: {} });
    receive({ jsonrpc: "2.0", id: 5, result: {} });

    // Memory recall called with verified thread ID
    expect(recalled).toEqual(["saved-sess-99"]);

    // Prompt contains recalled facts
    const promptCall = sent.find(
      (m): m is { method: string; params: { prompt: Array<{ text: string }> } } =>
        typeof m === "object" && m !== null && "method" in m && m.method === "session/prompt",
    );

    expect(promptCall?.params.prompt[0].text).toContain("Rule: always write clean code.");
  });

  it("falls back to session/load when resume is not advertised and suppresses replayed updates", () => {
    const sent: unknown[] = [];
    const accepted: string[] = [];

    const invocation = antigravityAcpConversation({
      ...baseRequest,
      conversation: { threadId: "saved-sess-88" },
      viberMemory: {
        onInputAccepted: (id) => {
          accepted.push(id);
        },
      },
    });

    invocation.inputProtocol.start(
      (msg) => {
        sent.push(msg);
      },
      () => {},
    );

    const receive = (msg: unknown) => {
      invocation.inputProtocol.receive(JSON.stringify(msg));
    };

    receive({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: {},
        },
      },
    });

    // Uses session/load
    expect(sent[2]).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      method: "session/load",
      params: { sessionId: "saved-sess-88" },
    });

    const replay = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "saved-sess-88",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Historical replay chunk" },
        },
      },
    };

    expect(invocation.shouldObserveStdout(replay)).toBe(false);
    expect(invocation.normalize(replay)).toEqual([]);
    receive(replay);
    expect(accepted).toEqual([]);

    // session/load completes
    receive({
      jsonrpc: "2.0",
      id: 2,
      result: { sessionId: "saved-sess-88" },
    });

    receive({ jsonrpc: "2.0", id: 3, result: {} });
    receive({ jsonrpc: "2.0", id: 4, result: {} });
    receive({ jsonrpc: "2.0", id: 5, result: {} });

    // Active turn update now triggers input acceptance
    receive({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "saved-sess-88",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "New live chunk" },
        },
      },
    });

    expect(accepted).toEqual(["saved-sess-88"]);
  });

  it.each([1, 2, 3, 4, 5])("rejects a malformed setup response at request %i", (id) => {
    const recall = vi.fn(() => []);

    const invocation = antigravityAcpConversation({
      ...baseRequest,
      conversation: { threadId: "saved", confirmResume: true },
      viberMemory: { recall },
    });

    const send = vi.fn();
    invocation.inputProtocol.start(send, () => {});

    const receive = (response: object) =>
      invocation.inputProtocol.receive(JSON.stringify({ jsonrpc: "2.0", ...response }));

    for (let replyId = 1; replyId < id; replyId++) {
      receive({
        id: replyId,
        result:
          replyId === 1
            ? { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } }
            : {},
      });
    }

    send.mockClear();
    for (const payload of [{}, { result: [] }, { result: null }, { result: {}, error: null }]) {
      expect(() => receive({ id, ...payload })).toThrowError(
        expect.objectContaining({ kind: "provider_failed" }),
      );
    }

    expect(send).not.toHaveBeenCalled();
    expect(recall).not.toHaveBeenCalled();
  });

  it.each([
    { code: -32603, message: "Failed to read session saved: storage unavailable" },
    { code: -32603, message: "Database not found" },
    { code: -32002, message: "MCP server not found" },
  ])("preserves the saved session for ambiguous errors ($message)", (error) => {
    const invocation = antigravityAcpConversation({
      ...baseRequest,
      conversation: { threadId: "saved", confirmResume: true },
    });

    invocation.inputProtocol.start(
      () => {},
      () => {},
    );

    invocation.inputProtocol.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
      }),
    );

    const reply = JSON.stringify({ jsonrpc: "2.0", id: 2, error });
    for (const hook of [invocation.inputProtocol.validate!, invocation.inputProtocol.receive]) {
      expect(() => hook(reply)).toThrowError(expect.objectContaining({ kind: "provider_failed" }));
    }
  });

  it.each(["resume", "load"])(
    "confirms an empty %s response and ignores replay and foreign updates",
    (method) => {
      const accept = vi.fn();

      const invocation = antigravityAcpConversation({
        ...baseRequest,
        conversation: { threadId: "saved" },
        viberMemory: { onInputAccepted: accept },
      });

      invocation.inputProtocol.start(
        () => {},
        () => {},
      );

      const receive = (raw: object) =>
        invocation.inputProtocol.receive(JSON.stringify({ jsonrpc: "2.0", ...raw }));

      const update = (sessionId: string) => ({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: "text" } },
      });

      receive({
        id: 1,
        result: {
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { [method]: {} } },
        },
      });

      receive(update("saved"));
      expect(invocation.conversationId(update("saved"))).toBeNull();
      expect(invocation.normalize(update("saved"))).toEqual([]);

      const reply = { jsonrpc: "2.0", id: 2, result: {} };
      expect(invocation.conversationId(reply)).toBe("saved");

      expect(invocation.normalize(reply)).toEqual([
        { kind: "run.started", data: { conversation_id: "saved" } },
      ]);

      receive(reply);

      for (const id of [3, 4, 5]) {
        receive({ id, result: {} });
      }

      expect(invocation.normalize(update("foreign"))).toEqual([]);
      receive(update("foreign"));
      expect(accept).not.toHaveBeenCalled();
      receive(update("saved"));
      receive(update("saved"));
      expect(accept).toHaveBeenCalledExactlyOnceWith("saved");

      const tool = (data: object) => ({
        ...update("saved"),
        params: { sessionId: "saved", update: { toolCallId: "cmd", ...data } },
      });

      expect(
        invocation.normalize(
          tool({ sessionUpdate: "tool_call", kind: "execute", status: "in_progress" }),
        )[0].kind,
      ).toBe("command.started");

      expect(
        invocation.normalize(tool({ sessionUpdate: "tool_call_update", status: "completed" }))[0]
          .kind,
      ).toBe("command.finished");

      expect(
        invocation.normalize({ jsonrpc: "2.0", id: 6, result: { stopReason: "max_tokens" } }),
      ).toEqual([{ kind: "run.failed", data: { stopReason: "max_tokens" } }]);
    },
  );

  it("throws thread_resume_rejected when saved session is not found", () => {
    const invocation = antigravityAcpConversation({
      ...baseRequest,
      conversation: { threadId: "nonexistent-sess", confirmResume: true },
    });

    invocation.inputProtocol.start(
      () => {},
      () => {},
    );

    invocation.inputProtocol.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { resume: {} } },
        },
      }),
    );

    const errorPayload = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32603, message: "Failed to read session nonexistent-sess: file not found" },
    });

    for (const hook of [invocation.inputProtocol.validate!, invocation.inputProtocol.receive]) {
      expect(() => hook(errorPayload)).toThrowError(
        expect.objectContaining({ kind: "thread_resume_rejected" }),
      );
    }
  });

  it("does NOT throw thread_resume_rejected on post-dispatch prompt turn error", () => {
    const invocation = antigravityAcpConversation({
      ...baseRequest,
      conversation: { threadId: "valid-sess", confirmResume: true },
    });

    invocation.inputProtocol.start(
      () => {},
      () => {},
    );

    invocation.inputProtocol.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { resume: {} } },
        },
      }),
    );

    invocation.inputProtocol.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { sessionId: "valid-sess" },
      }),
    );

    invocation.inputProtocol.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        result: {},
      }),
    );

    invocation.inputProtocol.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        result: {},
      }),
    );

    invocation.inputProtocol.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        result: {},
      }),
    );

    // Prompt turn returns an error
    const promptError = JSON.stringify({
      jsonrpc: "2.0",
      id: 6,
      error: { code: -32000, message: "Rate limit exceeded" },
    });

    try {
      invocation.inputProtocol.receive(promptError);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AdeError);
      expect((err as AdeError).kind).toBe("provider_failed");
    }
  });

  it("actively rejects out-of-band host permission escalation requests with -32601", () => {
    const sent: unknown[] = [];

    const invocation = antigravityAcpConversation({
      ...baseRequest,
    });

    invocation.inputProtocol.start(
      (msg) => {
        sent.push(msg);
      },
      () => {},
    );

    invocation.inputProtocol.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "session/request_permission",
        params: { tool: "bash", command: "rm -rf /" },
      }),
    );

    expect(sent.at(-1)).toMatchObject({
      jsonrpc: "2.0",
      id: 99,
      error: {
        code: -32601,
        message: expect.stringContaining("Out-of-band host permission"),
      },
    });
  });

  it("sends session/cancel on cancel() and cancels prompt gracefully", () => {
    const sent: unknown[] = [];

    const invocation = antigravityAcpConversation({
      ...baseRequest,
      conversation: { threadId: "active-sess" },
    });

    invocation.inputProtocol.start(
      (msg) => {
        sent.push(msg);
      },
      () => {},
    );

    invocation.inputProtocol.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { resume: {} } },
        },
      }),
    );

    invocation.inputProtocol.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { sessionId: "active-sess" },
      }),
    );

    for (const id of [3, 4, 5]) {
      invocation.inputProtocol.receive(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
    }

    // Trigger cancel
    invocation.inputProtocol.cancel?.((msg) => {
      sent.push(msg);
    });

    expect(sent.at(-1)).toMatchObject({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "active-sess" },
    });
  });

  it("ignores non-prompt updates like mode/config updates when deciding input acceptance", () => {
    const accepted: string[] = [];

    const invocation = antigravityAcpConversation({
      ...baseRequest,
      viberMemory: {
        onInputAccepted: (id) => {
          accepted.push(id);
        },
      },
    });

    invocation.inputProtocol.start(
      () => {},
      () => {},
    );

    const receive = (msg: unknown) => {
      invocation.inputProtocol.receive(JSON.stringify(msg));
    };

    receive({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { resume: {} } },
      },
    });

    receive({
      jsonrpc: "2.0",
      id: 2,
      result: { sessionId: "sess-check" },
    });

    receive({ jsonrpc: "2.0", id: 3, result: {} });
    receive({ jsonrpc: "2.0", id: 4, result: {} });
    receive({ jsonrpc: "2.0", id: 5, result: {} });

    // Send mode or config update during active turn
    receive({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-check",
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: "plan",
        },
      },
    });

    receive({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-check",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [],
        },
      },
    });

    // Must NOT accept yet
    expect(accepted).toEqual([]);

    // Now tool_call arrives
    receive({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-check",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          name: "read_file",
        },
      },
    });

    expect(accepted).toEqual(["sess-check"]);
  });

  it("does not invoke onInputAccepted if turn is cancelled before prompt activity", () => {
    const accepted: string[] = [];

    const invocation = antigravityAcpConversation({
      ...baseRequest,
      viberMemory: {
        onInputAccepted: (id) => {
          accepted.push(id);
        },
      },
    });

    invocation.inputProtocol.start(
      () => {},
      () => {},
    );

    const receive = (msg: unknown) => {
      invocation.inputProtocol.receive(JSON.stringify(msg));
    };

    receive({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { resume: {} } },
      },
    });

    receive({
      jsonrpc: "2.0",
      id: 2,
      result: { sessionId: "sess-cancelled" },
    });

    receive({ jsonrpc: "2.0", id: 3, result: {} });
    receive({ jsonrpc: "2.0", id: 4, result: {} });
    receive({ jsonrpc: "2.0", id: 5, result: {} });

    // Cancel prompt
    invocation.inputProtocol.cancel?.(() => {});

    // Cancelled turn ends with cancelled stopReason
    receive({
      jsonrpc: "2.0",
      id: 6,
      result: { stopReason: "cancelled" },
    });

    expect(accepted).toEqual([]);
  });

  it("marks input accepted upon prompt resolution with end_turn if no chunks were streamed", () => {
    const accepted: string[] = [];

    const invocation = antigravityAcpConversation({
      ...baseRequest,
      viberMemory: {
        onInputAccepted: (id) => {
          accepted.push(id);
        },
      },
    });

    invocation.inputProtocol.start(
      () => {},
      () => {},
    );

    const receive = (msg: unknown) => {
      invocation.inputProtocol.receive(JSON.stringify(msg));
    };

    receive({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { resume: {} } },
      },
    });

    receive({
      jsonrpc: "2.0",
      id: 2,
      result: { sessionId: "sess-quick" },
    });

    receive({ jsonrpc: "2.0", id: 3, result: {} });
    receive({ jsonrpc: "2.0", id: 4, result: {} });
    receive({ jsonrpc: "2.0", id: 5, result: {} });

    expect(accepted).toEqual([]);

    // Turn ends immediately
    receive({
      jsonrpc: "2.0",
      id: 6,
      result: { stopReason: "end_turn" },
    });

    expect(accepted).toEqual(["sess-quick"]);
  });

  it("rejects unsupported protocolVersion on initialize", () => {
    const invocation = antigravityAcpConversation(baseRequest);

    invocation.inputProtocol.start(
      () => {},
      () => {},
    );

    expect(() => {
      invocation.inputProtocol.receive(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: 2,
          },
        }),
      );
    }).toThrowError(/Unsupported Antigravity ACP protocol version/);
  });

  it("throws provider_failed if session/set_mode returns error", () => {
    const invocation = antigravityAcpConversation(baseRequest);

    invocation.inputProtocol.start(
      () => {},
      () => {},
    );

    invocation.inputProtocol.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { resume: {} } },
        },
      }),
    );

    invocation.inputProtocol.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { sessionId: "sess-err-mode" },
      }),
    );

    expect(() => {
      invocation.inputProtocol.receive(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          error: { code: -32602, message: "Invalid mode: plan" },
        }),
      );
    }).toThrowError(/Antigravity set_mode failed/);
  });

  it("throws provider_failed if session/set_model returns error", () => {
    const invocation = antigravityAcpConversation({
      ...baseRequest,
      config: { model: "unknown-model", effort: "default", timeout_secs: 30 },
    });

    invocation.inputProtocol.start(
      () => {},
      () => {},
    );

    invocation.inputProtocol.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { resume: {} } },
        },
      }),
    );

    invocation.inputProtocol.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { sessionId: "sess-err-model" },
      }),
    );

    invocation.inputProtocol.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        result: {},
      }),
    );

    expect(() => {
      invocation.inputProtocol.receive(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          error: { code: -32602, message: "Unknown model: unknown-model" },
        }),
      );
    }).toThrowError(/Antigravity set_model failed/);
  });

  it("throws provider_failed if session/set_config_option returns error", () => {
    const invocation = antigravityAcpConversation({
      ...baseRequest,
      config: { model: "gemini-2.5-pro", effort: "xhigh", timeout_secs: 30 },
    });

    invocation.inputProtocol.start(
      () => {},
      () => {},
    );

    invocation.inputProtocol.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { resume: {} } },
        },
      }),
    );

    invocation.inputProtocol.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { sessionId: "sess-err-effort" },
      }),
    );

    invocation.inputProtocol.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        result: {},
      }),
    );

    invocation.inputProtocol.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        result: {},
      }),
    );

    expect(() => {
      invocation.inputProtocol.receive(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          error: { code: -32602, message: "Unsupported thought level: xhigh" },
        }),
      );
    }).toThrowError(/Antigravity set_config_option failed/);
  });
});

describe("antigravityAcpNormalize", () => {
  it("normalizes agent message and thought chunks with nested content", () => {
    const msgEvents = antigravityAcpNormalize({
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Streaming answer chunk" },
          messageId: "msg-1",
        },
      },
    });

    expect(msgEvents).toEqual([
      {
        kind: "message",
        data: {
          call_id: "msg-1",
          text_delta: "Streaming answer chunk",
        },
      },
    ]);

    const thoughtEvents = antigravityAcpNormalize({
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Reflecting on options" },
        },
      },
    });

    expect(thoughtEvents).toEqual([
      {
        kind: "analysis.status",
        data: {
          text_delta: "Reflecting on options",
        },
      },
    ]);
  });

  it("normalizes tool calls and tool updates", () => {
    const toolCallEvents = antigravityAcpNormalize({
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          name: "read_file",
          kind: "read",
          args: { Path: "/repo/package.json" },
        },
      },
    });

    expect(toolCallEvents[0]).toMatchObject({
      kind: "file.read",
      data: {
        call_id: "call-1",
        tool: "read_file",
        path: "/repo/package.json",
        status: "running",
      },
    });

    const toolDoneEvents = antigravityAcpNormalize({
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-2",
          name: "run_command",
          kind: "execute",
          status: "completed",
          args: { CommandLine: "npm test" },
          output: "All tests passed",
          exitCode: 0,
        },
      },
    });

    expect(toolDoneEvents[0]).toMatchObject({
      kind: "command.finished",
      data: {
        call_id: "call-2",
        tool: "run_command",
        command: "npm test",
        status: "completed",
        stdout: "All tests passed",
        exit_code: 0,
      },
    });
  });

  it.each(["tool_call", "tool_call_update"])("maps command statuses for %s", (sessionUpdate) => {
    const normalize = (status: string) =>
      antigravityAcpNormalize({
        method: "session/update",
        params: { update: { sessionUpdate, toolCallId: "cmd", kind: "execute", status } },
      });

    expect(normalize("pending")).toMatchObject([
      { kind: "command.output", data: { status: "pending" } },
    ]);

    expect(normalize("in_progress")).toMatchObject([
      { kind: "command.started", data: { status: "in_progress" } },
    ]);

    expect(normalize("completed")).toMatchObject([
      { kind: "command.finished", data: { status: "completed" } },
    ]);

    expect(normalize("failed")).toMatchObject([
      { kind: "command.finished", data: { status: "failed" } },
    ]);
  });

  it("excludes cancelled stopReason from run.completed", () => {
    const cancelledEvents = antigravityAcpNormalize({
      jsonrpc: "2.0",
      id: 6,
      result: {
        stopReason: "cancelled",
      },
    });

    expect(cancelledEvents).toEqual([]);

    const completedEvents = antigravityAcpNormalize({
      jsonrpc: "2.0",
      id: 6,
      result: {
        stopReason: "end_turn",
      },
    });

    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].kind).toBe("run.completed");
  });

  it("normalizes tool calls with rawInput and tool updates with rawOutput", () => {
    const toolCallEvents = antigravityAcpNormalize({
      method: "session/update",
      params: {
        sessionId: "sess-raw",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-raw-1",
          name: "write_file",
          kind: "edit",
          rawInput: { Path: "/repo/src/index.ts" },
        },
      },
    });

    expect(toolCallEvents[0]).toMatchObject({
      kind: "file.changed",
      data: {
        call_id: "call-raw-1",
        tool: "write_file",
        path: "/repo/src/index.ts",
      },
    });

    const toolDoneEvents = antigravityAcpNormalize({
      method: "session/update",
      params: {
        sessionId: "sess-raw",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-raw-1",
          name: "write_file",
          status: "completed",
          rawOutput: "File written successfully",
        },
      },
    });

    expect(toolDoneEvents[0].data).toMatchObject({
      stdout: "File written successfully",
    });
  });

  it("preserves standard ACP content on a completed command", () => {
    const update = {
      sessionUpdate: "tool_call_update",
      toolCallId: "cmd",
      kind: "execute",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "Tests passed" } },
        { type: "terminal", terminalId: "terminal-1" },
        { type: "content", content: { type: "text", text: "Build passed" } },
      ],
    };

    const normalize = (fields = {}) =>
      antigravityAcpNormalize({
        method: "session/update",
        params: { update: { ...update, ...fields } },
      });

    const expected = [{ kind: "command.finished", data: { stdout: "Tests passed\nBuild passed" } }];
    expect(normalize()).toMatchObject(expected);
    expect(normalize({ rawOutput: "Tests passed\nBuild passed" })).toMatchObject(expected);

    expect(normalize({ content: [], rawOutput: "Raw fallback" })).toMatchObject([
      { kind: "command.finished", data: { stdout: "Raw fallback" } },
    ]);
  });
});
