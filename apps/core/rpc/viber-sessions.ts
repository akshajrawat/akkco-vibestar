import { z } from "zod";

import {
  ViberSessionCreateSchema,
  ViberSessionScopeSchema,
  ViberSessionSendSchema,
} from "../vibers/contracts";
import type { RpcServices } from "./services";
import { AdeError } from "../domain";

export const viberSessionMethods = [
  "viber.session.create",
  "viber.session.list",
  "viber.session.detail",
  "viber.session.send",
  "viber.session.cancel",
] as const;

export const callViberSessions = async (
  { engine }: Pick<RpcServices, "engine">,
  method: string,
  raw: unknown,
) => {
  const sessions = engine.viberSessions;
  switch (method) {
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
    case "viber.session.detail": {
      const input = ViberSessionScopeSchema.parse(raw);
      return sessions.detail(input.session_id, input.profile_id);
    }

    case "viber.session.send":
      return sessions.send(ViberSessionSendSchema.parse(raw));
    case "viber.session.cancel": {
      engine.assertAvailable();
      const input = ViberSessionScopeSchema.parse(raw);
      return sessions.cancel(input.session_id, input.profile_id);
    }

    default:
      throw new AdeError("invalid_method", `Unknown method: ${method}`);
  }
};
