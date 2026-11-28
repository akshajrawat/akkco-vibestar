import { useState } from "react";
import { Button } from "../../components/ui/button";
import type { ComputerStatus } from "../../../core/computers/contracts";
import { ComputerDesktop } from "./ComputerDesktop";
import { ViberSchedules } from "./ViberSchedules";

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
  reset,
  profileId,
  revision = 0,
}: {
  supported: boolean;
  status?: ComputerStatus;
  reset?: () => Promise<void>;
  profileId?: string;
  revision?: number;
}) => {
  const [confirming, setConfirming] = useState(false);
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
      ) : state === "error" && status?.reset_pending && reset ? (
        <div className="rounded-xl border border-border-default p-4 text-sm">
          <p role="alert" className="mb-3">
            {status.error}
          </p>
          {confirming ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="basis-full">
                Delete the remaining Shared Computer files and Linux home?
              </p>
              <Button onClick={() => setConfirming(false)}>Cancel</Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setConfirming(false);
                  void reset();
                }}
              >
                Confirm Reset
              </Button>
            </div>
          ) : (
            <Button onClick={() => setConfirming(true)}>Retry Reset</Button>
          )}
        </div>
      ) : status?.progress || status?.error ? (
        <p
          role={state === "error" ? "alert" : "status"}
          className="rounded-xl border border-border-default p-4 text-sm text-ink-secondary"
        >
          {status.error || status.progress}
        </p>
      ) : (
        <div className="aspect-[25/16] rounded-xl border border-border-default bg-surface-hover" />
      )}
      {profileId && <ViberSchedules key={profileId} profileId={profileId} revision={revision} />}
    </aside>
  );
};
