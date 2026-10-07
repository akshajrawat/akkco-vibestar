import type { CoreEvent } from "./types";
import type { UsageRecord } from "../../backend/execution/usage";
export const rpc = <T>(method: string, params: unknown = {}): Promise<T> =>
  window.vibestar.rpc<T>(method, params);
export const subscribe = async (callback: (event: CoreEvent) => void) =>
  window.vibestar.subscribe(callback);
export const errorMessage = (error: unknown) =>
  (error && typeof error === "object" && "message" in error
    ? String(error.message)
    : String(error)
  )
    .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/, "")
    .replace(/(?:AdeError:\s*)+/g, "")
    .replace(/^(?:Error:\s*)+/, "");
export const parseArgv = (text: string): string[] => {
  const v: unknown = JSON.parse(text);
  if (
    !Array.isArray(v) ||
    v.length === 0 ||
    v.some((x) => typeof x !== "string")
  )
    throw new Error("Enter a JSON array of executable and arguments.");
  return v as string[];
};
export const eventData = (data: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(data);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { text: value };
  } catch {
    return { text: data };
  }
};
export const eventText = (data: string): string => {
  const value = eventData(data);
  const text =
    value.text ||
    value.text_delta ||
    value.thinking ||
    value.command ||
    value.stderr ||
    value.stdout ||
    value.path ||
    value.aggregated_output ||
    value.result ||
    value;
  return typeof text === "string" ? text : JSON.stringify(text, null, 2);
};
export const duration = (start: string, end?: string | null) => {
  const seconds = Math.max(
    0,
    Math.floor(
      (new Date(end || Date.now()).getTime() - new Date(start).getTime()) /
        1000,
    ),
  );
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};
export const tokenUsage = (
  row: Pick<
    UsageRecord,
    | "input_tokens"
    | "cached_input_tokens"
    | "output_tokens"
    | "reasoning_tokens"
    | "total_tokens"
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
    : values
        .map(([label, count]) => `${label} ${count ?? "unavailable"}`)
        .join(" · ");
};
