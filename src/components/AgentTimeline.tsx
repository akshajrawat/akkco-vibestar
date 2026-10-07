import { useMemo } from "react";
import {
  FileSearch,
  FilePenLine,
  TerminalSquare,
  FlaskConical,
  Brain,
  Check,
  LoaderCircle,
} from "lucide-react";
import type { AgentEvent, Run, Message, DiffFile } from "../lib/types";
import { eventData, duration } from "../lib/api";
import { AgentResponse } from "./AgentResponse";
export const AgentTimeline = ({
  events,
  runs,
  messages = [],
  files = [],
  openDiff,
}: {
  events: AgentEvent[];
  runs: Run[];
  messages?: Message[];
  files?: DiffFile[];
  openDiff?: (path: string) => void;
}) => {
  const entries = useMemo(() => {
    const result: {
      key: number;
      event: AgentEvent;
      data: Record<string, unknown>;
    }[] = [];
    const calls = new Map<string, number>();
    for (const event of events) {
      const data = eventData(event.data);
      if (event.kind.startsWith("run.") || event.stream === "stderr") continue;
      if (
        ["message", "analysis.status"].includes(event.kind) &&
        !data.text &&
        !data.text_delta &&
        !data.tool
      )
        continue;
      const call =
        data.call_id !== undefined ? `${event.run_id}/${data.call_id}` : null;
      if (call && calls.has(call)) {
        const row = result[calls.get(call)!];
        row.event = event;
        const clean = Object.fromEntries(
          Object.entries(data).filter(([, v]) => v !== undefined && v !== null),
        );
        const text = data.text_delta
          ? `${row.data.text || ""}${data.text_delta}`
          : data.text;
        row.data = { ...row.data, ...clean, ...(text ? { text } : {}) };
      } else {
        if (call) calls.set(call, result.length);
        result.push({
          key: event.id,
          event,
          data: { ...data, text: data.text_delta || data.text },
        });
      }
    }
    return result;
  }, [events]);
  const renderTool = (row: (typeof entries)[number]) => {
    const { event, data } = row;
    const run = runs.find((r) => r.id === event.run_id);
    if (event.kind === "message")
      return (
        <article className="message-event" key={row.key}>
          <AgentResponse text={String(data.text || "")} />
        </article>
      );
    const search =
      /search|grep|find_by_name/.test(String(data.tool)) ||
      /\b(rg|grep|find)\b/.test(String(data.command));
    const edited = event.kind === "file.changed";
    const command = event.kind.startsWith("command");
    const failed =
      (typeof data.exit_code === "number" && data.exit_code !== 0) ||
      ["failed", "error"].includes(String(data.status).toLowerCase());
    const finished =
      event.kind === "command.finished" ||
      ["done", "completed"].includes(String(data.status).toLowerCase()) ||
      run?.status !== "running";
    const Icon = edited
      ? FilePenLine
      : search || event.kind === "file.read"
        ? FileSearch
        : command
          ? TerminalSquare
          : event.kind === "test.result"
            ? FlaskConical
            : Brain;
    const label = search
      ? "Search"
      : edited
        ? "Edited"
        : event.kind === "file.read"
          ? "Read file"
          : command
            ? failed
              ? "Command failed"
              : finished
                ? "Ran"
                : "Running command"
            : event.kind === "test.result"
              ? `Test ${data.status || "result"}`
              : "Working";
    const paths = (
      Array.isArray(data.files)
        ? data.files
        : edited && data.path
          ? [data.path]
          : []
    ).map(String);
    const preview = String(
      data.command || data.path || data.query || data.text || "",
    );
    return (
      <article
        className={`tool-event ${failed ? "tool-failed" : ""}`}
        key={row.key}
      >
        <details open={failed}>
          <summary>
            <Icon size={13} />
            <span>{label}</span>
            <code>
              {paths.length
                ? `${paths.length} file${paths.length === 1 ? "" : "s"}`
                : preview}
            </code>
            {finished && !failed ? (
              <Check size={12} className="success" />
            ) : !finished ? (
              <LoaderCircle size={12} className="running spinning" />
            ) : null}
            {typeof data.duration_ms === "number" && (
              <small>{Math.round(data.duration_ms / 1000)}s</small>
            )}
          </summary>
          <div className="tool-details">
            {paths.map((path) => {
              const file = files.find(
                (f) => path === f.path || path.endsWith(`/${f.path}`),
              );
              return (
                <button
                  className="edited-file"
                  key={path}
                  onClick={() => openDiff?.(file?.path || path)}
                >
                  <FilePenLine size={12} />
                  <code>{file?.path || path}</code>
                  <span className="spacer" />
                  {file && (
                    <>
                      <span className="success">+{file.insertions}</span>
                      <span className="failure">−{file.deletions}</span>
                    </>
                  )}
                </button>
              );
            })}
            {!paths.length && (
              <pre>
                {String(
                  data.stdout ||
                    data.stderr ||
                    data.text ||
                    data.path ||
                    data.command ||
                    "",
                )}
              </pre>
            )}
            {typeof data.exit_code === "number" && (
              <small>Exit {data.exit_code}</small>
            )}
            {data.source === "provider-reported" && (
              <small>Provider reported</small>
            )}
          </div>
        </details>
        {edited && paths.length === 1 && (
          <button
            className="inline-diff-link"
            onClick={() => openDiff?.(paths[0])}
          >
            Open diff ↗
          </button>
        )}
      </article>
    );
  };
  const blocks: { time: string; key: string; content: React.ReactNode }[] = [];
  for (const message of messages)
    blocks.push({
      time: message.created_at,
      key: message.id,
      content: (
        <article className="user-message">
          <small>You</small>
          <p>
            {
              message.content.split(
                "\n\nLinked PR review context (untrusted):",
              )[0]
            }
          </p>
        </article>
      ),
    });
  const groupedRuns = runs.length
    ? runs
    : [
        {
          id: "",
          provider: "Agent",
          started_at: "",
          status: "",
          stage: 0,
        } as Run,
      ];
  for (const run of groupedRuns) {
    const local = entries.filter((e) => !run.id || e.event.run_id === run.id);
    blocks.push({
      time: run.started_at,
      key: run.id || "ungrouped",
      content: (
        <section className="agent-turn">
          {run.id && (
            <div className="agent-turn-heading">
              <span className={`agent-avatar ${run.provider}`}>
                {run.provider === "antigravity" ? "A" : "C"}
              </span>
              <strong>
                {run.provider === "antigravity" ? "Antigravity" : "Codex"}
              </strong>
              <span className="subtle">
                {run.purpose === "scheduled"
                  ? "PR review"
                  : run.stage === 1
                    ? "Planning"
                    : run.stage === 2
                      ? "Reviewing plan"
                      : "Implementing"}
              </span>
              <small>
                {run.model || "CLI default"} · {run.effort}
              </small>
            </div>
          )}
          {local
            .filter(
              (row) =>
                !(
                  row.event.kind === "message" &&
                  run.output &&
                  String(row.data.text).trim().startsWith("{")
                ),
            )
            .map(renderTool)}
          {run.output && run.status === "completed" && (
            <AgentResponse text={run.output} />
          )}
          {run.error && <p className="error-box">{run.error}</p>}
          {run.id && (
            <div className="turn-outcome">
              {run.status === "running" ? (
                <>
                  <LoaderCircle size={12} className="spinning" />
                  Working…
                </>
              ) : (
                <>
                  {run.status === "completed" ? <Check size={12} /> : null}
                  {run.status === "completed"
                    ? run.stage === 1
                      ? "Plan completed"
                      : run.stage === 2
                        ? "Plan refined"
                        : "Implementation completed"
                    : run.status}{" "}
                  · {duration(run.started_at, run.ended_at)}
                </>
              )}
            </div>
          )}
        </section>
      ),
    });
  }
  return (
    <>
      {blocks
        .sort((a, b) => a.time.localeCompare(b.time))
        .map((b) => (
          <div key={b.key}>{b.content}</div>
        ))}
    </>
  );
};
