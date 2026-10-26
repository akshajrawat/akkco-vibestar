import type { UsageRecord } from "../../backend/execution/output/usage";

export const duration = (start: string, end?: string | null) => {
  const seconds = Math.max(
    0,
    Math.floor((new Date(end || Date.now()).getTime() - new Date(start).getTime()) / 1000),
  );

  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

export const tokenUsage = (
  row: Pick<
    UsageRecord,
    "input_tokens" | "cached_input_tokens" | "output_tokens" | "reasoning_tokens" | "total_tokens"
  >,
) => {
  const values = [
    ["input", row.input_tokens],
    ["cached", row.cached_input_tokens],
    ["output", row.output_tokens],
    ["reasoning", row.reasoning_tokens],
    ["total", row.total_tokens],
  ];

  return values.every(([, count]) => count === null)
    ? "Unavailable — provider did not report usage"
    : values.map(([label, count]) => `${label} ${count ?? "unavailable"}`).join(" · ");
};
