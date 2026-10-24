import type { Repository, Settings } from "../../backend/domain";
export type { Repository, Settings, StageConfig } from "../../backend/domain";
export type Detection =
  import("../../backend/execution/providers/contracts").ProviderDetection;
export interface Task {
  verification_environment?: import("../../backend/execution/browser/contracts").VerificationEnvironment;
  browser_environment_report?: import("../../backend/execution/browser/contracts").BrowserEnvironmentReport;
  runtime?: {
    python: string | null;
    dependencies: string[];
    warnings: string[];
  };
  id: string;
  repo_id: string;
  issue_number: number;
  issue_url: string;
  claimed_scope: string;
  scope_mode?: "whole_issue" | "partial";
  notes: string;
  issue: { title?: string; body?: string };
  execution_settings?: Settings;
  stage_settings?: import("../../backend/domain").Task["stage_settings"];
  branch_name: string;
  base_branch: string;
  base_commit_sha: string;
  worktree_path: string;
  created_at: string;
  updated_at: string;
  status: string;
  archived?: boolean;
  approval_gate?: import("../../backend/domain").Task["approval_gate"];
  stage: number;
  error: string | null;
}
export interface Snapshot {
  capabilities?: {
    manual_issue_watch: boolean;
    issue_watch_contract: number | null;
  };
  persistence?: import("../../backend/storage/records").PersistenceDiagnostic[];
  repairs?: import("../../backend/review/repair/contracts").RepairSession[];
  pr_reports?: {
    job_id: string;
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
    typeof import("../../backend/execution/verification").verificationSummary
  >;
  active?: boolean;
  executing?: boolean;
  task: Task;
  runs: Run[];
  events: AgentEvent[];
  messages: Message[];
  artifacts: Artifact[];
  tests: TestRun[];
  usage?: import("../../backend/execution/usage").UsageRecord[];
  activity?: { id: number; kind: string; data: string; timestamp: string }[];
}
export interface DiffFile {
  path: string;
  old_path: string | null;
  status: string;
  staged: boolean;
  unstaged: boolean;
  untracked?: boolean;
  insertions: number;
  deletions: number;
  binary: boolean;
}
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
export interface CoreEvent {
  event: string;
  task_id?: string;
  repair_id?: string;
  watch_id?: string;
  scan_id?: string;
  run_id?: string;
  session_id?: string;
  text?: string;
  stream?: string;
  kind?: string;
  data?: unknown;
}
export type Page =
  | "Scheduled"
  | "Tasks"
  | "Issue Watch"
  | "Repositories"
  | "Providers"
  | "Usage"
  | "Settings";
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
