import type { ComputerStatus } from "../../../core/computers/contracts";
import { ComputerDesktop } from "./ComputerDesktop";

const labels: Record<ComputerStatus["status"], string> = {
  starting: "Starting",
  ready: "Ready",
  stopped: "Stopped",
  error: "Unavailable",
};

const statusColors: Record<ComputerStatus["status"], string> = {
  ready: "bg-accent-green",
  starting: "bg-accent-amber",
  stopped: "bg-ink-muted",
  error: "bg-accent-red",
};

export const ComputerPanel = ({
  supported,
  status,
}: {
  supported: boolean;
  status?: ComputerStatus;
}) => {
  const state = supported ? (status?.status ?? "starting") : "error";
  const label = labels[state];

  return (
    <aside
      id="computer-panel"
      className="h-full min-h-0 overflow-auto bg-background p-3"
      aria-label="Computer"
    >
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h2 className="m-0 text-sm font-semibold">Shared Computer</h2>
        <div
          className="flex items-center gap-1.5 rounded-full bg-surface-hover px-2 py-1 text-xs text-ink-secondary"
          role="status"
          aria-label={`Computer: ${label}`}
        >
          <span aria-hidden="true" className={`size-1.5 rounded-full ${statusColors[state]}`} />
          {label}
        </div>
      </div>
      {state === "ready" ? (
        <ComputerDesktop />
      ) : (
        <div className="aspect-[25/16] rounded-xl border border-border-default bg-surface-hover" />
      )}
    </aside>
  );
};
