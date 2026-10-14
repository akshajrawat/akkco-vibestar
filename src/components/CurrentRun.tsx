import { useEffect, useState } from "react";
import type { Detail } from "../lib/types";
import { duration } from "../lib/api";
import { agentEntries, toolState } from "../lib/agent-output/activity";
import { readLimits } from "../lib/usage";
import { Button } from "./ui/button";

export const CurrentRun = ({
  detail,
  output,
  stop,
  prompt,
  plan,
  usage: openUsage,
}: {
  detail: Detail;
  output: () => void;
  stop: () => void;
  prompt?: () => void;
  plan?: () => void;
  usage?: () => void;
}) => {
  const run = [...detail.runs].reverse().find((r) => r.status === "running");
  const active =
    !!run ||
    [
      "queued",
      "preparing",
      "planning_antigravity",
      "planning_codex",
      "implementing",
      "validating",
      "reviewing_antigravity",
    ].includes(detail.task.status);
  const model = run?.model || "CLI default · model not reported";
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);
  if (!active) return null;
  const labels: Record<string, string> = {
    queued: "Queued",
    preparing: "Preparing repository",
    planning_antigravity: "Planning",
    planning_codex: "Reviewing plan",
    implementing: "Implementing",
    validating: "Validation",
    reviewing_antigravity: "Reviewing changes & tests",
  };
  const stage =
    run?.purpose === "Code Review Ask AI"
      ? "Code review · read-only"
      : run
        ? [
            "",
            "Planning",
            "Reviewing plan",
            "Implementing",
            "Validation",
            "Reviewing changes & tests",
          ][run.stage]
        : labels[detail.task.status];
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
  const usage = detail.usage?.find((u) => u.id === run?.id);
  const window = readLimits(usage?.subscription_limits)?.windows.find(
    (w) => w.windowDurationMins === 300,
  );
  const reportedTokens =
    usage?.total_tokens != null
      ? `Tokens: ${usage.total_tokens.toLocaleString()} reported`
      : [
          usage?.input_tokens != null
            ? `Input: ${usage.input_tokens.toLocaleString()}`
            : "",
          usage?.output_tokens != null
            ? `Output: ${usage.output_tokens.toLocaleString()}`
            : "",
        ]
          .filter(Boolean)
          .join(" · ");
  return (
    <section
      className="current-run"
      aria-label="Current agent run"
      aria-live="polite"
    >
      <span className={`agent-avatar ${run?.provider || ""}`}>
        {run ? (run.provider === "antigravity" ? "A" : "C") : "●"}
      </span>
      <div className="current-run-text">
        <div>
          <strong>
            {run
              ? run.provider === "antigravity"
                ? "Antigravity"
                : run.provider === "codex"
                  ? "Codex"
                  : run.provider
              : stage}
          </strong>
          {run && (
            <span>
              {" "}
              · {stage} · {model} · {run.effort}
            </span>
          )}
          <time aria-label="Run runtime">
            {" "}
            · {duration(run?.started_at || detail.task.updated_at)}
          </time>
        </div>
        {run && (
          <small title={activity}>
            {activity.trim().startsWith("{")
              ? "Structured output streaming · View plan or Agent Output"
              : activity}
          </small>
        )}
        {(reportedTokens || window) && (
          <small>
            {reportedTokens}
            {window
              ? `${reportedTokens ? " · " : ""}5h window: ${window.usedPercent}% used at start`
              : ""}
          </small>
        )}
      </div>
      {plan &&
        run &&
        [1, 2].includes(run.stage) &&
        detail.artifacts.some((a) => a.kind === `draft:${run.id}`) && (
          <Button size="sm" onClick={plan}>
            View streamed plan
          </Button>
        )}
      {prompt && (
        <Button size="sm" variant="ghost" disabled={!run} onClick={prompt}>
          View prompt
        </Button>
      )}
      <Button size="sm" variant="ghost" disabled={!run} onClick={output}>
        Agent Output
      </Button>
      {openUsage && (
        <Button size="sm" variant="ghost" disabled={!run} onClick={openUsage}>
          Run usage
        </Button>
      )}
      <Button size="sm" onClick={stop}>
        Stop
      </Button>
    </section>
  );
};
