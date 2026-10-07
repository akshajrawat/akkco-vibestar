import { z } from "zod";
import type { PullRequestState } from "./contracts";
export const ActionSchema = z
  .object({
    manualActionRequired: z.boolean(),
    severity: z.enum(["action_required", "info", "none"]),
    summary: z.string(),
    reason: z.string(),
    newActivity: z.array(z.string()),
    recommendedNextAction: z.string(),
    affectedFiles: z.array(z.string()),
  })
  .strict();
export type PullRequestAction = z.infer<typeof ActionSchema>;
export const assessActivity = (
  previous: PullRequestState,
  current: PullRequestState,
  changes: string[],
) => {
  const action: PullRequestAction = {
    manualActionRequired: false,
    severity: "none",
    summary: "Waiting for review",
    reason: "No action required",
    newActivity: changes,
    recommendedNextAction: "",
    affectedFiles: [],
  };
  let analyze = false;
  let source: "review" | "ci" | "conflict" | null = null;
  if (!changes.length) return { action, analyze, source };
  if (current.state !== "OPEN") {
    action.summary = current.state === "MERGED" ? "PR merged" : "PR closed";
    action.severity = "info";
    return { action, analyze, source };
  }
  const changedThreads = (current.threads || []).filter(
    (t) =>
      !t.resolved &&
      !previous.threads?.some(
        (p) => p.id === t.id && !p.resolved && p.body === t.body,
      ),
  );
  const unresolved = (current.threads || []).filter((t) => !t.resolved);
  const reviews = current.reviews.filter(
    (r) =>
      r.state === "CHANGES_REQUESTED" &&
      !previous.reviews.some(
        (p) => p.id === r.id && p.body === r.body && p.state === r.state,
      ),
  );
  const failures = current.checks.filter((c) =>
    [
      "FAILURE",
      "ERROR",
      "TIMED_OUT",
      "ACTION_REQUIRED",
      "STARTUP_FAILURE",
    ].includes(c.state),
  );
  if (
    reviews.length ||
    unresolved.length ||
    current.reviewDecision === "CHANGES_REQUESTED"
  ) {
    action.manualActionRequired = true;
    source = "review";
    action.summary = unresolved[0]?.path
      ? `Reviewer requested changes in ${unresolved[0].path}.`
      : "Reviewer requested changes.";
    action.reason = "Review feedback needs your response";
    action.recommendedNextAction = "Open the task and review the feedback";
    action.affectedFiles = [...new Set(unresolved.map((t) => t.path))];
    analyze = !!(
      reviews.length ||
      changedThreads.length ||
      (current.reviewDecision === "CHANGES_REQUESTED" &&
        previous.reviewDecision !== current.reviewDecision)
    );
  } else if (failures.length) {
    source = "ci";
    action.manualActionRequired = true;
    action.summary = `CI is failing: ${failures.map((c) => c.name).join(", ")}.`;
    action.reason = "A CI check failed";
    action.recommendedNextAction = "Inspect the failing check";
  } else if (current.mergeable === "CONFLICTING") {
    source = "conflict";
    action.manualActionRequired = true;
    action.summary = "PR has merge conflicts.";
    action.reason = "The branch conflicts with upstream";
    action.recommendedNextAction =
      "Review conflicts before updating the branch";
  } else {
    const comments = current.comments.filter(
      (c) =>
        (!c.author || c.author !== current.author) &&
        !c.author?.endsWith("[bot]") &&
        !previous.comments.some(
          (p) =>
            p.id === c.id && p.body === c.body && p.updated_at === c.updated_at,
        ),
    );
    if (
      comments.length ||
      current.reviews.some(
        (r) =>
          r.body &&
          !["APPROVED", "DISMISSED"].includes(r.state) &&
          !previous.reviews.some((p) => p.id === r.id && p.body === r.body),
      )
    ) {
      analyze = true;
      source = "review";
      action.manualActionRequired = true;
      action.summary = "New review conversation needs assessment.";
      action.reason = "A reviewer or maintainer added feedback";
      action.recommendedNextAction = "Read the new conversation";
    } else if (
      current.reviewDecision === "APPROVED" ||
      current.reviews.some(
        (r) =>
          r.state === "APPROVED" &&
          !previous.reviews.some((p) => p.id === r.id && p.state === r.state),
      )
    ) {
      action.summary = "No action required — reviewer approved.";
      action.severity = "info";
    } else if (current.headRefOid !== previous.headRefOid) {
      action.summary = "PR branch updated.";
      action.severity = "info";
    } else if (changes.some((c) => c.startsWith("CI "))) {
      action.summary = "CI status updated; no action required.";
      action.severity = "info";
    }
  }
  if (action.manualActionRequired) action.severity = "action_required";
  return { action, analyze, source };
};
