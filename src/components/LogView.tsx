import { useEffect, useRef, useState } from "react";
import type { Run, AgentEvent } from "../lib/types";
import { duration, errorMessage, eventData } from "../lib/api";
import { useTaskView, updateTaskView } from "../lib/taskView";
import { useAgentOutput } from "../lib/agent-output/useOutput";
import { Status } from "./Status";
import { AgentTimeline } from "./AgentTimeline";
import { Button } from "./ui/button";

const OutputBody = ({
  taskId,
  run,
  events,
  preparation,
}: {
  taskId: string;
  run?: Run;
  events: AgentEvent[];
  preparation: boolean;
}) => {
  const view = useTaskView(taskId);
  const raw = view.outputView === "raw";
  const output = useAgentOutput({
    taskId,
    run,
    events,
    raw,
    stream: view.outputStream,
    search: view.outputSearch,
    preparation,
  });
  const scroll = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const restore = useRef<{ height: number; top: number } | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const text =
    view.outputView === "prompt"
      ? run?.prompt || "No saved prompt"
      : view.outputStream === "events"
        ? output.events
            .map((e) =>
              JSON.stringify({
                timestamp: e.timestamp,
                kind: e.kind,
                stream: e.stream,
                data: eventData(e.data),
                raw: e.raw,
              }),
            )
            .join("\n")
        : output.log.text;
  const displayedText =
    view.outputView === "prompt" && view.outputSearch
      ? text
          .split("\n")
          .filter((line) =>
            line.toLowerCase().includes(view.outputSearch.toLowerCase()),
          )
          .join("\n")
      : text;
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    if (restore.current && !output.loading) {
      element.scrollTop =
        restore.current.top + element.scrollHeight - restore.current.height;
      restore.current = null;
    } else if (!restore.current && view.outputFollow)
      element.scrollTo({ top: element.scrollHeight });
  }, [
    text,
    output.events.length,
    output.loading,
    view.outputFollow,
    run?.output,
  ]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        raw || preparation || view.outputView === "prompt"
          ? displayedText
          : scroll.current?.innerText || scroll.current?.textContent || "",
      );
      setCopyStatus("Copied");
    } catch (e) {
      setCopyStatus(errorMessage(e));
    }
  };
  return (
    <>
      <div
        className="output-controls"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            updateTaskView(taskId, { outputSearch: "" });
            searchInput.current?.blur();
            e.stopPropagation();
          }
        }}
      >
        <input
          ref={searchInput}
          type="search"
          aria-label="Search saved output"
          placeholder="Search saved output…"
          maxLength={256}
          value={view.outputSearch}
          onChange={(e) =>
            updateTaskView(taskId, { outputSearch: e.target.value })
          }
        />
        {!raw && view.outputView !== "prompt" && (
          <select
            aria-label="Output filter"
            value={view.outputFilter}
            onChange={(e) =>
              updateTaskView(taskId, { outputFilter: e.target.value })
            }
          >
            {["all", "messages", "commands", "files", "tests", "errors"].map(
              (filter) => (
                <option key={filter} value={filter}>
                  {filter === "all" ? "All activity" : filter}
                </option>
              ),
            )}
          </select>
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={view.outputFollow}
          onClick={() =>
            updateTaskView(taskId, { outputFollow: !view.outputFollow })
          }
        >
          {view.outputFollow ? "Pause scrolling" : "Follow output"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void copy()}>
          Copy output
        </Button>
        <span className="output-copy-status" role="status">
          {copyStatus}
        </span>
      </div>
      {output.error && (
        <p className="error-box" role="alert">
          {output.error}
        </p>
      )}
      <div
        className="output-scroll"
        ref={scroll}
        tabIndex={0}
        aria-label="Agent output transcript"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (
            view.outputFollow &&
            el.scrollHeight - el.scrollTop - el.clientHeight > 80
          )
            updateTaskView(taskId, { outputFollow: false });
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
            e.preventDefault();
            searchInput.current?.focus();
          }
          if (e.key === "End" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            updateTaskView(taskId, { outputFollow: true });
          }
        }}
      >
        {output.more && view.outputView !== "prompt" && (
          <Button
            size="sm"
            variant="ghost"
            disabled={output.loading}
            onClick={() => {
              updateTaskView(taskId, { outputFollow: false });
              if (scroll.current && !view.outputSearch)
                restore.current = {
                  height: scroll.current.scrollHeight,
                  top: scroll.current.scrollTop,
                };
              void output.loadMore();
            }}
          >
            {view.outputSearch ? "More search matches" : "Load earlier output"}
          </Button>
        )}
        {view.outputSearch && (
          <p className="output-note">
            Searching saved{" "}
            {view.outputView === "prompt"
              ? "prompt"
              : raw && view.outputStream !== "events"
                ? `${view.outputStream} lines`
                : "events"}
            . Matches are paged; clear search to restore the transcript.
          </p>
        )}
        {raw || preparation || view.outputView === "prompt" ? (
          <pre className="raw-log">
            {displayedText ||
              (view.outputSearch ? "No matches" : "No output saved yet")}
          </pre>
        ) : run ? (
          <div className="readable-log">
            <AgentTimeline
              runs={[run]}
              events={output.events}
              search={view.outputSearch}
              filter={view.outputFilter}
            />
          </div>
        ) : (
          <p className="empty-row">No provider run has started.</p>
        )}
        {raw && !view.outputSearch && output.log.end < output.log.size && (
          <Button size="sm" onClick={() => void output.refresh()}>
            Load newer output
          </Button>
        )}
      </div>
    </>
  );
};

export const LogView = ({
  taskId,
  runs,
  events,
  selectedRun,
}: {
  taskId: string;
  runs: Run[];
  events: AgentEvent[];
  selectedRun?: string;
  liveOutput?: boolean;
}) => {
  const view = useTaskView(taskId);
  const selection = view.outputRun || selectedRun || "";
  const preparation = selection === "preparation";
  const run =
    runs.find((r) => r.id === selection) ||
    [...runs].reverse().find((r) => r.status === "running") ||
    runs.at(-1);
  return (
    <section
      className="logs-panel"
      aria-label="Agent output"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
          e.preventDefault();
          e.currentTarget
            .querySelector<HTMLInputElement>("input[type=search]")
            ?.focus();
        }
      }}
    >
      <div className="logs-toolbar">
        <select
          aria-label="Select run"
          value={
            preparation
              ? "preparation"
              : selection && run?.id === selection
                ? selection
                : ""
          }
          onChange={(e) =>
            updateTaskView(taskId, { outputRun: e.target.value })
          }
        >
          <option value="">Current / latest run</option>
          <option value="preparation">Repository preparation</option>
          {runs.map((r) => (
            <option key={r.id} value={r.id}>
              {r.provider} · {r.purpose || `stage ${r.stage}`} · {r.status} ·{" "}
              {new Date(r.started_at).toLocaleString()}
            </option>
          ))}
        </select>
        {(["readable", "raw", "prompt"] as const).map((mode) => (
          <button
            key={mode}
            aria-pressed={view.outputView === mode}
            className={view.outputView === mode ? "selected" : ""}
            onClick={() => updateTaskView(taskId, { outputView: mode })}
          >
            {mode === "prompt"
              ? "Saved prompt"
              : mode === "raw"
                ? "Raw"
                : "Readable"}
          </button>
        ))}
        {view.outputView === "raw" && (
          <select
            aria-label="Raw output stream"
            value={view.outputStream}
            onChange={(e) =>
              updateTaskView(taskId, {
                outputStream: e.target.value as typeof view.outputStream,
              })
            }
          >
            <option value="stdout">Raw stdout</option>
            <option value="stderr">Raw stderr</option>
            <option value="events">Structured events</option>
          </select>
        )}
      </div>
      {!preparation && run && (
        <div className="run-metadata">
          <Status status={run.status} />
          <span>{run.provider}</span>
          <code>{run.model || "CLI default · model not reported"}</code>
          <span>{run.effort}</span>
          <span>{duration(run.started_at, run.ended_at)}</span>
          <span>exit {run.exit_code ?? "not reported"}</span>
          <details>
            <summary>Run details</summary>
            <code>{run.id}</code>
            <p>
              PID {run.pid ?? "not started"} · session{" "}
              {run.conversation_id || "not reported"}
            </p>
          </details>
        </div>
      )}
      <OutputBody
        key={`${taskId}/${preparation ? "preparation" : run?.id}/${view.outputView}/${view.outputStream}`}
        taskId={taskId}
        run={run}
        preparation={preparation}
        events={events}
      />
    </section>
  );
};
