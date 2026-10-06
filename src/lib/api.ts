import type { CoreEvent } from "./types";
export const rpc = <T>(method: string, params: unknown = {}): Promise<T> =>
  window.vibestar.rpc<T>(method, params);
export const subscribe = async (callback: (event: CoreEvent) => void) =>
  window.vibestar.subscribe(callback);
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
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
