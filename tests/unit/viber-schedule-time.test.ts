import { expect, it } from "vitest";

import { nextScheduleRun } from "../../apps/core/vibers/schedule-time";

it("keeps the saved timezone across daylight saving and skips nonexistent local times", () => {
  const cadence = { kind: "clock", hour: 2, minute: 30 } as const;

  expect(nextScheduleRun(cadence, Date.parse("2026-03-07T10:00:00Z"), "America/New_York")).toBe(
    Date.parse("2026-03-09T06:30:00Z"),
  );
});

it("runs only once on a day with a repeated local hour", () => {
  const cadence = { kind: "clock", hour: 1, minute: 30 } as const;
  const before = Date.parse("2026-11-01T05:00:00Z");
  const first = Date.parse("2026-11-01T05:30:00Z");
  expect(nextScheduleRun(cadence, before, "America/New_York")).toBe(first);

  expect(nextScheduleRun(cadence, first, "America/New_York")).toBe(
    Date.parse("2026-11-02T06:30:00Z"),
  );
});
