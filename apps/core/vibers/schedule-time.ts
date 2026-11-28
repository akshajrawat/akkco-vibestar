import type { Cadence } from "./schedule-contracts";

export const scheduleTimezone = (timezone?: string) =>
  new Intl.DateTimeFormat("en", { timeZone: timezone }).resolvedOptions().timeZone;

export const nextScheduleRun = (cadence: Cadence, time: number, timezone: string): number => {
  if (cadence.kind === "once") {
    return Math.max(cadence.at, time);
  }

  if (cadence.kind === "interval") {
    return time + cadence.minutes * 60000;
  }

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  const localTime = (instant: number) => {
    const fields = Object.fromEntries(
      formatter.formatToParts(instant).map(({ type, value }) => [type, Number(value)]),
    );

    return Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute);
  };

  const dayMs = 24 * 60 * 60000;
  const local = new Date(localTime(time));
  local.setUTCHours(cadence.hour, cadence.minute, 0, 0);
  for (let day = 0; day <= 14; day++) {
    const desired = local.getTime() + day * dayMs;
    const weekday = new Date(desired).getUTCDay();
    if (
      (cadence.day !== undefined && weekday !== cadence.day) ||
      (cadence.weekdays && (weekday === 0 || weekday === 6))
    ) {
      continue;
    }

    const candidates = [desired - dayMs, desired, desired + dayMs]
      .map((sample) => desired - (localTime(sample) - sample))
      .filter((instant) => localTime(instant) === desired);

    const first = Math.min(...candidates);
    // Skip nonexistent local times and run only once during a repeated local hour.
    if (Number.isFinite(first) && first > time) {
      return first;
    }
  }

  throw new Error("Could not compute the next schedule time.");
};
