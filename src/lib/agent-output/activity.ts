import type { AgentEvent, Run } from "../types";
import { eventData } from "../api";
import { commandVerification } from "../../../backend/execution/verification";

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
  if (status === "blocked") return "blocked";
  if (
    event.kind.startsWith("command") &&
    (typeof data.exit_code === "number" || ["failed", "error"].includes(status))
  ) {
    const verification = commandVerification({
      id: String(event.id),
      command: Array.isArray(data.command)
        ? JSON.stringify(data.command)
        : String(data.command || ""),
      status: status === "error" ? "failed" : status,
      exit_code: typeof data.exit_code === "number" ? data.exit_code : null,
      stdout: typeof data.stdout === "string" ? data.stdout : "",
      stderr: typeof data.stderr === "string" ? data.stderr : "",
    });
    if (["blocked", "interrupted"].includes(verification.outcome))
      return verification.outcome === "blocked" ? "blocked" : "interrupted";
  }
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

export const runActivity = (events: AgentEvent[], run?: Run) => {
  const entries = agentEntries(
    events.filter((e) => e.run_id === run?.id && e.stream !== "stderr"),
  );
  const runningTool = [...entries]
    .reverse()
    .find(
      (e) =>
        (e.data.tool ||
          e.event.kind.startsWith("command.") ||
          e.event.kind.startsWith("file.")) &&
        (e.data.status != null || e.event.kind === "command.started") &&
        toolState(e.event, e.data, run) === "running",
    );
  const entry =
    runningTool ||
    [...entries]
      .reverse()
      .find((e) =>
        [e.data.text, e.data.query, e.data.command, e.data.path].some(
          (value) => typeof value === "string" && value.trim(),
        ),
      );
  const event = entry?.event;
  const data = entry?.data || {};
  const path =
    data.path || (Array.isArray(data.files) ? data.files.join(", ") : "");
  const observedActivity =
    typeof data.query === "string"
      ? `Searching: ${data.query}${path ? " · " + path : ""}`
      : event?.kind === "file.changed"
        ? `Editing: ${path || "file change reported"}`
        : event?.kind === "file.read"
          ? `Reading: ${path || "file read reported"}`
          : typeof data.command === "string"
            ? data.command
            : typeof data.text === "string"
              ? data.text
              : typeof data.text_delta === "string"
                ? data.text_delta
                : "Waiting for provider activity…";
  return entry &&
    event?.kind !== "message" &&
    toolState(entry.event, data, run) !== "running"
    ? `${toolState(entry.event, data, run)} · ${observedActivity}`
    : observedActivity;
};
