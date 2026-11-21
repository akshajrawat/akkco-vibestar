import type { ComputerRpc } from "../../core/computers/contracts";
import type { z } from "zod";
import type { viberMemoryInputs, ViberMemoryResults } from "../../core/vibers/memory-contracts";

import type { CoreEvent } from "./types";

export const rpc = <T>(method: string, params: unknown = {}): Promise<T> =>
  window.vibestar.rpc<T>(method, params);

export const subscribe = async (callback: (event: CoreEvent) => void) =>
  window.vibestar.subscribe(callback);

export const errorMessage = (error: unknown) =>
  (error && typeof error === "object" && "message" in error ? String(error.message) : String(error))
    .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/, "")
    .replace(/(?:AdeError:\s*)+/g, "")
    .replace(/^(?:Error:\s*)+/, "");

export const computerRpc = <M extends keyof ComputerRpc>(
  method: M,
  params: ComputerRpc[M]["input"],
): Promise<ComputerRpc[M]["output"]> => rpc(method, params);

export const viberMemoryRpc = <M extends keyof ViberMemoryResults>(
  method: M,
  params: z.input<(typeof viberMemoryInputs)[M]>,
): Promise<ViberMemoryResults[M]> => rpc(method, params);
