import type { Repository, Settings } from "../../core/domain";
import type { AgentProfile } from "../../core/vibers/contracts";

export type { Repository, Settings, AgentProfile };
export type Detection = import("../../core/execution/providers/contracts").ProviderDetection;

export interface AgentEvent {
  id: number;
  run_id: string;
  task_id?: string | null;
  session_id?: string | null;
  timestamp: string;
  kind: string;
  data: string;
  raw: string;
  stream: string;
}

export interface Snapshot {
  warning?: string;
  capabilities?: {
    viber_conversations?: number;
    viber_sessions?: number;
  };
  persistence?: import("../../core/storage/records").PersistenceDiagnostic[];
  repositories: Repository[];
  settings: Settings;
  root: string;
  execution_environment?: { distro: string };
  migration?: { old_root: string; new_root: string } | null;
  repository_index?: import("../../core/workspace/discovery").RepositoryIndexSnapshot;
  github?: {
    clones?: import("../../core/github/service").CloneActivity[];
    status: import("../../core/github/contracts").GitHubStatus | null;
    last_sync: string | null;
    error: string | null;
    phase?: string | null;
    settings: import("../../core/github/contracts").WatchSettings;
    repositories: import("../../core/github/contracts").GitHubRepository[];
    pull_requests: import("../../core/github/contracts").GitHubPullRequest[];
  };
}

export interface Run {
  id: string;
  purpose?: string;
  stage: number;
  provider: string;
  model: string;
  effort: string;
  prompt: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  pid: number | null;
  conversation_id: string | null;
  output: string | null;
  error: string | null;
}

export interface Message {
  id: string;
  role: string;
  content: string;
  created_at: string;
  status?: string;
  purpose?: string;
  run_id?: string | null;
}

export type { DiffFile } from "../../core/workspace/git";

export type { CoreEvent } from "../../core/domain";
export type WorkspaceTool = "Repositories" | "Providers" | "Usage" | "Settings";
