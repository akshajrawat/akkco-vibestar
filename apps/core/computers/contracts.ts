import { z } from "zod";

export const sharedFilesMount = "/mnt/vibestar-shared";
export const sharedServicesMount = "/run/vibestar-computer.sock";

export const DesktopSize = { width: 1000, height: 640 } as const;

export const ComputerActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["start", "stop", "restart"]) }).strict(),
  z.object({ action: z.literal("reset"), confirmed: z.literal(true) }).strict(),
]);

export const DesktopInputSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("pointer"),
      x: z.number().int().min(0).lt(DesktopSize.width),
      y: z.number().int().min(0).lt(DesktopSize.height),
      button: z.number().int().min(1).max(5),
      phase: z.enum(["down", "up", "click", "move"]),
    })
    .strict(),
  z.object({ type: z.literal("text"), text: z.string().regex(/^[ -~]{1,256}$/) }).strict(),
  z
    .object({
      type: z.literal("key"),
      keys: z.string().regex(/^(?:ctrl\+)?(?:alt\+)?(?:shift\+)?[a-zA-Z0-9_]{1,24}$/),
    })
    .strict(),
]);

export interface ComputerStatus {
  status: "starting" | "ready" | "stopped" | "error";
  error: string | null;
  docker: { ready: boolean; detail: string } | null;
  has_data: boolean;
}

export interface ComputerTerminal {
  id: string;
  output: string;
  sequence: number;
}

export interface ComputerFiles {
  path: string;
  entries: { name: string; directory: boolean }[];
  text: string | null;
}

type Empty = Record<string, never>;

type TerminalId = { terminal_id: string };

export interface ComputerRpc {
  "computer.status": { input: Empty; output: ComputerStatus };
  "computer.control": { input: z.input<typeof ComputerActionSchema>; output: ComputerStatus };
  "computer.terminal.open": { input: Empty; output: ComputerTerminal };
  "computer.terminal.status": { input: Empty; output: ComputerTerminal | null };
  "computer.terminal.input": { input: TerminalId & { text: string }; output: null };
  "computer.terminal.resize": { input: TerminalId & { cols: number; rows: number }; output: null };
  "computer.terminal.close": { input: TerminalId; output: null };
  "computer.files": { input: { path: string }; output: ComputerFiles };
  "computer.desktop.acquire": { input: { controller_id: string }; output: null };
  "computer.desktop.frame": { input: { controller_id: string }; output: string };
  "computer.desktop.input": {
    input: { controller_id: string; input: z.input<typeof DesktopInputSchema> };
    output: null;
  };
  "computer.desktop.release": { input: { controller_id: string }; output: null };
}
