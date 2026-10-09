import { activeStatuses } from "../lib/types";
export const Status = ({ status }: { status: string }) => {
  const color = activeStatuses.includes(status)
    ? "running"
    : ["completed", "passed", "ready_for_review"].includes(status)
      ? "success"
      : ["failed"].includes(status)
        ? "failure"
        : ["interrupted", "cancelled", "awaiting_approval"].includes(status)
          ? "warning"
          : "muted";
  return (
    <span
      className={`status status-chip ${color}`}
      title={status.replaceAll("_", " ")}
    >
      <i />
      {activeStatuses.includes(status)
        ? "Running"
        : status === "awaiting_approval"
          ? "Review needed"
          : status === "ready_for_review"
            ? "Ready"
            : status
                .replaceAll("_", " ")
                .replace(/^./, (letter) => letter.toUpperCase())}
    </span>
  );
};
