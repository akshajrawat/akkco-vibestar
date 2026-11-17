import { z } from "zod";

import { AdeError } from "../domain";
import type { RpcServices } from "./services";
import { idInput } from "./validation";

export const terminalsMethods = [
  "repair.terminal.status",
  "terminal.status",
  "repair.terminal.open",
  "terminal.open",
  "repair.terminal.input",
  "repair.terminal.resize",
  "repair.terminal.close",
  "repair.command",
  "terminal.input",
  "terminal.resize",
  "terminal.close",
] as const;

/** Validates and dispatches terminals requests through their existing domain services. */
export const callTerminals = async (
  services: Pick<RpcServices, "repairTerminals" | "terminals" | "repairs">,
  method: string,
  input: unknown,
) => {
  switch (method) {
    case "repair.terminal.status":
      return services.repairTerminals.current(idInput.strict().parse(input).id);

    case "terminal.status":
      return services.terminals.current(idInput.parse(input).id);

    case "repair.terminal.open":
    case "terminal.open": {
      const p = idInput
        .extend({
          cols: z.number().int().min(20).max(500),
          rows: z.number().int().min(4).max(200),
        })
        .strict()
        .parse(input);

      return (method.startsWith("repair.") ? services.repairTerminals : services.terminals).open(
        p.id,
        p.cols,
        p.rows,
      );
    }

    case "repair.terminal.input": {
      const p = idInput
        .extend({ session_id: z.string().uuid(), text: z.string().max(8192) })
        .strict()
        .parse(input);

      return services.repairTerminals.input(p.id, p.session_id, p.text);
    }

    case "repair.terminal.resize": {
      const p = idInput
        .extend({
          session_id: z.string().uuid(),
          cols: z.number().int().min(20).max(500),
          rows: z.number().int().min(4).max(200),
        })
        .strict()
        .parse(input);

      return services.repairTerminals.resize(p.id, p.session_id, p.cols, p.rows);
    }

    case "repair.terminal.close":
      return services.repairTerminals.close(idInput.strict().parse(input).id);

    case "repair.command": {
      const p = idInput
        .extend({
          argv: z.array(z.string().min(1).max(8000)).min(1).max(100),
        })
        .strict()
        .parse(input);

      return services.repairs.command(p.id, p.argv);
    }

    case "terminal.input": {
      const p = idInput
        .extend({ session_id: z.string().uuid(), text: z.string().max(8192) })
        .parse(input);

      return services.terminals.input(p.id, p.session_id, p.text);
    }

    case "terminal.resize": {
      const p = idInput
        .extend({
          session_id: z.string().uuid(),
          cols: z.number().int().min(20).max(500),
          rows: z.number().int().min(4).max(200),
        })
        .parse(input);

      return services.terminals.resize(p.id, p.session_id, p.cols, p.rows);
    }

    case "terminal.close":
      return services.terminals.close(idInput.parse(input).id);
    default:
      throw new AdeError("invalid_method", `Unknown method: ${method}`);
  }
};
