import type { AgentEvent, Run } from "../../../lib/types";
import { eventData } from "./events";

const terminalStatus = (value: unknown) =>
  [
    "done",
    "completed",
    "failed",
    "error",
    "blocked",
    "interrupted",
    "cancelled",
    "success",
    "succeeded",
    "passed",
    "skipped",
    "not_run",
  ].includes(String(value).toLowerCase());

export const agentEntries = (events: AgentEvent[], search = "") => {
  const entries: {
    key: string | number;
    event: AgentEvent;
    initial: AgentEvent;
    matches: boolean;
    data: Record<string, unknown>;
  }[] = [];

  const calls = new Map<string, number>();

  // Persisted IDs establish arrival order even when paged context precedes older deltas.
  const ordered = [...new Map(events.map((event) => [event.id, event])).values()].sort(
    (a, b) => a.id - b.id,
  );

  for (const event of ordered) {
    if (event.kind.startsWith("run.") && !["run.failed", "run.cancelled"].includes(event.kind)) {
      continue;
    }

    const data = eventData(event.data);
    if (["userMessage", "user_message", "user_input"].includes(String(data.tool))) {
      continue;
    }

    if (
      event.kind === "analysis.status" &&
      ![
        data.text,
        data.text_delta,
        data.tool,
        data.query,
        data.command,
        data.path,
        data.unparsed,
      ].some((value) => typeof value === "string" && value.trim())
    ) {
      continue;
    }

    const matches =
      !search || `${event.data}\n${event.raw}`.toLowerCase().includes(search.toLowerCase());

    const call = data.call_id != null ? `${event.run_id}/${data.call_id}` : null;
    const index = call ? calls.get(call) : undefined;
    if (index !== undefined) {
      const row = entries[index];
      row.matches ||= matches;
      const clean = Object.fromEntries(Object.entries(data).filter(([, value]) => value != null));

      const terminal = row.event.kind === "command.finished" || terminalStatus(row.data.status);

      const incomingTerminal = event.kind === "command.finished" || terminalStatus(data.status);

      row.data = {
        ...row.data,
        ...clean,
        ...(terminal && !incomingTerminal
          ? { status: row.data.status, exit_code: row.data.exit_code }
          : {}),
        ...(typeof data.text !== "string" && typeof data.text_delta === "string"
          ? { text: `${row.data.text || ""}${data.text_delta}` }
          : {}),
        ...(typeof data.stdout !== "string" && typeof data.stdout_delta === "string"
          ? { stdout: `${row.data.stdout || ""}${data.stdout_delta}` }
          : {}),
      };

      if (!terminal || incomingTerminal) {
        row.event = event;
      }
    } else {
      if (call) {
        calls.set(call, entries.length);
      }

      entries.push({
        key: call || event.id,
        event,
        initial: event,
        matches,
        data: {
          ...data,
          text: data.text ?? data.text_delta,
          stdout: data.stdout ?? data.stdout_delta,
        },
      });
    }
  }

  return entries.filter(
    ({ event, data }) =>
      event.kind !== "message" || (typeof data.text === "string" && data.text.trim()),
  );
};

export const toolState = (event: AgentEvent, data: Record<string, unknown>, run?: Run) => {
  const status = String(data.status || "").toLowerCase();
  if (["interrupted", "cancelled", "canceled"].includes(status)) {
    return "interrupted";
  }

  if (status === "blocked") {
    return "blocked";
  }

  if (
    ["failed", "error"].includes(status) ||
    (typeof data.exit_code === "number" && data.exit_code !== 0)
  ) {
    return "failed";
  }

  if (["skipped", "not_run"].includes(status)) {
    return "skipped";
  }

  if (
    event.kind === "command.finished" ||
    typeof data.exit_code === "number" ||
    ["done", "completed", "success", "succeeded", "passed"].includes(status)
  ) {
    return "completed";
  }

  if (run && run.status !== "running") {
    return "interrupted";
  }

  return "running";
};
