import { activeStatuses } from "../../lib/types";
export const Status = ({ status }: { status: string }) => {
  const running = [...activeStatuses, "codex_implementing", "antigravity_verifying"].includes(
    status,
  );
  const color = running
    ? "running"
    : ["completed", "passed", "ready_for_review", "published"].includes(status)
      ? "success"
      : ["failed"].includes(status)
        ? "failure"
        : [
              "interrupted",
              "cancelled",
              "awaiting_approval",
              "awaiting_manual_review",
              "merge_conflict",
              "stale_remote_head",
              "verification_blocked",
              "reviewed_with_gaps",
              "blocked",
              "not_run",
            ].includes(status)
          ? "warning"
          : "muted";
  return (
    <span className={`status status-chip ${color}`} title={status.replaceAll("_", " ")}>
      <i />
      {running
        ? "Running"
        : status === "awaiting_approval"
          ? "Review needed"
          : status === "ready_for_review"
            ? "Ready"
            : status.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase())}
    </span>
  );
};
