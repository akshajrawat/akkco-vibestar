import { realpath } from "node:fs/promises";
import { z } from "zod";

import { AdeError, SettingsSchema } from "../domain";
import { capture, checked } from "../execution/runtime/process";
import { Usage } from "../execution/output/usage";
import { Editors } from "../workspace/editors";
import type { RpcServices } from "./services";
import { idInput } from "./validation";

export const systemMethods = [
  "editors.list",
  "editors.open",
  "snapshot",
  "persistence.diagnostics",
  "usage.list",
  "settings.save",
  "providers.detect",
  "auth.connect",
  "auth.input",
  "auth.close",
  "open.directory",
] as const;

/** Validates and dispatches system requests through their existing domain services. */
export const callSystem = async (
  services: Pick<RpcServices, "engine" | "auth">,
  method: string,
  input: unknown,
) => {
  const e = services.engine;
  switch (method) {
    case "editors.list":
      return new Editors(e).list();

    case "editors.open": {
      const p = idInput
        .extend({
          kind: z.enum(["repository", "session"]),
          editor: z.enum(["code", "cursor", "windsurf", "codium"]),
        })
        .strict()
        .parse(input);

      return new Editors(e).open(p.id, p.kind, p.editor);
    }

    case "snapshot": {
      const snapshot = {
        repositories: e.db.repositories(),
        settings: e.db.displaySettings(),
        root: e.root,
        capabilities: {
          viber_conversations: 1,
          viber_sessions: 3,
        },
        execution_environment: {
          distro: process.env.WSL_DISTRO_NAME || "Linux",
        },
        repository_index: e.repositoryIndex.snapshot(),
      };

      const persistence = e.db.records.diagnostics();
      return {
        ...snapshot,
        persistence,
        ...(persistence.length
          ? {
              warning: `${persistence.length} saved record(s) need recovery. Original data is preserved; open Settings for persistence diagnostics.`,
            }
          : {}),
      };
    }

    case "persistence.diagnostics":
      return e.db.records.diagnostics();

    case "usage.list": {
      const p = z
        .object({
          session_id: z.string().uuid().optional(),
          days: z.number().int().min(1).max(3650).optional(),
        })
        .parse(input);

      return new Usage(e.db)
        .list(undefined, p.days)
        .filter((r) => !p.session_id || r.viber_session_id === p.session_id);
    }

    case "settings.save": {
      const before = e.db.displaySettings();
      const after = SettingsSchema.parse(input);
      e.db.saveSettings(after);
      e.memory.reconfigure(before.viber_memory, after.viber_memory);
      e.changed();
      return after;
    }

    case "providers.detect":
      return e.providers();

    case "auth.connect":
      return services.auth.connect(
        z.object({ provider: z.enum(["codex", "antigravity"]) }).parse(input).provider,
      );

    case "auth.input": {
      const p = z.object({ session_id: z.string().uuid(), text: z.string() }).parse(input);
      services.auth.input(p.session_id, p.text);
      return null;
    }

    case "auth.close":
      services.auth.close(z.object({ session_id: z.string().uuid() }).parse(input).session_id);
      return null;

    case "open.directory": {
      const p = idInput.extend({ kind: z.enum(["repository", "session"]) }).parse(input);

      const path =
        p.kind === "session"
          ? await e.git.assertOwnedTask(e.viberSessions.store.workspace(p.id))
          : await realpath(e.db.repository(p.id).path);

      if (process.env.WSL_DISTRO_NAME) {
        const windows = await checked("wslpath", ["-w", path], e.root);
        await capture("explorer.exe", [windows], e.root);
      } else {
        await capture("xdg-open", [path], e.root);
      }

      return null;
    }

    default:
      throw new AdeError("invalid_method", `Unknown method: ${method}`);
  }
};
