import { capture, checked } from "../process";
import {
  object,
  verifyFlags,
  type AgentProvider,
  type AgentRunRequest,
  type ProviderDetection,
} from "./contracts";
import type { NormalizedEvent } from "../../domain";
export class CodexProvider implements AgentProvider {
  readonly name = "codex";
  detect = async (
    cwd: string,
    signal?: AbortSignal,
  ): Promise<ProviderDetection> => {
    const d: ProviderDetection = {
      provider: this.name,
      installed: false,
      version: "",
      authentication: "Not connected",
      models: [],
      efforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
      capabilities: [],
      error: null,
    };
    try {
      d.version = await checked("codex", ["--version"], cwd, signal);
      d.installed = true;
      verifyFlags(await checked("codex", ["--help"], cwd, signal), [
        "--no-daemon",
      ]);
      const help = await checked("codex", ["exec", "--help"], cwd, signal);
      verifyFlags(help, [
        "--json",
        "--sandbox",
        "--output-schema",
        "--ignore-user-config",
        "--ignore-rules",
      ]);
      d.capabilities = [
        "read-only",
        "workspace-write",
        "structured-events",
        "schema",
        "subscription-auth",
      ];
      const login = await capture("codex", ["login", "status"], cwd, signal);
      const output = login.stdout + login.stderr;
      d.authentication =
        login.code === 0 && output.includes("ChatGPT")
          ? "Connected · ChatGPT subscription"
          : login.code === 0
            ? "API-key login detected; connect with ChatGPT to use subscription"
            : "Not connected";
    } catch (e) {
      d.error = String(e);
    }
    return d;
  };
  invocation = (r: AgentRunRequest) => ({
    program: "codex",
    args: [
      "--no-daemon",
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--json",
      "--color",
      "never",
      "--sandbox",
      r.stage === 3 ? "workspace-write" : "read-only",
      "-C",
      r.cwd,
      "-c",
      `model_reasoning_effort=${JSON.stringify(r.config.effort)}`,
      "-c",
      'approval_policy="never"',
      "-c",
      'forced_login_method="chatgpt"',
      "-c",
      "sandbox_workspace_write.network_access=false",
      "--output-schema",
      r.schemaPath,
      ...(r.config.model ? ["--model", r.config.model] : []),
      "-",
    ],
    input: r.prompt,
  });
  normalize = (raw: Record<string, unknown>): NormalizedEvent[] => {
    const event = raw.type;
    const item = object(raw.item);
    let kind: NormalizedEvent["kind"] = "analysis.status";
    if (event === "thread.started") kind = "run.started";
    else if (event === "turn.completed") kind = "run.completed";
    else if (event === "turn.failed" || event === "error") kind = "run.failed";
    else if (
      ["item.started", "item.updated", "item.completed"].includes(String(event))
    ) {
      if (item.type === "agent_message") kind = "message";
      else if (item.type === "file_change") kind = "file.changed";
      else if (item.type === "command_execution")
        kind =
          event === "item.started"
            ? "command.started"
            : event === "item.completed"
              ? "command.finished"
              : "command.output";
    }
    return [
      {
        kind,
        data: Object.keys(item).length
          ? {
              call_id: item.id,
              text: item.text,
              command: item.command,
              stdout: item.aggregated_output,
              exit_code: item.exit_code,
              status: item.status,
              files: Array.isArray(item.changes)
                ? item.changes.map((change) => object(change).path)
                : undefined,
            }
          : raw,
      },
    ];
  };
  result = (raw: Record<string, unknown>) => {
    const item = object(raw.item);
    if (
      raw.type === "item.completed" &&
      item.type === "agent_message" &&
      typeof item.text === "string"
    ) {
      try {
        return JSON.parse(item.text);
      } catch {
        return undefined;
      }
    }
    return undefined;
  };
  conversationId = (raw: Record<string, unknown>) =>
    typeof raw.thread_id === "string" ? raw.thread_id : null;
}
