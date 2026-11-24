import { z } from "zod";

import { AdeError } from "../domain";
import {
  ComputerActionSchema,
  ComputerScopeSchema,
  ComputerTerminalSchema,
  ComputerFileSchema,
} from "../computers/contracts";
import { computerFiles } from "../computers/files";
import type { RpcServices } from "./services";

export const computerMethods = [
  "computer.status",
  "computer.control",
  "computer.providers",
  "computer.terminal.open",
  "computer.terminal.status",
  "computer.terminal.input",
  "computer.terminal.resize",
  "computer.terminal.close",
  "computer.files",
] as const;

export const callComputers = async (
  { engine }: Pick<RpcServices, "engine">,
  method: string,
  raw: unknown,
) => {
  const computers = engine.computers;

  const prepare = (input: { session_id?: string; profile_id: string }) =>
    input.session_id
      ? () => engine.viberSessions.prepareWorkspace(input.session_id!, input.profile_id)
      : undefined;

  switch (method) {
    case "computer.status":
      return computers.status(ComputerScopeSchema.parse(raw));

    case "computer.control": {
      engine.assertAvailable();
      const input = ComputerActionSchema.parse(raw);
      return computers.control(input, input.action, input.confirmed, prepare(input));
    }

    case "computer.providers":
      return computers.providers(ComputerScopeSchema.parse(raw));

    case "computer.terminal.open": {
      engine.assertAvailable();
      const input = ComputerTerminalSchema.parse(raw);
      return computers.openTerminal(input, prepare(input), input.login, input.confirmed);
    }

    case "computer.terminal.status":
      return computers.terminalStatus(ComputerScopeSchema.parse(raw));

    case "computer.terminal.input": {
      engine.assertAvailable();

      const input = ComputerScopeSchema.extend({
        terminal_id: z.string().uuid(),
        text: z.string().max(8192),
      })
        .strict()
        .parse(raw);

      computers.terminalInput(input, input.terminal_id, input.text);
      return null;
    }

    case "computer.terminal.resize": {
      engine.assertAvailable();

      const input = ComputerScopeSchema.extend({
        terminal_id: z.string().uuid(),
        cols: z.number().int().min(10).max(500),
        rows: z.number().int().min(4).max(200),
      })
        .strict()
        .parse(raw);

      computers.terminalResize(input, input.terminal_id, input.cols, input.rows);
      return null;
    }

    case "computer.terminal.close":
      await computers.closeTerminal(ComputerScopeSchema.parse(raw));
      return null;

    case "computer.files": {
      const input = ComputerFileSchema.parse(raw);
      computers.authorize(input);
      const workspace = engine.viberSessions.store.workspace(input.session_id);
      const cwd = await engine.git.assertOwnedTask(workspace);
      return computerFiles(cwd, input.path);
    }

    default:
      throw new AdeError("invalid_method", `Unknown method: ${method}`);
  }
};
