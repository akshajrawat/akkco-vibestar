import { z } from "zod";
import { AdeError } from "../domain";
import { ComputerActionSchema, DesktopInputSchema } from "../computers/contracts";
import type { RpcServices } from "./services";

export const computerMethods = [
  "computer.status",
  "computer.control",
  "computer.terminal.open",
  "computer.terminal.status",
  "computer.terminal.input",
  "computer.terminal.resize",
  "computer.terminal.close",
  "computer.files",
  "computer.desktop.acquire",
  "computer.desktop.frame",
  "computer.desktop.input",
  "computer.desktop.release",
] as const;

const terminal = z.object({ terminal_id: z.string().uuid() }).strict();
const controller = z.object({ controller_id: z.string().uuid() }).strict();
const empty = z.object({}).strict();

export const callComputers = async (
  { engine }: Pick<RpcServices, "engine">,
  method: string,
  raw: unknown,
) => {
  const computers = engine.computers;
  switch (method) {
    case "computer.status":
      empty.parse(raw);
      return computers.status();
    case "computer.control":
      return computers.control(ComputerActionSchema.parse(raw).action);
    case "computer.terminal.open":
      empty.parse(raw);
      engine.assertAvailable();
      return computers.openTerminal();
    case "computer.terminal.status":
      empty.parse(raw);
      return computers.terminalStatus();
    case "computer.terminal.input": {
      const { terminal_id, text } = terminal.extend({ text: z.string().max(8192) }).parse(raw);
      computers.terminalInput(terminal_id, text);
      return null;
    }

    case "computer.terminal.resize": {
      const { terminal_id, cols, rows } = terminal
        .extend({
          cols: z.number().int().min(10).max(500),
          rows: z.number().int().min(4).max(200),
        })
        .parse(raw);

      computers.terminalResize(terminal_id, cols, rows);
      return null;
    }

    case "computer.terminal.close":
      await computers.closeTerminal(terminal.parse(raw).terminal_id);
      return null;
    case "computer.files":
      return computers.files(
        z
          .object({ path: z.string().max(2000) })
          .strict()
          .parse(raw).path,
      );
    case "computer.desktop.acquire":
      engine.assertAvailable();
      await computers.desktop.acquire(controller.parse(raw).controller_id);
      return null;
    case "computer.desktop.frame":
      return computers.desktop.frame(controller.parse(raw).controller_id);
    case "computer.desktop.input": {
      const { controller_id, input } = controller.extend({ input: DesktopInputSchema }).parse(raw);
      await computers.desktop.input(controller_id, input);
      return null;
    }

    case "computer.desktop.release":
      await computers.desktop.close(controller.parse(raw).controller_id);
      return null;
    default:
      throw new AdeError("invalid_method", `Unknown method: ${method}`);
  }
};
