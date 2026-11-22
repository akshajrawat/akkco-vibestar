import { AdeError } from "../domain";

export const parsePullRequest = (value: string) => {
  const u = new URL(value);
  const match = u.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/);
  if (
    u.protocol !== "https:" ||
    u.hostname !== "github.com" ||
    u.username ||
    u.password ||
    u.port ||
    u.search ||
    u.hash ||
    !match ||
    match.slice(1, 3).some((part) => part === "." || part === "..") ||
    !Number.isSafeInteger(Number(match[3]))
  ) {
    throw new AdeError("invalid_input", "Use an HTTPS github.com/owner/repository/pull/number URL");
  }

  return {
    owner: match[1],
    repo: match[2],
    number: Number(match[3]),
    url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`,
  };
};

export interface GitHubRepository {
  id: number;
  full_name: string;
  owner: { login: string; type: string };
  name: string;
  description: string | null;
  default_branch: string;
  private: boolean;
  fork: boolean;
  permissions?: { push: boolean };
  clone_url: string;
  parent?: { id?: number; full_name: string; clone_url: string; default_branch: string };
  updated_at: string;
}

export interface GitHubPullRequest {
  url: string;
  repository: string;
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  head_sha?: string;
  access_error?: string;
  last_known_state?: string;
  head_branch: string;
  head_repository: string | null;
  updated_at: string;
  refreshed_at?: string;
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
