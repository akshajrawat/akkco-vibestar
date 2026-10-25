import { useEffect, useState } from "react";
import type { Detail } from "../lib/types";
import { duration } from "../lib/api";
import { runActivity } from "../lib/agent-output/activity";
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
    run?.purpose === "Read-only conversation"
      ? "Conversation · read-only"
      : run?.purpose === "Code Review Ask AI"
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
  const activity = runActivity(detail.events, run);
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
