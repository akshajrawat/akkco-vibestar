import { useEffect, useState } from "react";
import type { Detail } from "../lib/types";
import { duration } from "../lib/api";
import { agentEntries, toolState } from "../lib/agent-output/activity";
import { Button } from "./ui/button";

export const CurrentRun = ({
  detail,
  output,
  stop,
}: {
  detail: Pick<Detail, "runs" | "events" | "usage"> & {
    task?: Pick<Detail["task"], "status" | "updated_at">;
    status?: string;
    updated_at?: string;
    artifacts?: Detail["artifacts"];
  };
  output: () => void;
  stop: () => void;
}) => {
  const runningRun = [...detail.runs]
    .reverse()
    .find((r) => r.status === "running");
  const status = detail.task?.status || detail.status || "";
  const active =
    !!runningRun ||
    [
      "queued",
      "preparing",
      "planning_antigravity",
      "planning_codex",
      "implementing",
      "validating",
      "reviewing_antigravity",
      "codex_implementing",
      "antigravity_verifying",
    ].includes(status);
  const run = runningRun || (!active ? detail.runs.at(-1) : undefined);
  const model = run?.model || "CLI default · model not reported";
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);
  if (!active && !run) return null;
  const labels: Record<string, string> = {
    queued: "Queued",
    preparing: "Preparing repository",
    planning_antigravity: "Planning",
    planning_codex: "Reviewing plan",
    implementing: "Implementing",
    validating: "Validation",
    reviewing_antigravity: "Reviewing changes & tests",
    codex_implementing: "Implementing review fixes",
    antigravity_verifying: "Independent review & tests",
  };
  const stage =
    run?.purpose === "Code Review Ask AI"
      ? "Code review · read-only"
      : run?.purpose?.startsWith("PR Repair")
        ? run.purpose
        : run
          ? [
              "",
              "Planning",
              "Reviewing plan",
              "Implementing",
              "Validation",
              "Reviewing changes & tests",
            ][run.stage]
          : labels[status];
  const entries = agentEntries(
    detail.events.filter((e) => e.run_id === run?.id && e.stream !== "stderr"),
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
  const activity =
    entry &&
    event?.kind !== "message" &&
    toolState(entry.event, data, run) !== "running"
      ? `${toolState(entry.event, data, run)} · ${observedActivity}`
      : observedActivity;
  return (
    <section
      className="current-run compact-activity"
      aria-label="Current agent run"
    >
      <button
        className="current-run-open"
        onClick={output}
        aria-label="Inspect current run"
      >
        <div>
          <strong>
            {run?.provider === "antigravity"
              ? "Antigravity"
              : run?.provider === "codex"
                ? "Codex"
                : run?.provider || stage}
          </strong>
          {run && (
            <span>
              {" "}
              · {stage} · {model} · {run.effort} ·{" "}
              {active ? "running" : run.status}
            </span>
          )}
          <time aria-label="Run runtime">
            {" "}
            ·{" "}
            {run && !active && !run.ended_at
              ? "duration unreported"
              : duration(
                  run?.started_at ||
                    detail.task?.updated_at ||
                    detail.updated_at ||
                    new Date().toISOString(),
                  active ? undefined : run?.ended_at,
                )}
          </time>
        </div>
        {active && run && (
          <small title={activity}>
            {activity.trim().startsWith("{")
              ? "Structured output streaming"
              : activity}
          </small>
        )}
      </button>
      {active && (
        <Button size="sm" variant="ghost" onClick={stop}>
          Stop
        </Button>
      )}
    </section>
  );
};
