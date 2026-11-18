import type { AgentProfile } from "../../apps/core/vibers/contracts";

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
