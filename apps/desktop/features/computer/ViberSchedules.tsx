import { useEffect, useState } from "react";
import {
  scheduleCadenceLabel,
  scheduleStatusLabel,
  type ViberSchedule,
} from "../../../core/vibers/schedule-contracts";
import { errorMessage, rpc } from "../../lib/api";

export const ViberSchedules = ({
  profileId,
  revision,
}: {
  profileId: string;
  revision: number;
}) => {
  const [schedules, setSchedules] = useState<ViberSchedule[]>();
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;

    void rpc<ViberSchedule[]>("viber.schedule.list", { profile_id: profileId })
      .then((rows) => {
        if (alive) {
          setSchedules(rows);
          setError("");
        }
      })
      .catch((reason: unknown) => {
        if (alive) {
          setError(errorMessage(reason));
        }
      });

    return () => {
      alive = false;
    };
  }, [profileId, revision]);

  return (
    <section aria-labelledby="viber-schedules" className="mt-4 border-t border-border-default pt-3">
      <h2 id="viber-schedules" className="m-0 text-sm font-semibold">
        Schedules
      </h2>
      {error ? (
        <p role="alert" className="mt-2 text-xs">
          Couldn't load schedules. {error}
        </p>
      ) : schedules === undefined ? (
        <p role="status" className="mt-2 text-xs text-ink-secondary">
          Loading schedules…
        </p>
      ) : !schedules.length ? (
        <p className="mt-2 text-xs text-ink-secondary">
          Ask this Viber in chat to set a reminder or watch your PRs.
        </p>
      ) : (
        <ul className="m-0 mt-2 grid list-none gap-2 p-0">
          {schedules.map((schedule) => (
            <li key={schedule.id} className="rounded-lg border border-border-default px-3 py-2.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
                <span className="min-w-0 break-words text-sm font-medium">{schedule.name}</span>
                <span
                  className={
                    schedule.status === "blocked_sign_in"
                      ? "text-xs text-accent-amber"
                      : "text-xs text-ink-secondary"
                  }
                >
                  {scheduleStatusLabel[schedule.status]}
                </span>
              </div>
              <p className="mb-0 mt-1 text-xs text-ink-secondary">
                {scheduleCadenceLabel(schedule)}
              </p>
              {schedule.error && (
                <p className="mb-0 mt-1 text-xs text-ink-secondary">
                  {schedule.error.replaceAll("**", "")}
                </p>
              )}
              <p className="mb-0 mt-1 text-xs text-ink-secondary">
                {schedule.next_run_at === null ? (
                  "No upcoming run"
                ) : (
                  <>
                    {schedule.status === "blocked_sign_in" ? "Next sign-in check " : "Next run "}
                    <time dateTime={new Date(schedule.next_run_at).toISOString()}>
                      {new Date(schedule.next_run_at).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                        timeZone: schedule.timezone,
                        timeZoneName: "short",
                      })}
                    </time>
                  </>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
