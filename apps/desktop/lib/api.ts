import type { CoreEvent } from "./types";

export const rpc = <T>(method: string, params: unknown = {}): Promise<T> =>
  window.vibestar.rpc<T>(method, params);

export const computerRpc = <K extends keyof import("../../core/computers/contracts").ComputerRpc>(
  method: K,
  params: import("../../core/computers/contracts").ComputerRpc[K]["input"],
): Promise<import("../../core/computers/contracts").ComputerRpc[K]["output"]> =>
  rpc(method, params);

export const subscribe = async (callback: (event: CoreEvent) => void) =>
  window.vibestar.subscribe(callback);

export const errorMessage = (error: unknown) =>
  (error && typeof error === "object" && "message" in error ? String(error.message) : String(error))
    .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/, "")
    .replace(/(?:AdeError:\s*)+/g, "")
    .replace(/^(?:Error:\s*)+/, "");
