import { useMemo } from "react";
import {
  FileSearch,
  FilePenLine,
  TerminalSquare,
  FlaskConical,
  CircleAlert,
  Brain,
  MessageSquare,
  Check,
  LoaderCircle,
} from "lucide-react";
import type { AgentEvent, Run } from "../lib/types";
import { eventText, eventData } from "../lib/api";
import { AgentResponse } from "./AgentResponse";
const labels: Record<string, string> = {
  "run.started": "Agent started",
  message: "Agent response",
  "analysis.status": "Thinking",
  "file.read": "Reading / searching files",
  "file.changed": "Editing files",
  "command.started": "Running command",
  "command.output": "Command output",
  "command.finished": "Command finished",
  "test.result": "Test result",
  "run.completed": "Agent finished",
  "run.failed": "Run failed",
  "run.cancelled": "Run cancelled",
};
export const AgentTimeline = ({
  events,
  runs,
}: {
  events: AgentEvent[];
  runs: Run[];
}) => {
  const entries = useMemo(() => {
    const result: {
      key: number;
      event: AgentEvent;
      text: string;
      data: Record<string, unknown>;
    }[] = [];
    const calls = new Map<string, number>();
    for (const event of events) {
      const data = eventData(event.data);
      const text = eventText(event.data);
      if (event.kind === "message" && !data.text && !data.text_delta) continue;
      if (
        event.kind === "analysis.status" &&
        !data.text &&
        !data.text_delta &&
        !data.tool
      )
        continue;
      const call =
        data.call_id !== undefined &&
        !["message", "analysis.status"].includes(event.kind)
          ? `${event.run_id}/${String(data.call_id)}`
          : null;
      if (call && calls.has(call)) {
        const row = result[calls.get(call)!];
        row.event = event;
        row.data = { ...row.data, ...data };
        row.text = text;
        continue;
      }
      const previous = result.at(-1);
      if (
        previous &&
        previous.event.run_id === event.run_id &&
        previous.event.kind === event.kind &&
        ["message", "analysis.status"].includes(event.kind) &&
        typeof data.text === "string" &&
        typeof previous.data.text === "string"
      ) {
        previous.text += text;
      } else {
        if (call) calls.set(call, result.length);
        result.push({ key: event.id, event, text, data });
      }
    }
    return result;
  }, [events]);
  return (
    <>
      {entries.map(({ key, event: e, text, data }) => {
        const run = runs.find((r) => r.id === e.run_id);
        const tool = e.kind !== "message";
        const Icon = e.kind.startsWith("command")
          ? TerminalSquare
          : e.kind === "file.read"
            ? FileSearch
            : e.kind === "file.changed"
              ? FilePenLine
              : e.kind === "test.result"
                ? FlaskConical
                : e.kind === "run.failed"
                  ? CircleAlert
                  : e.kind === "analysis.status"
                    ? Brain
                    : MessageSquare;
        const finished = [
          "command.finished",
          "run.completed",
          "test.result",
        ].includes(e.kind);
        const failed =
          e.kind === "run.failed" ||
          (typeof data.exit_code === "number" && data.exit_code !== 0) ||
          ["failed", "error"].includes(String(data.status).toLowerCase());
        const preview =
          typeof data.command === "string"
            ? data.command
            : typeof data.path === "string"
              ? data.path
              : Array.isArray(data.files)
                ? data.files.join(", ")
                : typeof data.text === "string"
                  ? data.text.slice(0, 160)
                  : typeof data.status === "string"
                    ? data.status
                    : e.kind === "run.started"
                      ? run?.model || "CLI default model"
                      : "";
        return (
          <article
            className={`agent-event ${tool ? "tool-event" : "message-event"} ${failed ? "tool-failed" : ""}`}
            key={key}
          >
            <div className="event-label">
              <small>
                {run?.provider}
                {run?.purpose === "scheduled" ? " · PR analysis" : ""}
              </small>
              <time>{new Date(e.timestamp).toLocaleTimeString()}</time>
              {run?.model && <code>{run.model}</code>}
            </div>
            {tool ? (
              <details open={failed}>
                <summary>
                  <Icon size={14} />
                  <span>
                    {failed && e.kind.startsWith("command")
                      ? "Command failed"
                      : labels[e.kind] || e.kind}
                  </span>
                  <code>{preview}</code>
                  {finished ? (
                    <Check
                      size={12}
                      className={failed ? "failure" : "success"}
                    />
                  ) : e.kind === "command.started" && !failed ? (
                    <LoaderCircle size={12} className="running" />
                  ) : null}
                  {typeof data.exit_code === "number" && (
                    <small className={failed ? "failure" : "subtle"}>
                      exit {data.exit_code}
                    </small>
                  )}
                </summary>
                <div className="tool-details">
                  {typeof data.command === "string" && (
                    <code className="tool-command">$ {data.command}</code>
                  )}
                  <pre>
                    {typeof data.stdout === "string"
                      ? data.stdout
                      : typeof data.stderr === "string"
                        ? data.stderr
                        : text}
                  </pre>
                  {typeof data.duration_ms === "number" && (
                    <small>{Math.round(data.duration_ms)} ms</small>
                  )}
                  {data.source === "provider-reported" && (
                    <small>Provider-reported test result</small>
                  )}
                </div>
              </details>
            ) : (
              <AgentResponse text={text} />
            )}
          </article>
        );
      })}
      {!events.length && (
        <p className="empty-row">Events appear here as the pipeline runs.</p>
      )}
    </>
  );
};
