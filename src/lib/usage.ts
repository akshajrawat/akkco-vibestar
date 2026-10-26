import type { ProviderDetection } from "../../backend/execution/providers/contracts";
import type { UsageRecord } from "../../backend/execution/output/usage";

export const readLimits = (
  json: string | null | undefined,
): ProviderDetection["subscriptionLimits"] => {
  try {
    const value = JSON.parse(json || "null");
    if (!value || typeof value.reportedAt !== "string" || !Array.isArray(value.windows))
      return undefined;

    const windows = value.windows.filter(
      (w: Record<string, unknown>) =>
        w &&
        typeof w.usedPercent === "number" &&
        w.usedPercent >= 0 &&
        w.usedPercent <= 100 &&
        typeof w.windowDurationMins === "number" &&
        w.windowDurationMins > 0 &&
        typeof w.resetsAt === "number" &&
        Number.isFinite(w.resetsAt),
    );

    return windows.length
      ? {
          reportedAt: value.reportedAt,
          planType: typeof value.planType === "string" ? value.planType : undefined,
          windows,
        }
      : undefined;
  } catch {
    return undefined;
  }
};

export const limitDeltas = (row: UsageRecord) => {
  const before = readLimits(row.subscription_limits);
  const after = readLimits(row.subscription_limits_after);
  if (!before || !after || before.planType !== after.planType) return [];
  return before.windows.flatMap((a) => {
    const b = after.windows.find(
      (w) => w.windowDurationMins === a.windowDurationMins && w.resetsAt === a.resetsAt,
    );

    return b
      ? [
          {
            minutes: a.windowDurationMins,
            before: a.usedPercent,
            after: b.usedPercent,
            delta: Math.round((b.usedPercent - a.usedPercent) * 10) / 10,
          },
        ]
      : [];
  });
};

export const windowLabel = (minutes: number) =>
  minutes === 300
    ? "5 hour"
    : minutes === 10080
      ? "Weekly"
      : minutes >= 60
        ? `${minutes / 60} hour`
        : `${minutes} minute`;

export const usageRuntime = (row: UsageRecord) =>
  row.duration_ms ??
  (row.status === "running" ? Math.max(0, Date.now() - Date.parse(row.started_at)) : 0);
