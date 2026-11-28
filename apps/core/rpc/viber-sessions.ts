import { z } from "zod";

import {
  AgentProfileSchema,
  ViberContinuationPrepareSchema,
  ViberSessionCreateSchema,
  ViberSessionScopeSchema,
  ViberSessionSendSchema,
  type ViberNavigation,
} from "../vibers/contracts";
import type { RpcServices } from "./services";
import { AdeError } from "../domain";
import { managedFiles } from "../workspace/managed-files";

export const viberSessionMethods = [
  "profile.list",
  "profile.save",
  "viber.session.create",
  "viber.session.list",
  "viber.session.detail",
  "viber.schedule.list",
  "viber.session.send",
  "viber.session.prepareContinuation",
  "viber.session.cancel",
  "viber.session.inspect",
] as const;

export const callViberSessions = async (
  { engine }: Pick<RpcServices, "engine">,
  method: string,
  raw: unknown,
) => {
  const sessions = engine.viberSessions;
  switch (method) {
    case "profile.list": {
      const profiles = engine.vibers.listProfiles();

      if (z.object({ include_previews: z.literal(true) }).safeParse(raw).success) {
        const dates = engine.db.all<{ id: string; created_at: string }>(
          "SELECT id, created_at FROM agent_profiles WHERE id NOT IN (SELECT profile_id FROM retired_viber_profiles)",
        );

        return {
          profiles,
          previews: sessions.store.messagePreviews(),
          created_at_by_profile: Object.fromEntries(
            dates.map(({ id, created_at }) => [id, created_at]),
          ),
        } satisfies ViberNavigation;
      }

      return profiles;
    }

    case "profile.save": {
      engine.assertAvailable();

      const p = z
        .object({
          profile: AgentProfileSchema,
          expected_revision: z.number().int().positive().nullable(),
        })
        .strict()
        .parse(raw);

      const saved = engine.vibers.saveProfile(p.profile, p.expected_revision);
      engine.changed();
      return saved;
    }

    case "viber.session.create": {
      engine.assertAvailable();
      const session = sessions.store.create(ViberSessionCreateSchema.parse(raw));
      engine.changed();
      return session;
    }

    case "viber.session.list":
      return sessions.store.list(
        z.object({ profile_id: z.string().uuid() }).strict().parse(raw).profile_id,
      );

    case "viber.schedule.list":
      return engine.schedules.list(
        z.object({ profile_id: z.string().uuid() }).strict().parse(raw).profile_id,
      );

    case "viber.session.detail": {
      const input = ViberSessionScopeSchema.parse(raw);
      return sessions.detail(input.session_id, input.profile_id);
    }

    case "viber.session.send":
      return sessions.send(ViberSessionSendSchema.parse(raw));

    case "viber.session.prepareContinuation":
      return sessions.prepareContinuation(ViberContinuationPrepareSchema.parse(raw));

    case "viber.session.inspect": {
      const input = ViberSessionScopeSchema.extend({ path: z.string().min(1).max(2000).optional() })
        .strict()
        .parse(raw);

      sessions.store.session(input.session_id, input.profile_id);
      const workspace = sessions.store.workspace(input.session_id);
      if (!workspace.repo_id) {
        return managedFiles(engine.root, workspace, input.path);
      }

      if (!workspace.worktree_path) {
        return { files: [], path: input.path || null, text: null };
      }

      await engine.git.assertOwnedTask(workspace);
      const diff = await engine.git.diff(workspace);
      if (input.path && !diff.files.some((file) => file.path === input.path)) {
        throw new AdeError("isolation", "Select a changed file from this conversation.");
      }

      const file = input.path ? await engine.git.file(workspace, input.path) : null;
      return {
        files: diff.files.map((file) => file.path),
        path: input.path || null,
        text: file ? (file.binary ? "Binary file" : file.modified) : null,
      };
    }

    case "viber.session.cancel": {
      engine.assertAvailable();
      const input = ViberSessionScopeSchema.parse(raw);
      return sessions.cancel(input.session_id, input.profile_id);
    }

    default:
      throw new AdeError("invalid_method", `Unknown method: ${method}`);
  }
};
