import { z } from "zod";
import { ViberSessionScopeSchema } from "../vibers/contracts";

export const ComputerScopeSchema = z.object({ profile_id: z.string().uuid() }).strict();

export const ComputerActionSchema = ComputerScopeSchema.extend({
  action: z.enum(["start", "stop", "restart", "reset"]),
  session_id: z.string().uuid().optional(),
  confirmed: z.literal(true).optional(),
}).strict();

export const ComputerTerminalSchema = ComputerScopeSchema.extend({
  session_id: z.string().uuid().optional(),
  login: z.enum(["codex", "antigravity"]).optional(),
  confirmed: z.literal(true).optional(),
}).strict();

export const ComputerFileSchema = ViberSessionScopeSchema.extend({
  path: z.string().max(2000).default(""),
}).strict();

export interface ComputerStatus {
  profile_id: string;
  status: "starting" | "ready" | "running" | "stopped" | "error";
  session_id: string | null;
  error: string | null;
}

export interface ComputerTerminal {
  id: string;
  output: string;
  sequence: number;
  login: "codex" | "antigravity" | null;
  session_id: string | null;
}

export interface ComputerFiles {
  path: string;
  entries: { name: string; directory: boolean }[];
  text: string | null;
}

export interface ComputerRpc {
  "computer.status": { input: z.input<typeof ComputerScopeSchema>; output: ComputerStatus };
  "computer.control": { input: z.input<typeof ComputerActionSchema>; output: ComputerStatus };
  "computer.providers": {
    input: z.input<typeof ComputerScopeSchema>;
    output: import("../execution/providers/contracts").ProviderDetection[];
  };
  "computer.terminal.open": {
    input: z.input<typeof ComputerTerminalSchema>;
    output: ComputerTerminal;
  };
  "computer.terminal.status": {
    input: z.input<typeof ComputerScopeSchema>;
    output: ComputerTerminal | null;
  };
  "computer.terminal.input": {
    input: { profile_id: string; terminal_id: string; text: string };
    output: null;
  };
  "computer.terminal.resize": {
    input: { profile_id: string; terminal_id: string; cols: number; rows: number };
    output: null;
  };
  "computer.terminal.close": { input: z.input<typeof ComputerScopeSchema>; output: null };
  "computer.files": { input: z.input<typeof ComputerFileSchema>; output: ComputerFiles };
  "profile.delete": { input: { profile_id: string; confirmed: true }; output: null };
}
