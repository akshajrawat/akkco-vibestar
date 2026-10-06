export interface Repository {
  id: string;
  owner: string;
  name: string;
  upstream_url: string;
  origin_url: string | null;
  base_branch: string;
  path: string;
  last_fetched: string | null;
  created_at: string;
}
export interface Task {
  id: string;
  repo_id: string;
  issue_number: number;
  issue_url: string;
  claimed_scope: string;
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
  stage: number;
  error: string | null;
}
export interface StageConfig {
  model: string;
  effort: string;
  timeout_secs: number;
}
export interface Settings {
  concurrency: number;
  antigravity: StageConfig;
  codex_plan: StageConfig;
  codex_implementation: StageConfig;
}
export interface Snapshot {
  repositories: Repository[];
  tasks: Task[];
  settings: Settings;
  root: string;
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
  task: Task;
  runs: Run[];
  events: AgentEvent[];
  messages: Message[];
  artifacts: Artifact[];
  tests: TestRun[];
}
export interface Detection {
  provider: string;
  installed: boolean;
  version: string;
  authentication: string;
  models: string[];
  efforts: string[];
  capabilities: string[];
  error: string | null;
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
  | "Scheduled"
  | "Overview"
  | "Tasks"
  | "Repositories"
  | "Diffs"
  | "Providers"
  | "Settings";
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
