import { activeStatuses } from "../lib/types";
export const Status = ({ status }: { status: string }) => {
  const color = activeStatuses.includes(status)
    ? "running"
    : ["completed", "passed", "ready_for_review"].includes(status)
      ? "success"
      : ["failed"].includes(status)
        ? "failure"
        : ["interrupted"].includes(status)
          ? "warning"
          : "muted";
  return (
    <span className={`status ${color}`}>
      <i />
      {status.replaceAll("_", " ")}
    </span>
  );
};
