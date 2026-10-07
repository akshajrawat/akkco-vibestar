export interface GitHubRepository {
  id: number;
  full_name: string;
  owner: { login: string; type: string };
  name: string;
  description: string | null;
  default_branch: string;
  private: boolean;
  fork: boolean;
  clone_url: string;
  parent?: { full_name: string; clone_url: string; default_branch: string };
  updated_at: string;
}
export interface GitHubPullRequest {
  url: string;
  repository: string;
  number: number;
  title: string;
  state: string;
  head_branch: string;
  head_repository: string | null;
  updated_at: string;
  task_id: string | null;
}
export interface GitHubStatus {
  installed: boolean;
  connected: boolean;
  username: string | null;
  version: string;
  error: string | null;
}
export interface WatchSettings {
  auto_watch: boolean;
  interval_minutes: number;
  verify_codex: boolean;
}
