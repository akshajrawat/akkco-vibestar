import { AdeError } from "../../domain";
import { memorySuggestionInstructions } from "../../vibers/memory-local";
import type { ProcessInputProtocol } from "../runtime/process";
import { object, withMemoryReference, type AgentRunRequest } from "./contracts";

const saveMemoryTool = {
  type: "function",
  name: "save_memory",
  description: memorySuggestionInstructions,
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string" },
      evidence: { type: "string" },
      topic: { type: ["string", "null"] },
    },
    required: ["text", "evidence", "topic"],
    additionalProperties: false,
  },
};

const isSaveMemoryTool = (item: Record<string, unknown>) =>
  item.tool === saveMemoryTool.name && item.namespace == null;

export const codexMemoryEvent = (raw: Record<string, unknown>) => {
  const params = object(raw.params);
  const item = object(params.item);
  return (
    (raw.method === "item/tool/call" && isSaveMemoryTool(params)) ||
    (item.type === "dynamicToolCall" && isSaveMemoryTool(item))
  );
};

/** Append reference context or dispatch one authorized turn, then close the owned process. */
export const codexConversation = (request: AgentRunRequest) => {
  const writable = request.access === "workspace-write";
  let send: (message: unknown) => void;
  let end: () => void;
  let phase: "initialize" | "thread" | "inject" | "turn" | "finished" = "initialize";
  let threadId = request.conversation?.threadId;
  let turnId: string | undefined;
  const registerMemoryTool = !threadId && !!request.viberMemory?.suggest;

  const dispatch = () => {
    if (request.preload?.only) {
      phase = "finished";
      end();
      return;
    }

    phase = "turn";

    send({
      id: 2,
      method: "turn/start",
      params: {
        threadId,
        cwd: request.cwd,
        model: request.config.model || null,
        effort: request.config.effort,
        approvalPolicy: "never",
        sandboxPolicy: writable
          ? { type: "workspaceWrite", writableRoots: [request.cwd], networkAccess: true }
          : { type: "readOnly" },
        input: [
          {
            type: "text",
            text: withMemoryReference({
              prompt: request.prompt,
              memory: request.viberMemory?.recall
                ? request.viberMemory.recall(threadId)
                : request.memory,
            }),
          },
        ],
      },
    });
  };

  const inputProtocol: ProcessInputProtocol = {
    start: (write, close) => {
      send = write;
      end = close;

      send({
        id: 0,
        method: "initialize",
        params: {
          clientInfo: { name: "vibestar", title: "Akkco Vibestar", version: "0.1.0" },
          ...(request.preload?.context || registerMemoryTool
            ? { capabilities: { experimentalApi: true } }
            : {}),
        },
      });
    },
    validate: request.conversation?.confirmResume
      ? (line) => {
          const response = object(JSON.parse(line));
          if (phase !== "thread" || response.id !== 1 || response.method !== undefined) {
            return;
          }

          const thread = object(object(response.result).thread);

          const missing =
            object(response.error).message === `no rollout found for thread id ${threadId}`;

          const unusable =
            typeof thread.id === "string" && thread.id !== "" && thread.id !== threadId;

          if (missing || unusable) {
            throw new AdeError(
              "thread_resume_rejected",
              "Codex could not confirm the saved thread.",
            );
          }

          if (object(thread.status).type === "active") {
            throw new AdeError("provider_failed", "Codex reported the saved thread is active.");
          }
        }
      : undefined,
    validateExit: request.preload?.only
      ? () => {
          if (phase !== "finished") {
            throw new AdeError(
              "provider_failed",
              "Codex exited without confirming context preload.",
            );
          }
        }
      : undefined,
    receive: (line) => {
      const response = object(JSON.parse(line));
      if (phase === "finished") {
        return;
      }

      if (response.error) {
        throw new AdeError(
          "provider_failed",
          String(object(response.error).message || "Codex session request failed"),
        );
      }

      const params = object(response.params);
      // This tool can only suggest text for the current turn. It has no workspace permissions.
      if (
        response.id != null &&
        response.method === "item/tool/call" &&
        isSaveMemoryTool(params) &&
        phase === "turn" &&
        params.threadId === threadId &&
        turnId &&
        params.turnId === turnId
      ) {
        request.viberMemory?.suggest?.({ ...object(params.arguments), action: "save_memory" });

        send({
          id: response.id,
          result: {
            success: true,
            contentItems: [{ type: "inputText", text: "Continue answering the user normally." }],
          },
        });

        return;
      }

      // Approval and all other tool requests cannot extend the host-authorized workspace.
      if (response.id != null && typeof response.method === "string") {
        send({
          id: response.id,
          error: {
            code: -32601,
            message: "This conversation cannot authorize extra tool permissions or host actions.",
          },
        });

        return;
      }

      if (response.id === 0 && phase === "initialize") {
        phase = "thread";
        send({ method: "initialized", params: {} });

        send({
          id: 1,
          method: threadId ? "thread/resume" : "thread/start",
          params: {
            ...(threadId ? { threadId, excludeTurns: true } : {}),
            cwd: request.cwd,
            model: request.config.model || null,
            approvalPolicy: "never",
            sandbox: writable ? "workspace-write" : "read-only",
            developerInstructions: request.preload?.instructions,
            ...(registerMemoryTool ? { dynamicTools: [saveMemoryTool] } : {}),
            config: { project_doc_max_bytes: 0 },
          },
        });
      } else if (response.id === 1 && phase === "thread") {
        const returnedId = object(object(response.result).thread).id;
        if (typeof returnedId !== "string" || !returnedId) {
          throw new AdeError("provider_failed", "Codex returned no conversation identity.");
        }

        if (threadId && returnedId !== threadId) {
          throw new AdeError(
            "provider_failed",
            "Codex resumed a different thread before the turn was dispatched. Send /clear to start a new thread.",
          );
        }

        threadId = returnedId;

        if (request.preload?.context) {
          phase = "inject";

          send({
            id: 3,
            method: "thread/inject_items",
            params: {
              threadId,
              items: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: request.preload.context }],
                },
              ],
            },
          });
        } else {
          dispatch();
        }
      } else if (response.id === 3 && phase === "inject") {
        if (!response.result || typeof response.result !== "object" || !threadId) {
          throw new AdeError("provider_failed", "Codex did not confirm context preload.");
        }

        request.preload?.onInjected?.(threadId);
        dispatch();
      } else if (
        phase === "turn" &&
        (response.id === 2 || (response.method === "turn/started" && params.threadId === threadId))
      ) {
        const id = object(response.id === 2 ? object(response.result).turn : params.turn).id;
        if (typeof id === "string" && id) {
          if (!turnId && threadId) {
            request.viberMemory?.onInputAccepted?.(threadId);
          }

          turnId = id;
        }
      } else if (
        phase === "turn" &&
        response.method === "item/completed" &&
        params.threadId === threadId &&
        object(params.item).type === "contextCompaction" &&
        threadId
      ) {
        request.viberMemory?.compact?.(threadId);
      } else if (response.method === "turn/completed" && phase === "turn") {
        const turn = object(object(response.params).turn);
        if (!["completed", "failed", "interrupted"].includes(String(turn.status))) {
          throw new AdeError("provider_failed", "Codex returned an unknown turn outcome.");
        }

        phase = "finished";
        end();
      }
    },
  };

  return {
    program: "codex",
    args: [
      "--no-daemon",
      "app-server",
      "-c",
      'forced_login_method="chatgpt"',
      "-c",
      "analytics.enabled=false",
    ],
    inputProtocol,
    isolateProviderConfig: true,
  };
};

/** Translate app-server notifications into the same persisted events used by CLI workflow runs. */
export const codexSessionEvent = (raw: Record<string, unknown>): Record<string, unknown> => {
  if (typeof raw.method !== "string") {
    const thread = object(object(raw.result).thread);
    return typeof thread.id === "string" ? { type: "thread.started", thread_id: thread.id } : raw;
  }

  const params = object(raw.params);
  const item = object(params.item);
  if (raw.method === "thread/started") {
    return { type: "thread.started", thread_id: object(params.thread).id };
  }

  if (raw.method === "turn/completed") {
    const turn = object(params.turn);
    return {
      type: turn.status === "completed" ? "turn.completed" : "turn.failed",
      error: turn.error || (turn.status !== "completed" ? `Turn ${turn.status}` : undefined),
    };
  }

  if (raw.method === "error") {
    return params.willRetry === true
      ? {
          type: "provider.retrying",
          status: "retrying",
          text: String(object(params.error).message || "Provider request is retrying"),
        }
      : { type: "error", error: params.error };
  }

  if (["item/started", "item/completed"].includes(raw.method)) {
    if (item.type === "userMessage") {
      return raw;
    }

    const types: Record<string, string> = {
      agentMessage: "agent_message",
      commandExecution: "command_execution",
      fileChange: "file_change",
    };

    return {
      type: raw.method === "item/started" ? "item.started" : "item.completed",
      item: {
        ...item,
        type: types[String(item.type)] || item.type,
        exit_code: item.exitCode,
        duration_ms: item.durationMs,
        aggregated_output: item.aggregatedOutput,
        status: item.status === "inProgress" ? "running" : item.status,
      },
    };
  }

  if (raw.method === "item/agentMessage/delta") {
    return {
      type: "item.updated",
      item: {
        id: params.itemId,
        type: "agent_message",
        text_delta: params.delta,
        status: "running",
      },
    };
  }

  if (raw.method === "item/commandExecution/outputDelta") {
    return {
      type: "item.updated",
      item: {
        id: params.itemId,
        type: "command_execution",
        stdout_delta: params.delta,
        status: "running",
      },
    };
  }

  if (raw.method === "item/reasoning/summaryTextDelta") {
    return {
      type: "item.updated",
      item: {
        id: params.itemId,
        type: "reasoning",
        text_delta: params.delta,
        status: "running",
      },
    };
  }

  return raw;
};
