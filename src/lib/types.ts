import type { Task as CoreTask } from "../../backend/domain";
import type { DiffFile as CoreDiffFile } from "../../backend/workspace/git";
import type { Repository, Settings } from "../../backend/domain";
export type { Repository, Settings, StageConfig } from "../../backend/domain";
export type Detection = import("../../backend/execution/providers/contracts").ProviderDetection;
/** Renderer projection retains sparse historical records and uses canonical task field contracts. */
export interface Task
  extends
    Pick<
      CoreTask,
      | "id"
      | "repo_id"
      | "issue_number"
      | "issue_url"
      | "claimed_scope"
      | "notes"
      | "branch_name"
      | "base_branch"
      | "base_commit_sha"
      | "worktree_path"
      | "created_at"
      | "updated_at"
      | "stage"
      | "error"
    >,
    Partial<
      Pick<
        CoreTask,
        | "workflow_start"
        | "verification_environment"
        | "browser_environment_report"
        | "runtime"
        | "preparation_timing"
        | "verification_policy"
        | "scope_mode"
        | "execution_settings"
        | "stage_settings"
        | "archived"
        | "approval_gate"
        | "final_review_verdict"
      >
    > {
  issue: { title?: string; body?: string };
  status: string;
}

export interface Snapshot {
  pr_batches?: import("../../backend/review/pr/batches").PRBatch[];
  capabilities?: {
    manual_issue_watch: boolean;
    issue_watch_contract: number | null;
  };
  persistence?: import("../../backend/storage/records").PersistenceDiagnostic[];
  repairs?: import("../../backend/review/repair/contracts").RepairSession[];
  pr_reports?: {
    job_id: string;
    action_state?: string;
    analyzed_head?: string | null;
    analyzed_at?: string | null;
    outstanding: number;
    unanswered_questions: number;
  }[];
  warning?: string;
  repositories: Repository[];
  tasks: Task[];
  settings: Settings;
  root: string;
  execution_environment?: { distro: string };
  migration?: { old_root: string; new_root: string } | null;
  repository_index?: import("../../backend/workspace/discovery").RepositoryIndexSnapshot;
  github?: {
    clones?: import("../../backend/github/service").CloneActivity[];
    status: import("../../backend/github/contracts").GitHubStatus | null;
    last_sync: string | null;
    error: string | null;
    phase?: string | null;
    settings: import("../../backend/github/contracts").WatchSettings;
    repositories: import("../../backend/github/contracts").GitHubRepository[];
    pull_requests: import("../../backend/github/contracts").GitHubPullRequest[];
  };
  scheduled?: import("../../backend/scheduled/contracts").ScheduleJob[];
  attention?: import("../../backend/scheduled/contracts").ScheduleAttention[];
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
export interface AgentEvent {
  id: number;
  run_id: string;
  task_id: string | null;
  repair_id?: string | null;
  timestamp: string;
  kind: string;
  data: string;
  raw: string;
  stream: string;
}
export interface Message {
  purpose?: "instruction" | "chat";
  status?: string;
  run_id?: string | null;
  id: string;
  role: string;
  content: string;
  created_at: string;
}
export interface Artifact {
  id: string;
  stage: number;
  kind: string;
  content: string;
  created_at: string;
}
export interface TestRun {
  run_id?: string | null;
  call_id?: string | null;
  output_truncated?: number;
  id: string;
  command: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  stdout: string;
  stderr: string;
}
export interface Detail {
  validation?: ReturnType<
    typeof import("../../backend/execution/verification/verification").verificationSummary
  >;
  active?: boolean;
  executing?: boolean;
  task: Task;
  runs: Run[];
  events: AgentEvent[];
  messages: Message[];
  artifacts: Artifact[];
  tests: TestRun[];
  usage?: import("../../backend/execution/output/usage").UsageRecord[];
  activity?: { id: number; kind: string; data: string; timestamp: string }[];
}
export type DiffFile = Omit<CoreDiffFile, "untracked"> & Partial<Pick<CoreDiffFile, "untracked">>;

export interface Diff {
  files: DiffFile[];
  insertions: number;
  deletions: number;
  base: string;
}
export interface FileDiff {
  original: string;
  modified: string;
  binary: boolean;
  unified: string;
}
export type { CoreEvent } from "../../backend/domain";

export type Page =
  "Scheduled" | "Tasks" | "Issue Watch" | "Repositories" | "Providers" | "Usage" | "Settings";
export const stages = [
  "Prepare workspace",
  "Antigravity plan",
  "Codex refine plan",
  "Codex implementation",
  "Validation",
  "Antigravity review & tests",
  "Ready for review",
];
export const activeStatuses = [
  "preparing",
  "planning_antigravity",
  "planning_codex",
  "implementing",
  "validating",
  "reviewing_antigravity",
];
