import type { AgentEvent, Run } from "../types";
import { eventData } from "../api";

export const agentEntries = (events: AgentEvent[], search = "") => {
  const entries: {
    key: number;
    event: AgentEvent;
    initial: AgentEvent;
    matches: boolean;
    data: Record<string, unknown>;
  }[] = [];
  const calls = new Map<string, number>();
  for (const event of events) {
    if (
      event.kind.startsWith("run.") &&
      !["run.failed", "run.cancelled"].includes(event.kind)
    )
      continue;
    const data = eventData(event.data);
    const matches =
      !search ||
      `${event.data}\n${event.raw}`
        .toLowerCase()
        .includes(search.toLowerCase());
    const call =
      data.call_id != null ? `${event.run_id}/${data.call_id}` : null;
    const index = call ? calls.get(call) : undefined;
    if (index !== undefined) {
      const row = entries[index];
      row.matches ||= matches;
      const clean = Object.fromEntries(
        Object.entries(data).filter(([, value]) => value != null),
      );
      row.data = {
        ...row.data,
        ...clean,
        ...(typeof data.text_delta === "string"
          ? { text: `${row.data.text || ""}${data.text_delta}` }
          : {}),
      };
      if (
        row.event.kind !== "command.finished" ||
        event.kind !== "command.output"
      )
        row.event = event;
    } else {
      if (call) calls.set(call, entries.length);
      entries.push({
        key: event.id,
        event,
        initial: event,
        matches,
        data: { ...data, text: data.text_delta ?? data.text },
      });
    }
  }
  return entries;
};

export const toolState = (
  event: AgentEvent,
  data: Record<string, unknown>,
  run?: Run,
) => {
  const status = String(data.status || "").toLowerCase();
  if (["interrupted", "cancelled", "canceled"].includes(status))
    return "interrupted";
  if (
    ["failed", "error"].includes(status) ||
    (typeof data.exit_code === "number" && data.exit_code !== 0)
  )
    return "failed";
  if (["skipped", "not_run"].includes(status)) return "skipped";
  if (
    event.kind === "command.finished" ||
    typeof data.exit_code === "number" ||
    ["done", "completed", "success", "succeeded", "passed"].includes(status)
  )
    return "completed";
  if (run && run.status !== "running") return "interrupted";
  return "running";
};
