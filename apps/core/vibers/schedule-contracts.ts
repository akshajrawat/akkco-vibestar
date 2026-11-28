export const minimumScheduleMinutes = 5;

export type Cadence =
  | { kind: "once"; at: number }
  | { kind: "interval"; minutes: number }
  | { kind: "clock"; hour: number; minute: number; day?: number; weekdays?: true };

export type ScheduleTask =
  | { kind: "reminder" }
  | { kind: "instruction" }
  | {
      kind: "github";
      pull?: string;
      repository?: string;
      events?: "changes_requested" | "review_requested" | "all";
    };

export type ScheduleStatus =
  "pending" | "active" | "blocked_sign_in" | "retrying" | "paused" | "completed" | "cancelled";

export interface ViberSchedule {
  id: string;
  name: string;
  instructions: string;
  task: ScheduleTask;
  cadence: Cadence;
  timezone: string;
  error: string | null;
  next_run_at: number | null;
  status: ScheduleStatus;
}

export const scheduleStatusLabel: Record<ScheduleStatus, string> = {
  pending: "Checking GitHub access",
  active: "Active",
  blocked_sign_in: "Blocked · GitHub sign-in",
  retrying: "Retrying",
  paused: "Paused",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const scheduleCadenceLabel = (schedule: Pick<ViberSchedule, "task" | "cadence">) => {
  const { cadence, task } = schedule;
  switch (cadence.kind) {
    case "once":
      return "Once";
    case "interval":
      return task.kind === "github"
        ? `GitHub poll every ${cadence.minutes} min`
        : `Every ${cadence.minutes} min`;
    case "clock": {
      const time = new Date(2000, 0, 1, cadence.hour, cadence.minute).toLocaleTimeString(
        undefined,
        { hour: "numeric", minute: "2-digit" },
      );

      const day =
        cadence.day !== undefined
          ? `Every ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][cadence.day]}`
          : cadence.weekdays
            ? "Weekdays"
            : "Daily";

      return `${day} at ${time}`;
    }
  }
};
