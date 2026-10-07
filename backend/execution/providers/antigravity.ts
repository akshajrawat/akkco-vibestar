import { capture, checked } from "../process";
import {
  object,
  verifyFlags,
  type AgentProvider,
  type AgentRunRequest,
  type ProviderDetection,
} from "./contracts";
import type { NormalizedEvent } from "../../domain";
export class AntigravityProvider implements AgentProvider {
  readonly name = "antigravity";
  detect = async (
    cwd: string,
    signal?: AbortSignal,
  ): Promise<ProviderDetection> => {
    const d: ProviderDetection = {
      provider: this.name,
      installed: false,
      version: "",
      authentication: "Unknown · official CLI owns authentication",
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
        "--output-format",
        "--json-schema",
      ]);
      const models = await capture("agy", ["models"], cwd, signal);
      if (models.code === 0) {
        d.models = (models.stdout + models.stderr)
          .split("\n")
          .filter((s) => s.includes("\t"))
          .map((s) => s.split("\t")[0]);
        d.authentication = "Model discovery available · account owned by CLI";
      } else d.error = models.stderr;
      d.capabilities = [
        "plan-mode",
        "sandbox",
        "structured-events",
        "schema",
        "model-discovery",
      ];
    } catch (e) {
      d.error = String(e);
    }
    return d;
  };
  invocation = (r: AgentRunRequest) => ({
    program: "agy",
    args: [
      "--mode",
      r.stage === 3 ? "accept-edits" : "plan",
      "--sandbox",
      "--output-format",
      "stream-json",
      "--effort",
      r.config.effort,
      ...(r.config.model ? ["--model", r.config.model] : []),
      "--json-schema",
      JSON.stringify(r.schema),
      "-p",
      r.prompt,
    ],
  });
  normalize = (raw: Record<string, unknown>): NormalizedEvent[] => {
    if (raw.event === "init") return [{ kind: "run.started", data: raw.init }];
    if (raw.event === "step_update") {
      const step = object(raw.step_update);
      const type = String(step.step_type);
      // Lifecycle/input envelopes remain in raw logs, but are not reasoning.
      if (["user_input", "finish", "system_message"].includes(type)) return [];
      let kind: NormalizedEvent["kind"] = "analysis.status";
      if (type === "agent_response") kind = "message";
      else if (type === "tool") {
        const name = String(step.tool_name || object(step.tool_info).name);
        kind = ["run_command", "send_command_input", "Bash"].includes(name)
          ? ["DONE", "ERROR"].includes(String(step.state))
            ? "command.finished"
            : "command.started"
          : ["view_file", "list_dir", "grep_search", "find_by_name"].includes(
                name,
              )
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
      } else if (type.includes("command"))
        kind = step.state === "DONE" ? "command.finished" : "command.started";
      else if (type.includes("file") && type.includes("view"))
        kind = "file.read";
      else if (type.includes("replace") || type.includes("write"))
        kind = "file.changed";
      const info = object(step.tool_info),
        params = object(info.parameters);
      return [
        {
          kind,
          data: {
            call_id: step.step_index,
            text: step.text ?? step.thinking,
            text_delta: step.text_delta,
            command: params.CommandLine,
            stdout: info.output,
            stderr: object(info.error).message,
            path:
              params.AbsolutePath ??
              params.TargetFile ??
              params.SearchPath ??
              params.DirectoryPath,
            status: step.state === "ERROR" ? "failed" : step.state,
            tool: step.tool_name,
            query: params.SearchString ?? params.Query ?? params.Pattern,
            duration_ms:
              typeof step.duration_seconds === "number"
                ? step.duration_seconds * 1000
                : undefined,
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
    if (raw.type === "system") return [{ kind: "run.started", data: raw }];
    if (raw.type === "result")
      return [
        { kind: raw.is_error ? "run.failed" : "run.completed", data: raw },
      ];
    if (raw.type === "assistant") {
      const content = object(raw.message).content;
      if (Array.isArray(content))
        return content.map((v) => {
          const block = object(v);
          const name = String(block.name);
          let kind: NormalizedEvent["kind"] = "analysis.status";
          if (block.type === "text") kind = "message";
          else if (block.type === "tool_use")
            kind = ["Read", "read_file", "view_file"].includes(name)
              ? "file.read"
              : ["Edit", "Write", "write_file"].includes(name)
                ? "file.changed"
                : ["Bash", "run_command"].includes(name)
                  ? "command.started"
                  : "analysis.status";
          return { kind, data: block };
        });
    }
    return [
      {
        kind: raw.type === "user" ? "command.output" : "analysis.status",
        data: raw,
      },
    ];
  };
  result = (raw: Record<string, unknown>) => {
    if (raw.type !== "result" && raw.event !== "result") return undefined;
    const nested = object(raw.result);
    const value =
      raw.structured_output ??
      nested.structured_output ??
      nested.response ??
      raw.result;
    if (value && typeof value === "object") return value;
    if (typeof value === "string") {
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
  conversationId = (raw: Record<string, unknown>) =>
    typeof raw.session_id === "string"
      ? raw.session_id
      : typeof raw.conversation_id === "string"
        ? raw.conversation_id
        : typeof object(raw.result).conversation_id === "string"
          ? (object(raw.result).conversation_id as string)
          : null;
}
