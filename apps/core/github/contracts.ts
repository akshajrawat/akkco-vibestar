import { z } from "zod";
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

export const GitHubRepositorySchema = z
  .object({
    id: z.number().int(),
    full_name: z.string(),
    owner: z.object({ login: z.string(), type: z.string() }),
    name: z.string(),
    description: z.string().nullable(),
    default_branch: z.string(),
    private: z.boolean(),
    fork: z.boolean(),
    permissions: z.object({ push: z.boolean() }).optional(),
    clone_url: z.string(),
    parent: z
      .object({
        id: z.number().int().positive().optional(),
        full_name: z.string(),
        clone_url: z.string(),
        default_branch: z.string(),
      })
      .optional(),
    updated_at: z.string(),
  })
  .loose();

export const GitHubPullRequestSchema = z
  .object({
    url: z.string(),
    repository: z.string(),
    number: z.number().int().positive(),
    title: z.string(),
    state: z.string(),
    draft: z.boolean().optional(),
    head_sha: z.string().optional(),
    access_error: z.string().optional(),
    last_known_state: z.string().optional(),
    head_branch: z.string(),
    head_repository: z.string().nullable(),
    updated_at: z.string(),
    refreshed_at: z.string().optional(),
    task_id: z.string().nullable(),
  })
  .loose();

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
