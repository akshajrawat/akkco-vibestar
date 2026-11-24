import { AdeError } from "../domain";

export const parsePullRequest = (value: string) => {
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    throw new AdeError("invalid_input", "Use an HTTPS github.com/owner/repository/pull/number URL");
  }

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

export interface CanonicalPullRequestRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

export const canonicalPullRequest = (value: string): CanonicalPullRequestRef => {
  const parsed = parsePullRequest(value);
  const owner = parsed.owner.toLowerCase();
  const repo = parsed.repo.toLowerCase();
  return {
    owner,
    repo,
    number: parsed.number,
    url: `https://github.com/${owner}/${repo}/pull/${parsed.number}`,
  };
};

export type WatchCommand =
  | { type: "create"; url: string }
  | { type: "list" }
  | { type: "cancel"; target: string }
  | { type: "help"; message?: string };

export const isWatchCommand = (text: string): boolean => {
  const trimmed = text.trim();
  return /^\/(?:watch(?:es)?|unwatch)(?:\s|$)/i.test(trimmed);
};

export const parseWatchCommand = (text: string): WatchCommand | null => {
  const trimmed = text.trim();
  if (/^\/watches(?:\s+list)?\s*$/i.test(trimmed)) {
    return { type: "list" };
  }

  const unwatchMatch = trimmed.match(/^\/unwatch(?:\s+(.+))?$/i);
  if (unwatchMatch) {
    const target = unwatchMatch[1]?.trim();
    if (!target) {
      return { type: "help", message: "Usage: /unwatch <pr-url | watch-id>" };
    }

    return { type: "cancel", target };
  }

  const watchMatch = trimmed.match(/^\/watch(?:\s+(.*))?$/i);
  if (!watchMatch) {
    return null;
  }

  const rest = (watchMatch[1] ?? "").trim();
  if (!rest || /^help$/i.test(rest)) {
    return { type: "help" };
  }

  if (/^list$/i.test(rest)) {
    return { type: "list" };
  }

  const cancelMatch = rest.match(/^(?:cancel|remove|stop)(?:\s+(.+))?$/i);
  if (cancelMatch) {
    const target = cancelMatch[1]?.trim();
    if (!target) {
      return { type: "help", message: "Usage: /watch cancel <pr-url | watch-id>" };
    }

    return { type: "cancel", target };
  }

  const createMatch = rest.match(/^(?:create|add)\s+(.+)$/i);
  if (createMatch) {
    return { type: "create", url: createMatch[1].trim() };
  }

  return { type: "create", url: rest };
};

export interface PrWatchCursor {
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
  head_sha: string;
  review_decision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  check_status: string | null;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  updated_at: string;
}

export interface PrWatchRecord {
  id: string;
  session_id: string;
  url: string;
  owner: string;
  repo: string;
  pull_number: number;
  title: string | null;
  status: "active" | "completed" | "cancelled" | "failed";
  cursor: string | null;
  last_checked_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

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
