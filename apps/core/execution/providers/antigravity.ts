import { capture, checked, type ProcessInputProtocol } from "../runtime/process";
import {
  object,
  parseLine,
  verifyFlags,
  withMemoryReference,
  type AgentProvider,
  type AgentRunRequest,
  type ProviderDetection,
} from "./contracts";
import { AdeError, type NormalizedEvent } from "../../domain";
import { antigravityAcpConversation, antigravitySharedDirectories } from "./antigravity-acp";

// The CLI exposes these models with provider-managed reasoning and rejects --effort.
// Unknown unsuffixed models stay unavailable until their capabilities are known.
const automaticModels = new Set(["claude-sonnet-4-6", "claude-opus-4-6-thinking"]);

export class AntigravityProvider implements AgentProvider {
  readonly name = "antigravity";

  private activeAcp?: ReturnType<typeof antigravityAcpConversation>;

  detect = async (cwd: string, signal?: AbortSignal): Promise<ProviderDetection> => {
    const d: ProviderDetection = {
      provider: this.name,
      installed: false,
      version: "",
      connected: false,
      models: [],
      efforts: ["low", "medium", "high", "xhigh", "max"],
      capabilities: [],
      error: null,
    };

    try {
      d.version = await checked("agy", ["--version"], cwd, signal);
      d.installed = true;
      const help = await capture("agy", ["--help"], cwd, signal);

      verifyFlags(help.stdout + help.stderr, [
        "--mode",
        "--sandbox",
        "--effort",
        "--input-format",
        "--output-format",
        "--json-schema",
      ]);

      const models = await capture("agy", ["models"], cwd, signal);
      if (models.code === 0) {
        d.models = models.stdout
          .split("\n")
          .filter((s) => s.includes("\t"))
          .map((s) => {
            const [id, label] = s.trim().split("\t");
            const effort = id.match(/-(low|medium|high|xhigh|max)$/)?.[1];
            return {
              id,
              label,
              supportedEfforts: effort ? [effort] : automaticModels.has(id) ? ["default"] : [],
            };
          });

        d.connected = d.models.length > 0;

        d.accountLabel = d.connected
          ? "Authenticated account · managed by Antigravity CLI"
          : undefined;

        if (!d.connected) {
          d.error = "Model discovery returned no available models. Reconnect Antigravity.";
        }
      } else {
        d.error = models.stderr;
      }

      d.capabilities = ["plan-mode", "sandbox", "structured-events", "schema", "model-discovery"];
      if ((help.stdout + help.stderr).includes("--conversation")) {
        d.capabilities.push("native-conversations");
      }

      if (/\bacp\b/.test(help.stdout + help.stderr)) {
        d.capabilities.push("acp");
      }
    } catch (e) {
      d.error = String(e);
    }

    return d;
  };

  invocation = (r: AgentRunRequest) => {
    const sharedDirectories = antigravitySharedDirectories(r);

    if (r.conversation?.protocol === "acp") {
      const conv = antigravityAcpConversation(r);
      this.activeAcp = conv;
      return conv;
    }

    this.activeAcp = undefined;
    let threadId = r.conversation?.threadId;

    const acknowledgeInput = (raw: Record<string, unknown>) => {
      threadId = this.conversationId(raw) ?? threadId;
      const stepType = object(raw.step_update).step_type;
      if (
        threadId &&
        (raw.event === "user" ||
          (raw.event === "step_update" && typeof stepType === "string" && stepType !== "finish") ||
          raw.type === "assistant" ||
          (raw.event === "result" && object(raw.result).status === "SUCCESS") ||
          (raw.type === "result" && !raw.is_error))
      ) {
        r.viberMemory?.onInputAccepted?.(threadId);
      }
    };

    const message = () => ({
      event: "user",
      message: {
        content: withMemoryReference({
          prompt: r.prompt,
          memory: r.viberMemory?.recall ? r.viberMemory.recall(r.conversation?.threadId) : r.memory,
        }),
      },
    });

    const args = [
      "--mode",
      r.access === "workspace-write" ? "accept-edits" : "plan",
      "--sandbox",
      ...sharedDirectories,
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      ...(r.config.effort === "default" ? [] : ["--effort", r.config.effort]),
      ...(r.config.model ? ["--model", r.config.model] : []),
      ...(r.conversation?.threadId ? ["--conversation", r.conversation.threadId] : []),
      ...(r.conversation ? [] : ["--json-schema", r.schemaPath]),
    ];

    if (!r.conversation?.threadId && r.viberMemory?.recall) {
      return {
        program: "agy",
        args,
        inputProtocol: {
          start: (send, end) => {
            send(message());
            end();
          },
          receive: (line) => acknowledgeInput(parseLine(line)),
        } satisfies ProcessInputProtocol,
      };
    }

    if (!r.conversation?.threadId) {
      // One stdin message keeps complete task context out of OS-limited argv.
      return { program: "agy", args, input: `${JSON.stringify(message())}\n` };
    }

    const expectedThread = r.conversation.threadId;
    let dispatch: (() => void) | undefined;

    const inputProtocol: ProcessInputProtocol = {
      start: (send, end) => {
        dispatch = () => {
          dispatch = undefined;
          send(message());
          end();
        };
      },
      validate: (line) => {
        const raw = parseLine(line);
        // Print mode can initialize a different conversation when the saved ID is missing.
        if (!dispatch || raw.event !== "init") {
          return;
        }

        const id = this.conversationId(raw);
        if (!id) {
          throw new AdeError("provider_failed", "Antigravity returned no conversation identity.");
        }

        if (id !== expectedThread) {
          throw new AdeError(
            "thread_resume_rejected",
            "Antigravity could not confirm the saved thread.",
          );
        }
      },
      receive: (line) => {
        const raw = parseLine(line);

        if (!dispatch) {
          acknowledgeInput(raw);
        } else if (raw.event === "init") {
          dispatch();
        }
      },
      validateExit: ({ code, stderr }) => {
        const missing = `conversation ${JSON.stringify(expectedThread)} not found`;
        if (
          dispatch &&
          code > 0 &&
          stderr
            .split("\n")
            .some((line) => line.trim().replace(/^(?:warning|error):\s*/i, "") === missing)
        ) {
          throw new AdeError(
            "thread_resume_rejected",
            "Antigravity could not find the saved thread.",
          );
        }
      },
    };

    return { program: "agy", args, inputProtocol };
  };

  shouldObserveStdout = (raw: Record<string, unknown>) =>
    this.activeAcp?.shouldObserveStdout(raw) ?? true;

  normalize = (raw: Record<string, unknown>): NormalizedEvent[] => {
    if (this.activeAcp) {
      return this.activeAcp.normalize(raw);
    }

    if (raw.event === "init") {
      return [{ kind: "run.started", data: raw.init }];
    }

    if (raw.event === "step_update") {
      const step = object(raw.step_update);
      const type = String(step.step_type);
      // Lifecycle/input envelopes remain in raw logs, but are not reasoning.
      if (["user_input", "finish"].includes(type)) {
        return [];
      }

      let kind: NormalizedEvent["kind"] = "analysis.status";
      if (type === "agent_response") {
        kind = "message";
      } else if (type === "tool") {
        const name = String(step.tool_name || object(step.tool_info).name);

        kind = ["run_command", "send_command_input", "Bash"].includes(name)
          ? ["DONE", "ERROR"].includes(String(step.state))
            ? "command.finished"
            : "command.started"
          : ["view_file", "list_dir", "grep_search", "find_by_name"].includes(name)
            ? "file.read"
            : [
                  "write_to_file",
                  "replace_file_content",
                  "multi_replace_file_content",
                  "sed_file",
                  "notebook_edit",
                ].includes(name)
              ? "file.changed"
              : "analysis.status";
      } else if (type.includes("command")) {
        kind = step.state === "DONE" ? "command.finished" : "command.started";
      } else if (type.includes("file") && type.includes("view")) {
        kind = "file.read";
      } else if (type.includes("replace") || type.includes("write")) {
        kind = "file.changed";
      }

      const info = object(step.tool_info),
        params = object(info.parameters);

      const reportedExit =
        kind === "command.finished" && typeof info.output === "string"
          ? info.output.match(/^Command exited with code (-?\d{1,9})\.(?:\r?\n|$)/)
          : null;

      return [
        {
          kind,
          data: {
            call_id: step.step_index,
            text: step.text ?? step.thinking,
            text_delta: step.text_delta,
            command: params.CommandLine,
            stdout: info.stdout ?? info.output,
            output_source:
              info.stdout !== undefined
                ? "stdout"
                : info.output !== undefined
                  ? "provider"
                  : undefined,
            stderr: info.stderr ?? object(info.error).message,
            exit_code:
              info.exit_code ??
              step.exit_code ??
              (reportedExit ? Number(reportedExit[1]) : undefined),
            arguments: info.parameters,
            path:
              params.AbsolutePath ?? params.TargetFile ?? params.SearchPath ?? params.DirectoryPath,
            status: step.state === "ERROR" ? "failed" : step.state,
            tool: step.tool_name || info.name,
            query: params.SearchString ?? params.Query ?? params.Pattern,
            duration_ms:
              typeof step.duration_seconds === "number" ? step.duration_seconds * 1000 : undefined,
          },
        },
      ];
    }

    if (raw.event === "result") {
      const r = object(raw.result);
      return [
        {
          kind: r.status === "SUCCESS" ? "run.completed" : "run.failed",
          data: r,
        },
      ];
    }

    if (raw.type === "system") {
      return [{ kind: "run.started", data: raw }];
    }

    if (raw.type === "result") {
      return [{ kind: raw.is_error ? "run.failed" : "run.completed", data: raw }];
    }

    if (raw.type === "assistant") {
      const content = object(raw.message).content;
      if (Array.isArray(content)) {
        return content.map((v) => {
          const block = object(v);
          const name = String(block.name);
          let kind: NormalizedEvent["kind"] = "analysis.status";
          if (block.type === "text") {
            kind = "message";
          } else if (block.type === "tool_use") {
            kind = ["Read", "read_file", "view_file"].includes(name)
              ? "file.read"
              : ["Edit", "Write", "write_file"].includes(name)
                ? "file.changed"
                : ["Bash", "run_command"].includes(name)
                  ? "command.started"
                  : "analysis.status";
          }

          const input = object(block.input);
          return {
            kind,
            data: {
              ...block,
              call_id: block.id,
              tool: block.name,
              arguments: block.input,
              command: input.command,
              path: input.file_path,
              status: block.type === "tool_use" ? "running" : undefined,
            },
          };
        });
      }
    }

    return [
      {
        kind: raw.type === "user" ? "command.output" : "analysis.status",
        data: raw,
      },
    ];
  };

  result = (raw: Record<string, unknown>, conversation = false) => {
    if (this.activeAcp || (raw.type !== "result" && raw.event !== "result")) {
      return undefined;
    }

    const nested = object(raw.result);

    const value =
      raw.structured_output ?? nested.structured_output ?? nested.response ?? raw.result;

    if (value && typeof value === "object") {
      return value;
    }

    if (typeof value === "string") {
      if (conversation) {
        return { summary: value };
      }

      try {
        return JSON.parse(value);
      } catch {
        const start = value.indexOf("{"),
          end = value.lastIndexOf("}");

        if (start >= 0 && end > start) {
          try {
            return JSON.parse(value.slice(start, end + 1));
          } catch {
            return undefined;
          }
        }
      }
    }

    return undefined;
  };

  outputSchema = (schema: Record<string, unknown>) => ({
    ...schema,
    properties: {
      toolAction: { type: "string" },
      toolSummary: { type: "string" },
      ...object(schema.properties),
    },
  });

  parseStructuredOutput = (schema: Record<string, unknown>, value: unknown) => {
    const plan = { ...object(value) };
    const properties = object(schema.properties);
    if (!("toolAction" in properties)) {
      delete plan.toolAction;
    }

    if (!("toolSummary" in properties)) {
      delete plan.toolSummary;
    }

    return plan;
  };

  conversationId = (raw: Record<string, unknown>) => {
    if (this.activeAcp) {
      return this.activeAcp.conversationId(raw);
    }

    const init = object(raw.init);
    const result = object(raw.result);

    const id =
      raw.conversation_id ??
      init.conversation_id ??
      result.conversation_id ??
      raw.session_id ??
      init.session_id;

    return typeof id === "string" && id.length > 0 ? id : null;
  };
}
