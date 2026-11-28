import { z } from "zod";
import { AdeError } from "../domain";
import { ComputerActionSchema, DesktopInputSchema } from "../computers/contracts";
import type { RpcServices } from "./services";

export const computerMethods = [
  "computer.status",
  "computer.control",
  "computer.desktop.acquire",
  "computer.desktop.frame",
  "computer.desktop.input",
  "computer.desktop.release",
] as const;

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
