import type { ScheduleJob } from "../../../backend/scheduled/contracts";
import type { PRWatchItem } from "../../../backend/review/pr/watch-contracts";

export const prWatchStatus = (item: PRWatchItem) => {
  switch (item.status) {
    case "review":
      return { label: "Needs review", tone: "warning" };
    case "waiting":
      return { label: "Waiting for reviewer", tone: "muted" };
    case "clear":
      return { label: "No action needed", tone: "muted" };
    case "checking":
      return { label: "Checking conversation…", tone: "running" };
    case "closed":
      return { label: item.lifecycle === "MERGED" ? "Merged" : "Closed", tone: "muted" };
    default:
      return { label: "Needs a closer look", tone: "warning" };
  }
};

/** Current PR lifecycle wins over historical analysis and conversation state. */
export const prReviewStatus = (job?: ScheduleJob, lifecycle?: string, reportState?: string) => {
  const state = (
    lifecycle ||
    job?.pending_snapshot?.state ||
    job?.last_snapshot?.state ||
    ""
  ).toUpperCase();

  if (state === "MERGED") return { label: "Merged", tone: "merged" };
  if (state === "CLOSED") return { label: "Closed", tone: "muted" };
  if (state === "ARCHIVED" || (!state && job?.archived))
    return { label: "Archived", tone: "muted" };
  if (job?.status === "analyzing") return { label: "Checking discussion…", tone: "running" };
  if (job?.status === "polling") return { label: "Reading GitHub…", tone: "running" };
  if (job?.status === "pending") return { label: "Queued", tone: "running" };
  if (job?.status === "interrupted") return { label: "Check interrupted", tone: "warning" };
  if (job?.error) return { label: "Check failed", tone: "failure" };
  if (reportState === "Analysis stale") return { label: "Needs recheck", tone: "warning" };
  if (reportState === "Analysis incomplete") return { label: "Review incomplete", tone: "warning" };
  if (
    ["Needs my response", "Needs code changes", "Requires manual judgment"].includes(
      reportState || "",
    )
  )
    return {
      label: reportState === "Requires manual judgment" ? "Manual review needed" : reportState!,
      tone: "warning",
    };
  if (job?.action?.conversationState === "blocked")
    return { label: job.attention_source === "ci" ? "CI failed" : "Blocked", tone: "failure" };
  if (job?.action?.manualActionRequired) return { label: "Work needed", tone: "warning" };
  if (reportState && !["Not analyzed", "Merged", "Closed"].includes(reportState))
    return { label: reportState, tone: reportState === "Approved" ? "success" : "muted" };
  const conversation = job?.action?.conversationState;
  if (conversation === "waiting_for_reviewer")
    return { label: "Waiting for review", tone: "muted" };
  if (conversation === "waiting_for_ci") return { label: "CI running", tone: "running" };
  if (conversation === "approved") return { label: "Approved", tone: "success" };
  if (job?.last_analyzed_at && job.action) return { label: "No action identified", tone: "muted" };
  return { label: "Not checked", tone: "muted" };
};
