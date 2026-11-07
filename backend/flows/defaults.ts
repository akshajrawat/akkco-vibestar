import type { Database } from "../storage/database";
import { AdeError } from "../domain";
import type { AgentProfile } from "./contracts";
import { FlowStore } from "./store";
import { builtInProfiles } from "./templates";

/** Seed saved settings once; later application launches never overwrite profile edits. */
export const initializeProfiles = (db: Database) => {
  if (
    Object.values(builtInProfiles).every(
      (id) => db.all("SELECT id FROM agent_profiles WHERE id=?", id).length,
    )
  )
    return;
  let settings;
  try {
    settings = db.settings();
  } catch (error) {
    // Retain access to healthy history. A corrupt settings record supplies no profile defaults.
    if (error instanceof AdeError && error.kind === "corrupt_record") return;
    throw error;
  }

  const store = new FlowStore(db);

  const definitions = [
    [
      "planner",
      "Planner",
      settings.antigravity,
      "antigravity",
      "read-only",
      "plan",
      "Plan the requested work. Inspect files without modifying them.",
    ],
    [
      "refiner",
      "Refiner",
      settings.codex_plan,
      "codex",
      "read-only",
      "refinement",
      "Refine the selected plan against the workspace. Remain read-only.",
    ],
    [
      "implementer",
      "Implementer",
      settings.codex_implementation,
      "codex",
      "workspace-write",
      "conversation",
      "Work directly on the requested goal. Inspect, edit and run checks within the assigned workspace. Report observed outcomes honestly.",
    ],
    [
      "reviewer",
      "Reviewer",
      settings.antigravity_review || settings.antigravity,
      "antigravity",
      "read-only",
      "review",
      "Independently review the selected changes and evidence. Remain read-only and distinguish missing checks from passing checks.",
    ],
  ] as const;

  db.transaction(() => {
    for (const [role, name, config, fallback, access, output, instructions] of definitions) {
      const id = builtInProfiles[role];
      if (db.all("SELECT id FROM agent_profiles WHERE id=?", id).length) continue;

      const profile: AgentProfile = {
        id,
        revision: 1,
        name,
        instructions,
        supported_access:
          access === "workspace-write" ? ["read-only", "workspace-write"] : ["read-only"],
        execution: { ...config, provider: config.provider || fallback, access, output },
      };

      store.saveProfile(profile, null);
    }
  });
};
