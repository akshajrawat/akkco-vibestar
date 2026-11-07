import { randomUUID } from "node:crypto";

import type { AgentProfile } from "../../backend/flows/contracts";
import type { FlowWorkspace } from "../../backend/flows/workspace";
import type { Detail } from "../../src/lib/types";
import { builtInProfiles } from "../../backend/flows/templates";

export const viberProfile: AgentProfile = {
  id: builtInProfiles.implementer,
  revision: 1,
  name: "Fixture Viber",
  instructions: "Work on selected inputs.",
  supported_access: ["read-only", "workspace-write"],
  execution: {
    provider: "codex",
    model: "fixture-model",
    effort: "low",
    timeout_secs: 30,
    access: "workspace-write",
    output: "conversation",
  },
};

export const viberDetail = (): Detail => ({
  task: {
    id: randomUUID(),
    repo_id: null,
    issue_number: null,
    issue_url: null,
    kind: "general",
    flow_id: randomUUID(),
    workspace_kind: "managed",
    goal: "Build something",
    status: "not_started",
    stage: 0,
    claimed_scope: "",
    notes: "",
    issue: {},
    branch_name: "",
    base_branch: "",
    base_commit_sha: "",
    worktree_path: "",
    created_at: "2026-11-06T00:00:00.000Z",
    updated_at: "2026-11-06T00:00:00.000Z",
    error: null,
  },
  runs: [],
  events: [],
  messages: [],
  artifacts: [],
  tests: [],
  usage: [],
});

export const viberWorkspace = (detail: Detail): FlowWorkspace => ({
  revision: {
    flow_id: detail.task.flow_id!,
    revision: 1,
    created_at: detail.task.created_at,
    definition: {
      name: "Solo fixture",
      nodes: [
        {
          id: randomUUID(),
          type: "agent",
          name: viberProfile.name,
          profile_id: viberProfile.id,
          overrides: {},
          inputs: [{ kind: "task-goal" }],
          instructions: "",
          completion: { verification: "record-only", review: "none" },
        },
      ],
      edges: [],
    },
  },
  history: null,
  capabilities: { continuations: 1, conversations: 1 },
  conversations: [],
  conversation_attempts: [],
  invalidations: {},
  layout: null,
  runs: [],
  attempts: [],
  results: {},
  stale_results: {},
  definitions: {},
});
