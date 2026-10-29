import { useEffect, useRef, useState } from "react";

import type { Detail } from "../../lib/types";
import { duration } from "../../lib/format";
import { parseArgv } from "./commands";
import { Status } from "../../components/shared/Status";
import { Select } from "../../components/ui/Select";
import { commandVerification } from "../../../backend/execution/verification/verification";

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

export const CommandRuns = ({
  detail,
  selectedId = "",
}: {
  detail: Pick<Detail, "tests" | "runs">;
  selectedId?: string;
}) => {
  const [selected, setSelected] = useState(selectedId);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [stage, setStage] = useState("all");
  const [stream, setStream] = useState("all");
  const transcript = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selectedId) {
      transcript.current?.focus();
      transcript.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [selectedId]);

  const commands = detail.tests.filter((test) => {
    const run = detail.runs.find((r) => r.id === test.run_id);
    return (
      test.command.toLowerCase().includes(query.toLowerCase()) &&
      (status === "all" ||
        (test.status === "running" ? "running" : commandVerification(test).outcome) === status) &&
      (stage === "all" || (stage === "manual" ? !run : String(run?.stage) === stage))
    );
  });

  const command = commands.find((test) => test.id === selected) || commands.at(-1);
  const run = detail.runs.find((r) => r.id === command?.run_id);
  const evidence = command ? commandVerification(command) : null;

  const label = (runId?: string | null) => {
    const run = detail.runs.find((r) => r.id === runId);
    return run ? `${run.provider} · ${run.purpose || `stage ${run.stage}`}` : "Manual / validation";
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

        <Select
          label="Command status"
          value={status}
          onChange={setStatus}
          options={[
            { value: "all", label: "All results" },
            ...["running", "passed", "failed", "blocked", "unknown", "interrupted"].map(
              (value) => ({ value, label: value }),
            ),
          ]}
        />

        <Select
          label="Command stage"
          value={stage}
          onChange={setStage}
          options={[
            { value: "all", label: "All stages" },
            { value: "1", label: "Plan" },
            { value: "2", label: "Plan refinement" },
            { value: "3", label: "Implementation" },
            { value: "5", label: "Final review" },
            { value: "manual", label: "Manual / validation" },
          ]}
        />
      </div>

      <div className="command-browser">
        <div className="command-list" role="list" aria-label="Recorded commands">
          {commands.map((test) => (
            <button
              key={test.id}
              aria-current={command?.id === test.id ? "true" : undefined}
              onClick={() => setSelected(test.id)}
              className={`command-row ${commandVerification(test).outcome === "failed" ? "command-failed" : ""}`}
            >
              {test.status === "completed" ? (
                <span className="subtle">Completed · exit unreported</span>
              ) : (
                <Status
                  status={test.status === "running" ? "running" : commandVerification(test).outcome}
                />
              )}
              <code title={test.command}>{displayCommand(test.command)}</code>
              <small>
                {label(test.run_id)} · {new Date(test.started_at).toLocaleTimeString()} ·{" "}
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
          <div className="command-transcript" ref={transcript} tabIndex={-1}>
            <div className="command-log-heading">
              <strong>{label(command.run_id)}</strong>
              <span>
                {command.status === "running" ? "running" : evidence?.outcome} · exit{" "}
                {command.exit_code ?? (command.ended_at ? "unreported" : "pending")}
              </span>
              <span>{duration(command.started_at, command.ended_at)}</span>
              <Select
                label="Command output stream"
                value={stream}
                onChange={setStream}
                options={[
                  {
                    value: "all",
                    label: command.call_id ? "Provider output + stderr" : "stdout + stderr",
                  },
                  { value: "stdout", label: command.call_id ? "Provider output" : "stdout" },
                  { value: "stderr", label: "stderr" },
                ]}
              />
            </div>

            {evidence?.outcome !== command.status && (
              <small className="subtle">
                Original command status: {command.status}. Verification classification uses command
                purpose and exit evidence.
              </small>
            )}

            {evidence && evidence.outcome !== "passed" && command.status !== "running" && (
              <p className="warning">{evidence.detail}</p>
            )}

            {command.call_id && (
              <small className="subtle">
                Provider command output may combine streams. Agent Output retains the exact emitted
                fields and separate CLI stdout/stderr.
              </small>
            )}

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
