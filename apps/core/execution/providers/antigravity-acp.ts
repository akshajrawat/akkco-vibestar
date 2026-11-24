import { AdeError, type NormalizedEvent } from "../../domain";
import type { ProcessInputProtocol } from "../runtime/process";
import { object, withMemoryReference, type AgentRunRequest } from "./contracts";

type AcpPhase =
  | "initialize"
  | "session_setup"
  | "session_load"
  | "setting_mode"
  | "setting_model"
  | "setting_effort"
  | "turn_active"
  | "finished";

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
      if (
        threadId &&
        (phase === "turn_active" ||
          phase === "session_setup" ||
          phase === "setting_mode" ||
          phase === "setting_model" ||
          phase === "setting_effort")
      ) {
        try {
          write({
            jsonrpc: "2.0",
            method: "session/cancel",
            params: { sessionId: threadId },
          });
        } catch {
          // Ignore write failure if process already terminated
        }
      }
    },

    validate: request.conversation?.confirmResume
      ? (line) => {
          let response: Record<string, unknown>;
          try {
            response = object(JSON.parse(line));
          } catch {
            return;
          }

          if (response.id !== 2 || (phase !== "session_setup" && phase !== "session_load")) {
            return;
          }

          if (response.error) {
            const msg = String(object(response.error).message || "");
            const code = object(response.error).code;
            if (
              code === -32603 ||
              code === -32002 ||
              /not found/i.test(msg) ||
              /failed to read session/i.test(msg)
            ) {
              throw new AdeError(
                "thread_resume_rejected",
                "Antigravity could not find the saved thread.",
              );
            }
          }

          const returnedId = object(response.result).sessionId;
          if (
            threadId &&
            typeof returnedId === "string" &&
            returnedId !== "" &&
            returnedId !== threadId
          ) {
            throw new AdeError(
              "thread_resume_rejected",
              "Antigravity could not confirm the saved thread.",
            );
          }
        }
      : undefined,

    receive: (line) => {
      let response: Record<string, unknown>;
      try {
        response = object(JSON.parse(line));
      } catch {
        return;
      }

      if (phase === "finished") {
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
        if (response.error) {
          throw new AdeError(
            "provider_failed",
            String(object(response.error).message || "Antigravity ACP initialize failed"),
          );
        }

        const res = object(response.result);
        const protocolVersion = Number(res.protocolVersion ?? res.protocol_version);
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

        if (threadId) {
          if (supportsResume) {
            phase = "session_setup";

            send({
              jsonrpc: "2.0",
              id: 2,
              method: "session/resume",
              params: { sessionId: threadId, cwd: request.cwd, mcpServers: [] },
            });
          } else if (supportsLoad) {
            phase = "session_load";

            send({
              jsonrpc: "2.0",
              id: 2,
              method: "session/load",
              params: { sessionId: threadId, cwd: request.cwd, mcpServers: [] },
            });
          } else {
            throw new AdeError(
              "provider_unavailable",
              "Antigravity ACP server does not advertise session resume or load.",
            );
          }
        } else {
          phase = "session_setup";

          send({
            jsonrpc: "2.0",
            id: 2,
            method: "session/new",
            params: { cwd: request.cwd, mcpServers: [] },
          });
        }

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
      if (response.id === 2 && (phase === "session_setup" || phase === "session_load")) {
        if (response.error) {
          const msg = String(object(response.error).message || "");
          const code = object(response.error).code;
          if (
            threadId &&
            (code === -32603 ||
              code === -32002 ||
              /not found/i.test(msg) ||
              /failed to read session/i.test(msg))
          ) {
            throw new AdeError(
              "thread_resume_rejected",
              "Antigravity could not find the saved thread.",
            );
          }

          throw new AdeError("provider_failed", `Antigravity session setup failed: ${msg}`);
        }

        const returnedId = String(object(response.result).sessionId || threadId || "");
        if (!returnedId) {
          throw new AdeError("provider_failed", "Antigravity returned no conversation identity.");
        }

        if (threadId && returnedId !== threadId) {
          throw new AdeError(
            "thread_resume_rejected",
            "Antigravity returned a different session identity.",
          );
        }

        threadId = returnedId;

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

      // Handle session/set_mode response
      if (response.id === 3 && phase === "setting_mode") {
        if (response.error) {
          throw new AdeError(
            "provider_failed",
            `Antigravity set_mode failed: ${String(object(response.error).message || "unknown error")}`,
          );
        }

        if (request.config.model) {
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

      // Handle session/set_model response
      if (response.id === 4 && phase === "setting_model") {
        if (response.error) {
          throw new AdeError(
            "provider_failed",
            `Antigravity set_model failed: ${String(object(response.error).message || "unknown error")}`,
          );
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
        if (response.error) {
          throw new AdeError(
            "provider_failed",
            `Antigravity set_config_option failed: ${String(object(response.error).message || "unknown error")}`,
          );
        }

        proceedToPrompt();
        return;
      }

      // Handle streaming updates
      if (response.method === "session/update") {
        if (phase === "session_load") {
          // Suppress replayed history updates from session/load so they don't pollute live chat
          return;
        }

        if (phase !== "turn_active") {
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
        if (response.error) {
          throw new AdeError(
            "provider_failed",
            String(object(response.error).message || "Antigravity prompt turn failed"),
          );
        }

        const res = object(response.result);
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
    isTurnActive: () => phase === "turn_active",
  };
};

/**
 * Normalizes ACP JSON-RPC notifications and results into unified Vibestar NormalizedEvents.
 */
export const antigravityAcpNormalize = (
  raw: Record<string, unknown>,
  isTurnActive = true,
): NormalizedEvent[] => {
  // Session update notification
  if (raw.method === "session/update") {
    if (!isTurnActive) {
      return [];
    }

    const params = object(raw.params);
    const update = object(params.update);
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

    if (type === "tool_call") {
      const toolName = String(update.name || "");
      const kindName = String(update.kind || "");
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
        kind = "command.started";
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
            status: "running",
          },
        },
      ];
    }

    if (type === "tool_call_update") {
      const toolName = String(update.name || "");
      const kindName = String(update.kind || "");
      const status = String(update.status || "");
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
        kind = ["completed", "failed", "DONE", "ERROR"].includes(status)
          ? "command.finished"
          : "command.started";
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

  // Response with session ID
  if (raw.result && typeof raw.result === "object") {
    const res = object(raw.result);
    if (res.sessionId && (raw.id === 2 || raw.id === 1)) {
      return [{ kind: "run.started", data: { conversation_id: res.sessionId } }];
    }

    if (res.stopReason === "end_turn") {
      return [{ kind: "run.completed", data: res }];
    }

    // A cancelled prompt must NOT be marked as run.completed
    if (res.stopReason === "cancelled") {
      return [];
    }
  }

  if (raw.error && typeof raw.error === "object") {
    return [{ kind: "run.failed", data: raw.error }];
  }

  return [];
};

/**
 * Extracts conversation identity from ACP events and responses.
 */
export const antigravityAcpConversationId = (raw: Record<string, unknown>): string | null => {
  if (raw.method === "session/update") {
    const sid = object(raw.params).sessionId;
    if (typeof sid === "string" && sid.length > 0) {
      return sid;
    }
  }

  if (raw.result && typeof raw.result === "object") {
    const sid = object(raw.result).sessionId;
    if (typeof sid === "string" && sid.length > 0) {
      return sid;
    }
  }

  return null;
};

/**
 * Extracts final result summary from ACP responses.
 */
export const antigravityAcpResult = (
  raw: Record<string, unknown>,
  conversation = false,
): unknown => {
  if (raw.result && typeof raw.result === "object") {
    const res = object(raw.result);
    if (res.stopReason === "end_turn") {
      return conversation ? undefined : res;
    }
  }

  return undefined;
};
