import { AdeError, type NormalizedEvent } from "../../domain";
import type { ProcessInputProtocol } from "../runtime/process";
import { object, parseLine, withMemoryReference, type AgentRunRequest } from "./contracts";

type AcpPhase =
  | "initialize"
  | "session_setup"
  | "setting_mode"
  | "setting_model"
  | "setting_effort"
  | "turn_active"
  | "finished";

const isResponse = (raw: Record<string, unknown>) =>
  raw.jsonrpc === "2.0" && raw.method === undefined;

const successResult = (raw: Record<string, unknown>) => {
  if (
    !isResponse(raw) ||
    "error" in raw ||
    !raw.result ||
    typeof raw.result !== "object" ||
    Array.isArray(raw.result)
  ) {
    return null;
  }

  return object(raw.result);
};

const requireResult = (raw: Record<string, unknown>, action: string) => {
  const result = successResult(raw);
  if (!result) {
    const detail = isResponse(raw) ? object(raw.error).message : undefined;
    throw new AdeError(
      "provider_failed",
      `Antigravity ${action} failed: ${typeof detail === "string" ? detail : "invalid response"}`,
    );
  }

  return result;
};

/**
 * Executes a conversational turn against the official Antigravity ACP stdio server.
 * Manages protocol v1 negotiation, scoped session permissions, verified thread resume,
 * private memory recall gating, prompt cancellation, and streamed output events.
 */
export const antigravityAcpConversation = (request: AgentRunRequest) => {
  let send: (message: unknown) => void;
  let end: () => void;
  let phase: AcpPhase = "initialize";
  let threadId = request.conversation?.threadId;
  let inputAccepted = false;
  let cancelled = false;

  const tools = new Map<unknown, { name: unknown; kind: unknown }>();

  const isSessionReply = (raw: Record<string, unknown>) =>
    raw.id === 2 && phase === "session_setup";

  const sessionIdentity = (raw: Record<string, unknown>) => {
    const error = isResponse(raw) && !("result" in raw) ? object(raw.error) : {};
    if (
      threadId &&
      typeof error.code === "number" &&
      typeof error.message === "string" &&
      ((error.code === -32002 && object(error.data).sessionId === threadId) ||
        /^(?:ACP )?session (?:not found|does not exist)(?:$|[:.])/i.test(error.message) ||
        error.message === `Session ${threadId} not found` ||
        (error.message.startsWith(`Failed to read session ${threadId}:`) &&
          /:\s*(?:file not found\b|ENOENT\b|no such file or directory\b)/i.test(error.message)))
    ) {
      throw new AdeError("thread_resume_rejected", "Antigravity could not find the saved thread.");
    }

    const result = requireResult(raw, "session setup");
    const returnedId = "sessionId" in result ? result.sessionId : threadId;
    if (typeof returnedId !== "string" || !returnedId) {
      throw new AdeError("provider_failed", "Antigravity returned no conversation identity.");
    }

    if (threadId && returnedId !== threadId) {
      throw new AdeError("provider_failed", "Antigravity returned a different session identity.");
    }

    return returnedId;
  };

  const matchesActiveSession = (raw: Record<string, unknown>) =>
    phase === "turn_active" && raw.jsonrpc === "2.0" && object(raw.params).sessionId === threadId;

  const shouldObserveStdout = (raw: Record<string, unknown>) =>
    raw.method !== "session/update" || matchesActiveSession(raw);

  const inputProtocol: ProcessInputProtocol = {
    start: (write, close) => {
      send = write;
      end = close;

      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "akkco-vibestar", version: "0.1.0" },
        },
      });
    },

    cancel: (write) => {
      cancelled = true;
      if (phase === "turn_active" && threadId) {
        write({
          jsonrpc: "2.0",
          method: "session/cancel",
          params: { sessionId: threadId },
        });
      }
    },

    receiveCancellation: (line, write) => {
      if (phase !== "turn_active") {
        return;
      }

      const raw = parseLine(line);
      if (
        raw.jsonrpc === "2.0" &&
        raw.method === "session/request_permission" &&
        (typeof raw.id === "number" || typeof raw.id === "string")
      ) {
        write({ jsonrpc: "2.0", id: raw.id, result: { outcome: { outcome: "cancelled" } } });
      } else if (raw.id === 6 && successResult(raw)?.stopReason === "cancelled") {
        phase = "finished";
        end();
      }
    },

    validate: (line) => {
      const raw = parseLine(line);
      if (isSessionReply(raw) && raw.method === undefined) {
        sessionIdentity(raw);
      }
    },

    receive: (line) => {
      const response = parseLine(line);
      if (phase === "finished" || cancelled) {
        return;
      }

      // Actively reject any out-of-band server request (e.g. permission escalation or interactive forms)
      // so the ACP server does not hang waiting for user interaction.
      if (response.id != null && typeof response.method === "string") {
        send({
          jsonrpc: "2.0",
          id: response.id,
          error: {
            code: -32601,
            message:
              "Out-of-band host permission escalation or interactive forms are not supported in this session.",
          },
        });

        return;
      }

      // Handle initialize response
      if (response.id === 1 && phase === "initialize") {
        const res = requireResult(response, "initialize");
        const protocolVersion = res.protocolVersion ?? res.protocol_version;
        if (protocolVersion !== 1) {
          throw new AdeError(
            "provider_failed",
            `Unsupported Antigravity ACP protocol version: ${String(res.protocolVersion ?? res.protocol_version ?? "unknown")}`,
          );
        }

        const agentCaps = object(res.agentCapabilities);
        const sessionCaps = object(agentCaps.sessionCapabilities || agentCaps.session_capabilities);
        const supportsResume = !!sessionCaps.resume;

        const supportsLoad =
          !!sessionCaps.load || !!agentCaps.loadSession || !!agentCaps.load_session;

        send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

        if (threadId && !supportsResume && !supportsLoad) {
          throw new AdeError(
            "provider_unavailable",
            "Antigravity ACP server does not advertise session resume or load.",
          );
        }

        phase = "session_setup";

        send({
          jsonrpc: "2.0",
          id: 2,
          method: threadId ? (supportsResume ? "session/resume" : "session/load") : "session/new",
          params: {
            ...(threadId ? { sessionId: threadId } : {}),
            cwd: request.cwd,
            mcpServers: [],
          },
        });

        return;
      }

      const proceedToPrompt = () => {
        // Saved native thread is now strictly confirmed. Recall facts safely:
        const memory = request.viberMemory?.recall
          ? request.viberMemory.recall(threadId)
          : request.memory;

        const promptText = withMemoryReference({
          prompt: request.prompt,
          memory,
        });

        phase = "turn_active";

        send({
          jsonrpc: "2.0",
          id: 6,
          method: "session/prompt",
          params: {
            sessionId: threadId,
            prompt: [{ type: "text", text: promptText }],
          },
        });
      };

      // Handle session setup response (session/new, session/resume, or session/load)
      if (isSessionReply(response)) {
        threadId = sessionIdentity(response);

        // Apply scoped permission mode: accept-edits for workspace-write, plan for read-only
        phase = "setting_mode";
        const modeId = request.access === "workspace-write" ? "accept-edits" : "plan";

        send({
          jsonrpc: "2.0",
          id: 3,
          method: "session/set_mode",
          params: { sessionId: threadId, modeId },
        });

        return;
      }

      if (
        (response.id === 3 && phase === "setting_mode") ||
        (response.id === 4 && phase === "setting_model")
      ) {
        requireResult(response, response.id === 3 ? "set_mode" : "set_model");

        if (response.id === 3 && request.config.model) {
          phase = "setting_model";

          send({
            jsonrpc: "2.0",
            id: 4,
            method: "session/set_model",
            params: { sessionId: threadId, modelId: request.config.model },
          });

          return;
        }

        if (request.config.effort && request.config.effort !== "default") {
          phase = "setting_effort";

          send({
            jsonrpc: "2.0",
            id: 5,
            method: "session/set_config_option",
            params: {
              sessionId: threadId,
              configId: "thought_level",
              value: request.config.effort,
            },
          });

          return;
        }

        proceedToPrompt();
        return;
      }

      // Handle session/set_config_option response
      if (response.id === 5 && phase === "setting_effort") {
        requireResult(response, "set_config_option");

        proceedToPrompt();
        return;
      }

      // Handle streaming updates
      if (response.method === "session/update") {
        if (!matchesActiveSession(response)) {
          return;
        }

        const update = object(object(response.params).update);
        const updateType = String(update.sessionUpdate || "");

        // Acknowledge input exactly once upon the first active turn prompt-related update
        const isPromptActivity =
          updateType === "agent_message_chunk" ||
          updateType === "agent_thought_chunk" ||
          updateType === "tool_call" ||
          updateType === "tool_call_update";

        if (!inputAccepted && threadId && !cancelled && isPromptActivity) {
          inputAccepted = true;
          request.viberMemory?.onInputAccepted?.(threadId);
        }

        return;
      }

      // Handle prompt turn resolution
      if (response.id === 6 && phase === "turn_active") {
        const res = requireResult(response, "prompt");
        if (!inputAccepted && threadId && !cancelled && res.stopReason === "end_turn") {
          inputAccepted = true;
          request.viberMemory?.onInputAccepted?.(threadId);
        }

        phase = "finished";
        end();
      }
    },
  };

  return {
    program: "agy",
    args: ["acp", "--sandbox"],
    inputProtocol,
    shouldObserveStdout,
    conversationId: (raw: Record<string, unknown>) =>
      isSessionReply(raw) && successResult(raw) ? sessionIdentity(raw) : null,
    normalize: (raw: Record<string, unknown>): NormalizedEvent[] => {
      if (isSessionReply(raw) && successResult(raw)) {
        return [{ kind: "run.started", data: { conversation_id: sessionIdentity(raw) } }];
      }

      if (cancelled || phase !== "turn_active" || !shouldObserveStdout(raw)) {
        return [];
      }

      return antigravityAcpNormalize(raw, tools);
    },
  };
};

/**
 * Normalizes ACP JSON-RPC notifications and results into unified Vibestar NormalizedEvents.
 */
export const antigravityAcpNormalize = (
  raw: Record<string, unknown>,
  tools = new Map<unknown, { name: unknown; kind: unknown }>(),
): NormalizedEvent[] => {
  // Session update notification
  if (raw.method === "session/update") {
    const params = object(raw.params);
    let update = object(params.update);
    const type = String(update.sessionUpdate);

    if (type === "agent_message_chunk") {
      const content = object(update.content);

      const text =
        typeof content.text === "string"
          ? content.text
          : typeof update.content === "string"
            ? update.content
            : "";

      return [
        {
          kind: "message",
          data: {
            call_id: update.messageId || "agent_message",
            text_delta: text,
          },
        },
      ];
    }

    if (type === "agent_thought_chunk") {
      const content = object(update.content);

      const text =
        typeof content.text === "string"
          ? content.text
          : typeof update.content === "string"
            ? update.content
            : "";

      return [
        {
          kind: "analysis.status",
          data: {
            text_delta: text,
          },
        },
      ];
    }

    if ((type === "tool_call" || type === "tool_call_update") && update.toolCallId != null) {
      const prior = tools.get(update.toolCallId);
      const classification = { name: update.name ?? prior?.name, kind: update.kind ?? prior?.kind };
      tools.set(update.toolCallId, classification);
      update = { ...update, ...classification };
    }

    if (type === "tool_call" || type === "tool_call_update") {
      const toolName = String(update.name || "");
      const kindName = String(update.kind || "");
      const reportedStatus = typeof update.status === "string" ? update.status : undefined;
      let status = reportedStatus ?? (type === "tool_call" ? "running" : undefined);
      let kind: NormalizedEvent["kind"] = "analysis.status";

      if (
        kindName === "read" ||
        ["read_file", "view_file", "list_dir", "grep_search", "find_by_name"].includes(toolName)
      ) {
        kind = "file.read";
      } else if (
        kindName === "edit" ||
        ["write_to_file", "replace_file_content", "edit_file", "write_file"].includes(toolName)
      ) {
        kind = "file.changed";
      } else if (
        kindName === "execute" ||
        ["run_command", "send_command_input", "Bash"].includes(toolName)
      ) {
        status = reportedStatus ?? (type === "tool_call" ? "pending" : undefined);

        if (status === "in_progress") {
          kind = "command.started";
        } else if (status && ["completed", "failed", "DONE", "ERROR"].includes(status)) {
          kind = "command.finished";
        } else {
          kind = "command.output";
        }
      }

      const args = object(update.args ?? update.rawInput ?? update.raw_input);
      return [
        {
          kind,
          data: {
            call_id: update.toolCallId,
            tool: toolName,
            arguments: args,
            command: args.CommandLine ?? args.command,
            path: args.Path ?? args.AbsolutePath ?? args.TargetFile ?? args.file_path,
            status: status === "failed" || status === "ERROR" ? "failed" : status,
            exit_code: update.exitCode ?? update.exit_code,
            stdout: update.stdout ?? update.output ?? update.rawOutput ?? update.raw_output,
            stderr: update.stderr ?? object(update.error).message,
          },
        },
      ];
    }

    if (type === "usage_update") {
      return [{ kind: "analysis.status", data: { usage: update } }];
    }

    return [];
  }

  const result = successResult(raw);
  if (!result || raw.id !== 6 || result.stopReason === "cancelled") {
    return [];
  }

  return result.stopReason === "end_turn"
    ? [{ kind: "run.completed", data: result }]
    : [{ kind: "run.failed", data: { stopReason: result.stopReason ?? "missing stop reason" } }];
};
