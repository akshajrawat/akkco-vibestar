import type { GitHubPullRequest } from "../../github/contracts";
import type { PRAnalysisSession } from "./contracts";

export const reviewActionState = (
  analysis: PRAnalysisSession | undefined,
  current?: GitHubPullRequest,
) => {
  const state = current?.state || analysis?.snapshot?.state;
  if (state === "MERGED") return "Merged";
  if (state === "CLOSED") return "Closed";
  if (!analysis?.report) return "Not analyzed";
  if (current?.access_error) return "Analysis incomplete";
  if (!analysis.report.complete || analysis.status === "partial") return "Analysis incomplete";
  if (
    current &&
    ((current.head_sha && current.head_sha !== analysis.snapshot?.headRefOid) ||
      Date.parse(current.updated_at) > Date.parse(analysis.ended_at || analysis.started_at))
  )
    return "Analysis stale";

  const outstanding = analysis.report.actions.filter(
    (action) =>
      !action.threadResolved &&
      action.responseState !== "answered" &&
      !["positive_feedback", "informational"].includes(action.classification),
  );

  if (
    outstanding.some(
      (action) => action.responseState === "needs_manual_judgment" || action.confidence === "low",
    )
  )
    return "Requires manual judgment";
  if (
    outstanding.some(
      (action) => action.classification === "question" && action.responseState !== "author_replied",
    )
  )
    return "Needs my response";
  if (
    outstanding.some(
      (action) =>
        action.classification === "required_change" && action.responseState === "no_author_reply",
    )
  )
    return "Needs code changes";
  if (
    outstanding.some(
      (action) =>
        action.classification === "suggested_change" ||
        action.responseState === "partially_answered",
    )
  )
    return "Requires manual judgment";
  if (outstanding.length) return "Waiting for reviewer";
  if (
    analysis.snapshot?.checks.some((check) =>
      ["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED"].includes(check.state),
    )
  )
    return "Requires manual judgment";
  if (
    analysis.snapshot?.checks.some((check) =>
      ["PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED"].includes(check.state),
    )
  )
    return "Waiting for CI";
  if (analysis.snapshot?.reviewDecision === "APPROVED") return "Approved";
  if (analysis.snapshot?.reviewDecision === "CHANGES_REQUESTED") return "Requires manual judgment";
  if (analysis.snapshot?.reviewDecision === "REVIEW_REQUIRED") return "Waiting for reviewer";
  return "No action identified";
};
