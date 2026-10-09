import { useEffect, useState } from "react";
import type { Run, AgentEvent } from "../lib/types";
import { duration, rpc, errorMessage } from "../lib/api";
import { Status } from "./Status";
import { RunError } from "./RunError";
import { AgentTimeline } from "./AgentTimeline";
import { AgentResponse } from "./AgentResponse";
export const LogView = ({
  taskId,
  runs,
  events,
  selectedRun,
  liveOutput = false,
}: {
  taskId: string;
  runs: Run[];
  events: AgentEvent[];
  selectedRun?: string;
  liveOutput?: boolean;
}) => {
  const [selection, setSelection] = useState("");
  const [view, setView] = useState(liveOutput ? "activity" : "response");
  const run =
    runs.find((r) => r.id === (selection || selectedRun)) || runs.at(-1);
  const [log, setLog] = useState<{ text: string; truncated: boolean }>({
    text: "",
    truncated: false,
  });
  const [error, setError] = useState("");
  const preparation = (selection || selectedRun) === "preparation";
  useEffect(() => {
    let alive = true;
    if (!preparation && !["raw events", "stderr"].includes(view)) return;
    const refresh = () =>
      rpc<{ text: string; truncated: boolean }>("task.logs", {
        id: taskId,
        run_id: preparation ? null : run?.id || null,
        stream: view === "stderr" ? "stderr" : "stdout",
      })
        .then((data) => {
          if (alive) {
            setLog(data);
            setError("");
          }
        })
        .catch((e) => {
          if (alive) setError(errorMessage(e));
        });
    void refresh();
    const timer =
      run?.status === "running"
        ? setInterval(() => void refresh(), 1000)
        : undefined;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [taskId, preparation, run?.id, view, events.length, run?.status]);
  return (
    <div className="logs-panel">
      <div className="logs-toolbar">
        <select
          aria-label="Select run"
          value={preparation ? "preparation" : run?.id || ""}
          onChange={(e) => setSelection(e.target.value)}
        >
          <option value="preparation">Repository preparation</option>
          {runs.map((r) => (
            <option key={r.id} value={r.id}>
              {r.provider} ·{" "}
              {r.purpose === "scheduled" ? "PR analysis" : `stage ${r.stage}`} ·{" "}
              {new Date(r.started_at).toLocaleTimeString()}
            </option>
          ))}
        </select>
        {["activity", "prompt", "response", "raw events", "stderr"].map((v) => (
          <button
            className={view === v ? "selected" : ""}
            key={v}
            onClick={() => setView(v)}
          >
            {v === "raw events" ? "Raw stdout" : v}
          </button>
        ))}
      </div>
      {error && <p className="error-box">{error}</p>}
      {log.truncated && (
        <p className="empty-row">
          Showing the last 1 MiB. Complete redacted logs remain in the task log
          directory.
        </p>
      )}
      {preparation ? (
        <pre className="raw-log">{log.text || "No preparation log yet"}</pre>
      ) : run ? (
        <>
          <div className="run-metadata">
            <Status status={run.status} />
            <code>{run.model || "CLI default"}</code>
            <span>{run.effort}</span>
            <span>{duration(run.started_at, run.ended_at)}</span>
            <span>exit {run.exit_code ?? "pending"}</span>
            <span>pid {run.pid ?? "pending"}</span>
            {run.conversation_id && (
              <span className="mono">conversation {run.conversation_id}</span>
            )}
          </div>
          {run.error && <RunError error={run.error} run={run} />}
          {view === "activity" ? (
            <div className="readable-log">
              <AgentTimeline
                runs={[run]}
                events={events.filter((event) => event.run_id === run.id)}
              />
            </div>
          ) : view === "response" ? (
            <div className="readable-log">
              <AgentResponse
                expanded
                text={run.output || "No final result saved yet"}
              />
            </div>
          ) : (
            <pre className="raw-log">
              {view === "prompt" ? run.prompt : log.text}
            </pre>
          )}
        </>
      ) : (
        <p className="empty-row">No provider run has started.</p>
      )}
    </div>
  );
};
