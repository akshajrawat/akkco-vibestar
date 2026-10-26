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
  )
    throw new AdeError("invalid_input", "Use an HTTPS github.com/owner/repository/pull/number URL");
  return {
    owner: match[1],
    repo: match[2],
    number: Number(match[3]),
    url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`,
  };
};

export const ScheduleInput = z.object({
  url: z.string().max(2000),
  task_id: z.string().uuid().nullable(),
  interval_minutes: z.number().int().min(5).max(10080),
  verify_codex: z.boolean().default(false),
});

export interface PullRequestState {
  fetchedAt?: string;
  identity?: {
    prId: string;
    headRepository: string | null;
    headRepositoryId: string | null;
    headBranch: string;
    baseRepository: string;
    baseRepositoryId: string;
    baseBranch: string;
  };
  coverage?: { complete: boolean; missing: string[]; warnings: string[] };
  files?: {
    path: string;
    previousPath: string | null;
    status: string;
    patch: string | null;
  }[];
  commits?: {
    sha: string;
    author: string | null;
    message: string;
    date: string;
    url: string;
  }[];
  linkedIssues?: Record<string, unknown>[];
  title: string;
  body: string;
  state: string;
  mergeable: string;
  reviewDecision: string;
  headRefOid: string;
  author?: string;
  baseRefOid?: string;
  authenticatedUser?: string;
  discussion?: DiscussionEntry[];
  threads?: {
    id: string;
    resolved: boolean;
    path: string;
    body: string;
    commentIds?: string[];
    comments?: { id: string; body: string }[];
    outdated?: boolean;
    line?: number | null;
    startLine?: number | null;
  }[];
  comments: { id: string; body: string; updated_at: string; author?: string }[];
  reviews: {
    id: string;
    body: string;
    state: string;
    submitted_at: string;
    author?: string;
  }[];
  checks: {
    name: string;
    state: string;
    url: string;
    completedAt?: string;
    startedAt?: string;
    id?: string;
  }[];
}

export const PullRequestStateSchema = z
  .object({
    fetchedAt: z.string().optional(),
    identity: z
      .object({
        prId: z.string(),
        headRepository: z.string().nullable(),
        headRepositoryId: z.string().nullable(),
        headBranch: z.string(),
        baseRepository: z.string(),
        baseRepositoryId: z.string(),
        baseBranch: z.string(),
      })
      .strict()
      .optional(),
    coverage: z
      .object({
        complete: z.boolean(),
        missing: z.array(z.string()),
        warnings: z.array(z.string()),
      })
      .strict()
      .optional(),
    title: z.string(),
    body: z.string(),
    state: z.string(),
    mergeable: z.string(),
    reviewDecision: z.string(),
    headRefOid: z.string(),
    baseRefOid: z.string().optional(),
    author: z.string().optional(),
    authenticatedUser: z.string().optional(),
    comments: z.array(
      z
        .object({
          id: z.string(),
          body: z.string(),
          updated_at: z.string(),
          author: z.string().optional(),
        })
        .strict(),
    ),
    reviews: z.array(
      z
        .object({
          id: z.string(),
          body: z.string(),
          state: z.string(),
          submitted_at: z.string(),
          author: z.string().optional(),
        })
        .strict(),
    ),
    checks: z.array(
      z
        .object({
          name: z.string(),
          state: z.string(),
          url: z.string(),
          completedAt: z.string().optional(),
          startedAt: z.string().optional(),
          id: z.string().optional(),
        })
        .strict(),
    ),
    files: z
      .array(
        z
          .object({
            path: z.string(),
            previousPath: z.string().nullable(),
            status: z.string(),
            patch: z.string().nullable(),
          })
          .strict(),
      )
      .optional(),
    commits: z
      .array(
        z
          .object({
            sha: z.string(),
            author: z.string().nullable(),
            message: z.string(),
            date: z.string(),
            url: z.string(),
          })
          .strict(),
      )
      .optional(),
    linkedIssues: z.array(z.record(z.string(), z.unknown())).optional(),
    threads: z
      .array(
        z
          .object({
            id: z.string(),
            resolved: z.boolean(),
            path: z.string(),
            body: z.string(),
            commentIds: z.array(z.string()).optional(),
            comments: z.array(z.object({ id: z.string(), body: z.string() }).strict()).optional(),
            outdated: z.boolean().optional(),
            line: z.number().nullable().optional(),
            startLine: z.number().nullable().optional(),
          })
          .strict(),
      )
      .optional(),
    discussion: z
      .array(
        z
          .object({
            id: z.string(),
            type: z.enum(["issue_comment", "review_comment", "review", "thread"]),
            author: z.string(),
            body: z.string(),
            createdAt: z.string(),
            updatedAt: z.string(),
            path: z.string().optional(),
            line: z.number().optional(),
            reviewState: z.string().optional(),
            reviewId: z.string().optional(),
            resolved: z.boolean().optional(),
            threadId: z.string().optional(),
            authorAssociation: z.string().optional(),
            bot: z.boolean().optional(),
            url: z.string().optional(),
            authorId: z.string().optional(),
            inReplyToId: z.string().optional(),
            commitId: z.string().optional(),
            originalCommitId: z.string().optional(),
            startLine: z.number().optional(),
            originalLine: z.number().optional(),
            originalStartLine: z.number().optional(),
            side: z.string().optional(),
            diffHunk: z.string().optional(),
            outdated: z.boolean().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export interface DiscussionEntry {
  id: string;
  type: "issue_comment" | "review_comment" | "review" | "thread";
  author: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  path?: string;
  line?: number;
  reviewState?: string;
  reviewId?: string;
  resolved?: boolean;
  threadId?: string;
  authorAssociation?: string;
  bot?: boolean;
  url?: string;
  authorId?: string;
  inReplyToId?: string;
  commitId?: string;
  originalCommitId?: string;
  startLine?: number;
  originalLine?: number;
  originalStartLine?: number;
  side?: string;
  diffHunk?: string;
  outdated?: boolean;
}

export interface ScheduleJob {
  id: string;
  url: string;
  task_id: string | null;
  interval_minutes: number;
  verify_codex: boolean;
  enabled: boolean;
  next_run_at: string;
  status: "idle" | "polling" | "pending" | "analyzing" | "interrupted" | "error";
  last_checked_at: string | null;
  last_analyzed_at?: string;
  last_snapshot: PullRequestState | null;
  pending_snapshot: PullRequestState | null;
  changes: string[];
  error: string | null;
  archived?: boolean;
  paused_before_archive?: boolean;
  check_once?: boolean;
  title?: string;
  action?: import("./action").PullRequestAction;
  attention_source?: "review" | "ci" | "conflict" | null;
  analysis_method?: "deterministic" | "utility_ai";
  conversation_action?: import("./action").PullRequestAction;
}

export interface ScheduleAttention {
  id: string;
  job_id: string;
  task_id: string | null;
  created_at: string;
  summary: string;
  changes: string;
  analysis: string | null;
  refinement: string | null;
  error: string | null;
  dismissed: number;
}

export const changedPullRequest = (previous: PullRequestState, current: PullRequestState) => {
  const changes: string[] = [];
  if (
    current.discussion &&
    JSON.stringify(previous.discussion) !== JSON.stringify(current.discussion)
  )
    changes.push("Discussion chronology or authorship changed");
  for (const comment of current.comments)
    if (
      !previous.comments.some(
        (p) =>
          p.id === comment.id && p.body === comment.body && p.updated_at === comment.updated_at,
      )
    )
      changes.push(`New or edited comment ${comment.id}: ${comment.body}`);
  for (const review of current.reviews)
    if (
      !previous.reviews.some(
        (p) => p.id === review.id && p.body === review.body && p.state === review.state,
      )
    )
      changes.push(`Review ${review.state}: ${review.body}`);
  if (current.reviewDecision !== previous.reviewDecision)
    changes.push(`Review decision: ${current.reviewDecision || "pending"}`);
  for (const check of current.checks)
    if (
      !previous.checks.some(
        (p) => p.name === check.name && p.state === check.state && p.url === check.url,
      )
    )
      changes.push(`CI ${check.name}: ${check.state} ${check.url}`);
  for (const thread of current.threads || [])
    if (
      !previous.threads?.some(
        (p) => p.id === thread.id && p.resolved === thread.resolved && p.body === thread.body,
      )
    )
      changes.push(
        `Review thread ${thread.resolved ? "resolved" : "unresolved"}: ${thread.path} ${thread.body}`,
      );
  if (previous.headRefOid !== current.headRefOid) changes.push("PR branch has new commits");
  if (previous.baseRefOid && current.baseRefOid !== previous.baseRefOid)
    changes.push("Base branch updated");
  if (previous.mergeable !== current.mergeable)
    changes.push(
      current.mergeable === "CONFLICTING"
        ? "Merge conflicts detected"
        : `Merge status: ${current.mergeable}`,
    );
  if (current.state !== previous.state) changes.push(`PR state: ${current.state}`);
  return {
    changes,
    actionable: current.state === "OPEN" && changes.length > 0,
  };
};
