import { z } from "zod";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { AdeError } from "../domain";
import type { RpcServices } from "./services";
import { managedPath } from "../workspace/paths";

export const profileMethods = ["profile.delete"] as const;

export const callProfiles = async (
  { engine }: Pick<RpcServices, "engine">,
  method: string,
  raw: unknown,
) => {
  switch (method) {
    case "profile.delete": {
      const input = z
        .object({ profile_id: z.string().uuid(), confirmed: z.literal(true) })
        .strict()
        .parse(raw);

      engine.assertAvailable();
      if (
        !engine.db.all(
          "SELECT id FROM agent_profiles WHERE id=? AND id NOT IN (SELECT profile_id FROM retired_viber_profiles)",
          input.profile_id,
        ).length
      ) {
        throw new AdeError("not_found", "Select an active Viber profile.");
      }

      await engine.withStorageMaintenance(async () => {
        for (const session of engine.viberSessions.store.list(input.profile_id)) {
          const row = engine.db.all<{ workspace: string | null }>(
            "SELECT workspace FROM viber_sessions WHERE id=?",
            session.id,
          )[0];

          if (row.workspace) {
            const workspace = engine.viberSessions.store.workspace(session.id);
            if (workspace.worktree_path && workspace.workspace_checkpoint?.state !== "removed") {
              const save = () => engine.viberSessions.store.saveWorkspace(session.id, workspace);
              if (workspace.repo_id) {
                const repo = engine.db.repository(workspace.repo_id);
                await engine.git.removeOwnedWorktree(repo, workspace, save);
              } else {
                await engine.git.assertOwnedTask(workspace);
                const directory = await managedPath(engine.root, dirname(workspace.worktree_path));
                await rm(directory, { recursive: true });
                workspace.worktree_path = "";
                save();
              }
            }
          }

          const logs = await managedPath(
            engine.root,
            join(engine.root, "logs", `viber-${session.id}`),
          );

          await rm(logs, { recursive: true, force: true });
        }

        engine.db.transaction(() => {
          engine.db.run(
            "INSERT OR IGNORE INTO retired_viber_profiles(profile_id) VALUES(?)",
            input.profile_id,
          );

          engine.db.run(
            "UPDATE viber_sessions SET thread=NULL,threads=NULL WHERE profile_id=?",
            input.profile_id,
          );
        });

        engine.changed();
      });

      return null;
    }

    default:
      throw new AdeError("invalid_method", `Unknown method: ${method}`);
  }
};
