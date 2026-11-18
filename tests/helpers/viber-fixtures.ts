import type { AgentProfile } from "../../apps/core/vibers/contracts";
import type { Database } from "../../apps/core/storage/database";
import { ViberStore } from "../../apps/core/vibers/store";
import { defaultAppearance } from "../../apps/core/vibers/appearance";

export const testProfileIds = {
  implementer: "e1bc5ab8-3a96-4d53-96c5-3103cf484503",
  reviewer: "e1bc5ab8-3a96-4d53-96c5-3103cf484504",
  planner: "e1bc5ab8-3a96-4d53-96c5-3103cf484501",
  refiner: "e1bc5ab8-3a96-4d53-96c5-3103cf484502",
} as const;

export const createTestProfiles = (db: Database) => {
  const store = new ViberStore(db);

  const profiles: AgentProfile[] = [
    {
      id: testProfileIds.implementer,
      revision: 1,
      name: "Implementer",
      appearance: defaultAppearance(),
      instructions: "Work directly on the requested goal.",
      supported_access: ["read-only", "workspace-write"],
      execution: {
        provider: "codex",
        model: "codex",
        effort: "high",
        timeout_secs: 1800,
        access: "workspace-write",
        output: "conversation",
      },
    },
    {
      id: testProfileIds.reviewer,
      revision: 1,
      name: "Reviewer",
      appearance: defaultAppearance(),
      instructions: "Independently review changes.",
      supported_access: ["read-only"],
      execution: {
        provider: "antigravity",
        model: "antigravity",
        effort: "high",
        timeout_secs: 1800,
        access: "read-only",
        output: "conversation",
      },
    },
    {
      id: testProfileIds.planner,
      revision: 1,
      name: "Planner",
      appearance: defaultAppearance(),
      instructions: "Plan the requested work.",
      supported_access: ["read-only"],
      execution: {
        provider: "antigravity",
        model: "antigravity",
        effort: "high",
        timeout_secs: 1800,
        access: "read-only",
        output: "conversation",
      },
    },
  ];

  for (const profile of profiles) {
    if (db.all("SELECT id FROM agent_profiles WHERE id=?", profile.id).length === 0) {
      store.saveProfile(profile, null);
    }
  }
};

export const viberProfile: AgentProfile = {
  id: "e1bc5ab8-3a96-4d53-96c5-3103cf484501",
  revision: 1,
  name: "Viber Fixture",
  instructions: "You are a helpful persistent AI employee.",
  execution: {
    model: "fixture-model",
    effort: "low",
    timeout_secs: 300,
    provider: "codex",
    access: "workspace-write",
    output: "implementation",
  },
  supported_access: ["read-only", "workspace-write"],
};
