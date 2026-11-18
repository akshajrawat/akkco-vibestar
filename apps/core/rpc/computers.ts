import { z } from "zod";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { AdeError } from "../domain";
import {
  ComputerActionSchema,
  ComputerScopeSchema,
  ComputerTerminalSchema,
  ComputerFileSchema,
} from "../computers/contracts";
import { computerFiles } from "../computers/files";
import type { RpcServices } from "./services";
import { managedPath } from "../workspace/paths";
import { gitChecked } from "../workspace/git-command";

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
  "profile.delete",
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

    case "profile.delete": {
      const input = ComputerScopeSchema.extend({ confirmed: z.literal(true) })
        .strict()
        .parse(raw);

      engine.assertAvailable();
      computers.authorize(input);

      // Storage maintenance closes admission across profile sessions and Docker operations.
      await engine.withStorageMaintenance(async () => {
        await computers.remove(input);
        for (const session of engine.viberSessions.store.list(input.profile_id)) {
          const row = engine.db.all<{ workspace: string | null }>(
            "SELECT workspace FROM viber_sessions WHERE id=?",
            session.id,
          )[0];

          if (!row.workspace) {
            continue;
          }

          const workspace = engine.viberSessions.store.workspace(session.id);
          if (!workspace.worktree_path || workspace.workspace_checkpoint?.state === "removed") {
            continue;
          }

          if (workspace.repo_id) {
            const repo = engine.db.repository(workspace.repo_id);

            await engine.git.withLock(repo.id, async () => {
              await engine.git.assertOwnedTask(workspace);
              await managedPath(engine.root, workspace.worktree_path);

              await gitChecked(
                ["worktree", "remove", "--force", "--", workspace.worktree_path],
                repo.path,
              );

              await gitChecked(["branch", "-D", "--", workspace.branch_name], repo.path);
            });

            workspace.workspace_checkpoint!.state = "removed";
          } else {
            await engine.git.assertOwnedTask(workspace);
            const directory = await managedPath(engine.root, dirname(workspace.worktree_path));
            await rm(directory, { recursive: true });
            workspace.worktree_path = "";
          }

          engine.viberSessions.store.saveWorkspace(session.id, workspace);

          const logs = await managedPath(
            engine.root,
            join(engine.root, "logs", `viber-${session.id}`),
          );

          await rm(logs, { recursive: true, force: true });
        }

        engine.db.run(
          "INSERT OR IGNORE INTO retired_viber_profiles(profile_id) VALUES(?)",
          input.profile_id,
        );

        engine.db.run("UPDATE viber_sessions SET thread=NULL WHERE profile_id=?", input.profile_id);
        engine.changed();
      });

      return null;
    }

    default:
      throw new AdeError("invalid_method", `Unknown method: ${method}`);
  }
};
