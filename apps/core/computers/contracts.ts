import { z } from "zod";

export const sharedFilesMount = "/mnt/vibestar-shared";
export const sharedServicesMount = "/mnt/vibestar-computer/http.sock";
export const sharedCommandUrl = "http://computer/exec";

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
  z
    .object({
      type: z.literal("text"),
      text: z
        .string()
        .min(1)
        .max(256)
        .regex(/^[^\p{Cc}\p{Cs}]+$/u),
    })
    .strict(),
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
  progress?: string;
  docker: { ready: boolean; detail: string } | null;
  has_data: boolean;
  reset_pending?: boolean;
}

type Empty = Record<string, never>;

export interface ComputerRpc {
  "computer.status": { input: Empty; output: ComputerStatus };
  "computer.control": { input: z.input<typeof ComputerActionSchema>; output: ComputerStatus };
  "computer.desktop.acquire": { input: { controller_id: string }; output: null };
  "computer.desktop.frame": { input: { controller_id: string }; output: string };
  "computer.desktop.input": {
    input: { controller_id: string; input: z.input<typeof DesktopInputSchema> };
    output: null;
  };
  "computer.desktop.release": { input: { controller_id: string }; output: null };
}
