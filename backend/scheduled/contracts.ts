import { z } from "zod";
import { AdeError } from "../domain";
export const parsePullRequest = (value: string) => {
  const u = new URL(value);
  const match = u.pathname.match(
    /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/,
  );
  if (
    u.protocol !== "https:" ||
    u.hostname !== "github.com" ||
    u.username ||
    u.password ||
    !match ||
    !Number.isSafeInteger(Number(match[3]))
  )
    throw new AdeError(
      "invalid_input",
      "Use an HTTPS github.com/owner/repository/pull/number URL",
    );
  return {
    owner: match[1],
    repo: match[2],
    number: Number(match[3]),
    url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`,
  };
};
export const ScheduleInput = z.object({
  url: z.string().max(2000),
  task_id: z.string().uuid().nullable(),
  interval_minutes: z.number().int().min(5).max(10080),
  verify_codex: z.boolean().default(false),
});
export interface PullRequestState {
  title: string;
  body: string;
  state: string;
  mergeable: string;
  reviewDecision: string;
  headRefOid: string;
  comments: { id: string; body: string; updated_at: string }[];
  reviews: { id: string; body: string; state: string; submitted_at: string }[];
  checks: { name: string; state: string; url: string }[];
}
export interface ScheduleJob {
  id: string;
  url: string;
  task_id: string | null;
  interval_minutes: number;
  verify_codex: boolean;
  enabled: boolean;
  next_run_at: string;
  status:
    "idle" | "polling" | "pending" | "analyzing" | "interrupted" | "error";
  last_checked_at: string | null;
  last_snapshot: PullRequestState | null;
  pending_snapshot: PullRequestState | null;
  changes: string[];
  error: string | null;
}
export interface ScheduleAttention {
  id: string;
  job_id: string;
  task_id: string | null;
  created_at: string;
  summary: string;
  changes: string;
  analysis: string | null;
  refinement: string | null;
  error: string | null;
  dismissed: number;
}
export const changedPullRequest = (
  previous: PullRequestState,
  current: PullRequestState,
) => {
  const changes: string[] = [];
  for (const comment of current.comments)
    if (
      !previous.comments.some(
        (p) =>
          p.id === comment.id &&
          p.body === comment.body &&
          p.updated_at === comment.updated_at,
      )
    )
      changes.push(`New or edited comment ${comment.id}: ${comment.body}`);
  for (const review of current.reviews)
    if (
      !previous.reviews.some(
        (p) =>
          p.id === review.id &&
          p.body === review.body &&
          p.state === review.state,
      )
    )
      changes.push(`Review ${review.state}: ${review.body}`);
  if (current.reviewDecision !== previous.reviewDecision)
    changes.push(`Review decision: ${current.reviewDecision || "pending"}`);
  const failures = [
    "FAILURE",
    "ERROR",
    "TIMED_OUT",
    "CANCELLED",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
  ];
  for (const check of current.checks)
    if (
      failures.includes(check.state) &&
      !previous.checks.some(
        (p) =>
          p.name === check.name &&
          p.state === check.state &&
          p.url === check.url,
      )
    )
      changes.push(`CI ${check.name}: ${check.state} ${check.url}`);
  if (
    current.mergeable === "CONFLICTING" &&
    previous.mergeable !== current.mergeable
  )
    changes.push("Merge conflicts detected");
  if (current.state !== previous.state)
    changes.push(`PR state: ${current.state}`);
  return {
    changes,
    actionable: current.state === "OPEN" && changes.length > 0,
  };
};
