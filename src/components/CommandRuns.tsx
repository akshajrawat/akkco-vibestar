import { useState } from "react";
import type { Detail } from "../lib/types";
import { duration, parseArgv } from "../lib/api";
import { Status } from "./Status";

const displayCommand = (command: string) => {
  if (!command.trim().startsWith("[")) return command;
  try {
    return parseArgv(command)
      .map((arg) => (/^[\w./:=@-]+$/.test(arg) ? arg : JSON.stringify(arg)))
      .join(" ");
  } catch {
    return command;
  }
};

export const CommandRuns = ({ detail }: { detail: Detail }) => {
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [stage, setStage] = useState("all");
  const [stream, setStream] = useState("all");
  const commands = detail.tests.filter((test) => {
    const run = detail.runs.find((r) => r.id === test.run_id);
    return (
      test.command.toLowerCase().includes(query.toLowerCase()) &&
      (status === "all" || test.status === status) &&
      (stage === "all" ||
        (stage === "manual" ? !run : String(run?.stage) === stage))
    );
  });
  const command =
    commands.find((test) => test.id === selected) || commands.at(-1);
  const run = detail.runs.find((r) => r.id === command?.run_id);
  const label = (runId?: string | null) => {
    const run = detail.runs.find((r) => r.id === runId);
    return run
      ? `${run.provider} · ${run.purpose || `stage ${run.stage}`}`
      : "Manual / validation";
  };
  return (
    <section className="command-runs" aria-label="Command executions">
      <h2>
        Command executions{" "}
        <small>
          {commands.length} / {detail.tests.length}
        </small>
      </h2>
      <div className="command-filters">
        <input
          aria-label="Search commands"
          placeholder="Find a test, lint or command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="Command status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="all">All results</option>
          {[
            "running",
            "passed",
            "failed",
            "completed",
            "interrupted",
            "cancelled",
          ].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <select
          aria-label="Command stage"
          value={stage}
          onChange={(e) => setStage(e.target.value)}
        >
          <option value="all">All stages</option>
          <option value="1">Gemini planning</option>
          <option value="2">Codex refinement</option>
          <option value="3">Implementation</option>
          <option value="5">Final review</option>
          <option value="manual">Manual / validation</option>
        </select>
      </div>
      <div className="command-browser">
        <div
          className="command-list"
          role="list"
          aria-label="Recorded commands"
        >
          {commands.map((test) => (
            <button
              key={test.id}
              aria-current={command?.id === test.id ? "true" : undefined}
              onClick={() => setSelected(test.id)}
              className={`command-row ${test.status === "failed" ? "command-failed" : ""}`}
            >
              {test.status === "completed" ? (
                <span className="subtle">Completed · exit unreported</span>
              ) : (
                <Status status={test.status} />
              )}
              <code title={test.command}>{displayCommand(test.command)}</code>
              <small>
                {label(test.run_id)} ·{" "}
                {new Date(test.started_at).toLocaleTimeString()} ·{" "}
                {duration(test.started_at, test.ended_at)}
              </small>
            </button>
          ))}
          {!commands.length && (
            <p className="empty-row">
              {detail.tests.length
                ? "No commands match these filters."
                : "No command executions recorded yet."}
            </p>
          )}
        </div>
        {command && (
          <div className="command-transcript">
            <div className="command-log-heading">
              <strong>{label(command.run_id)}</strong>
              <span>
                {command.status} · exit{" "}
                {command.exit_code ??
                  (command.ended_at ? "unreported" : "pending")}
              </span>
              <span>{duration(command.started_at, command.ended_at)}</span>
              <select
                aria-label="Command output stream"
                value={stream}
                onChange={(e) => setStream(e.target.value)}
              >
                <option value="all">stdout + stderr</option>
                <option value="stdout">stdout</option>
                <option value="stderr">stderr</option>
              </select>
            </div>
            {!!command.output_truncated && (
              <p className="warning">
                Showing the last 1 MiB per stream.
                {run
                  ? ` Full provider output is available in Logs for ${run.provider}.`
                  : " Live command output is bounded; the final capture replaces it when the command finishes."}
              </p>
            )}
            <pre className="command-log" aria-label="Selected command output">
              <span className="command-invocation">
                $ {displayCommand(command.command)}
                {"\n\n"}
              </span>
              {stream !== "stderr" && (
                <>
                  {command.stdout || "(no stdout yet)"}
                  {"\n"}
                </>
              )}
              {stream !== "stdout" && (
                <span className="command-stderr">
                  {"\n[stderr]\n"}
                  {command.stderr || "(empty)"}
                </span>
              )}
            </pre>
          </div>
        )}
      </div>
    </section>
  );
};
