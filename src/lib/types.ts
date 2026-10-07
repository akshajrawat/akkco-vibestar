import type { Repository, Settings } from "../../backend/domain";
export type { Repository, Settings, StageConfig } from "../../backend/domain";
export type Detection =
  import("../../backend/execution/providers/contracts").ProviderDetection;
export interface Task {
  id: string;
  repo_id: string;
  issue_number: number;
  issue_url: string;
  claimed_scope: string;
  scope_mode?: "whole_issue" | "partial";
  notes: string;
  issue: { title?: string; body?: string };
  execution_settings?: Settings;
  branch_name: string;
  base_branch: string;
  base_commit_sha: string;
  worktree_path: string;
  created_at: string;
  updated_at: string;
  status: string;
  archived?: boolean;
  stage: number;
  error: string | null;
}
export interface Snapshot {
  repositories: Repository[];
  tasks: Task[];
  settings: Settings;
  root: string;
  migration?: { old_root: string; new_root: string } | null;
  repository_index?: import("../../backend/workspace/discovery").RepositoryIndexSnapshot;
  github?: {
    status: import("../../backend/github/contracts").GitHubStatus | null;
    last_sync: string | null;
    error: string | null;
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
  task_id: string;
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
  session_id?: string;
  text?: string;
  stream?: string;
  kind?: string;
  data?: unknown;
}
export type Page =
  "Scheduled" | "Tasks" | "Repositories" | "Providers" | "Settings";
export const stages = [
  "Prepare workspace",
  "Antigravity plan",
  "Codex refine plan",
  "Codex implementation",
  "Validation",
  "Ready for review",
];
export const activeStatuses = [
  "preparing",
  "planning_antigravity",
  "planning_codex",
  "implementing",
  "validating",
];
