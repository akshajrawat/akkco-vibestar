import type { FlowWorkspace } from "../../../backend/flows/workspace";
import type { Detail, Snapshot, Task } from "../../lib/types";
import { activeStatuses } from "../../lib/types";

type FlowSummary = NonNullable<Snapshot["flow_states"]>[string];

export interface TaskActivity {
  runId?: string;
  kind?: "flow" | "conversation";
  status: string;
  stage: string;
  executing: boolean;
  intervals: { start: string; end: string | null }[];
}

const labels: Record<string, string> = {
  not_started: "Not started",
  draft: "Not started",
  queued: "Queued",
  running: "Running",
  pausing: "Pausing",
  paused: "Paused",
  waiting: "Waiting for approval",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  continued: "Continued",
  needs_recovery: "Needs recovery",
  preparing: "Preparing workspace",
  planning_antigravity: "Planning · Antigravity",
  planning_codex: "Planning · Codex",
  implementing: "Implementing",
  validating: "Validating",
  reviewing_antigravity: "Reviewing · Antigravity",
  awaiting_approval: "Review needed",
  ready_for_review: "Ready for review",
  verification_blocked: "Verification blocked",
  reviewed_with_gaps: "Reviewed with gaps",
  preserved: "Preserved",
};

const label = (status: string) => labels[status] || status.replaceAll("_", " ");

/** A conversation result, a graph result and task completion are separate saved facts. */
export const taskNavigationState = (task: Task, summary?: FlowSummary, activity?: TaskActivity) => {
  const status = summary && summary.status !== "draft" ? summary.status : task.status;

  const evidence =
    activity?.status === status && (!summary || activity.runId === summary.run_id)
      ? activity
      : undefined;

  const working = summary
    ? ["queued", "running", "pausing"].includes(summary.status)
    : status === "queued" || activeStatuses.includes(status);

  const active = working && status !== "queued" && evidence?.executing === true;

  const scope = summary?.run_id
    ? evidence?.kind === "conversation"
      ? "Viber"
      : evidence?.kind === "flow"
        ? "Flow"
        : "Execution"
    : "";

  const changesRequested = !summary && task.final_review_verdict === "changes_requested";
  const text = changesRequested ? "Changes requested" : label(status);

  return {
    working,
    active,
    status,
    label: scope ? `${scope} ${text[0].toLowerCase()}${text.slice(1)}` : text,
    taskLabel: summary?.run_id ? `Task: ${label(task.status)}` : undefined,
    stage: working ? evidence?.stage || (!summary ? label(task.status) : "") : "",
    tone:
      changesRequested || ["failed", "needs_recovery"].includes(status)
        ? "error"
        : ["completed", "ready_for_review"].includes(status)
          ? "success"
          : [
                "paused",
                "pausing",
                "waiting",
                "awaiting_approval",
                "verification_blocked",
                "reviewed_with_gaps",
                "interrupted",
              ].includes(status)
            ? "warning"
            : working
              ? "active"
              : "idle",
    activity: evidence,
  };
};

export const flowTaskActivity = (
  workspace: FlowWorkspace,
  runId: string,
): TaskActivity | undefined => {
  const run = [...workspace.runs, ...workspace.conversations].find((run) => run.id === runId);
  if (!run) return;

  const attempts = [...workspace.attempts, ...workspace.conversation_attempts].filter(
    (attempt) => attempt.run_id === run.id && attempt.configuration.node.type !== "approval",
  );

  const running = attempts.filter((attempt) => attempt.status === "running");
  return {
    runId: run.id,
    kind: run.kind,
    status: run.status,
    stage: [...new Set(running.map((attempt) => attempt.configuration.node.name))].join(", "),
    executing: ["running", "pausing"].includes(run.status) && running.length > 0,
    intervals: attempts.every((attempt) => attempt.ended_at || attempt.status === "running")
      ? attempts.map((attempt) => ({ start: attempt.started_at, end: attempt.ended_at }))
      : [],
  };
};

export const legacyTaskActivity = (detail: Detail): TaskActivity => ({
  status: detail.task.status,
  stage: label(detail.task.status),
  executing: detail.executing === true,
  intervals: detail.runs.every((run) => run.ended_at || run.status === "running")
    ? detail.runs.map((run) => ({ start: run.started_at, end: run.ended_at }))
    : [],
});

/** Union recorded execution intervals so parallel agents and idle approval time are not double counted. */
export const taskExecutionDuration = (activity: TaskActivity | undefined, now: number) => {
  if (!activity?.intervals.length) return;
  const intervals: [number, number][] = [];

  for (const interval of activity.intervals) {
    if (!interval.end && !activity.executing) return;
    const start = Date.parse(interval.start);
    const end = interval.end ? Date.parse(interval.end) : now;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end > now) return;
    intervals.push([start, end]);
  }

  intervals.sort((a, b) => a[0] - b[0]);
  let elapsed = 0;
  let end = 0;

  for (const [start, nextEnd] of intervals) {
    elapsed += Math.max(0, nextEnd - Math.max(start, end));
    end = Math.max(end, nextEnd);
  }

  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
};
