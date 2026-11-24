import { z } from "zod";
import { AdeError } from "../domain";
import type { RpcServices } from "./services";
import { ViberTeamDeleteSchema, ViberTeamSaveSchema } from "../vibers/teams-contracts";

export const viberTeamMethods = [
  "viber.team.list",
  "viber.team.get",
  "viber.team.save",
  "viber.team.delete",
  "viber.team.prepareHandoff",
  "viber.team.handoff",
  "viber.team.cancelHandoff",
] as const;

export const callViberTeams = async (
  { engine }: Pick<RpcServices, "engine">,
  method: string,
  raw: unknown,
) => {
  const sessions = engine.viberSessions;
  switch (method) {
    case "viber.team.list":
      return sessions.teams.list();

    case "viber.team.get": {
      const input = z.object({ team_id: z.string().uuid() }).strict().parse(raw);
      const team = sessions.teams.get(input.team_id);
      if (!team) {
        throw new AdeError("not_found", "Team not found.");
      }

      return team;
    }

    case "viber.team.save": {
      engine.assertAvailable();
      const input = ViberTeamSaveSchema.parse(raw);
      const saved = sessions.teams.save(input);
      engine.changed();
      return saved;
    }

    case "viber.team.delete": {
      engine.assertAvailable();
      const input = ViberTeamDeleteSchema.parse(raw);
      sessions.teams.delete(input.team_id);
      engine.changed();
      return null;
    }

    case "viber.team.prepareHandoff":
      return sessions.prepareTeammateHandoff(raw);

    case "viber.team.handoff":
      return sessions.executeTeammateHandoff(raw);

    case "viber.team.cancelHandoff":
      return sessions.cancelTeammateHandoff(raw);

    default:
      throw new AdeError("invalid_method", `Unknown method: ${method}`);
  }
};
