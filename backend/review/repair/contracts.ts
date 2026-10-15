import { z } from "zod";
import { StageConfigSchema } from "../../domain";
import type { PRAnalysisSession, ReviewAction } from "../pr/contracts";
import { ReviewActionSchema } from "../pr/contracts";
import { ReviewAnalysisSchema } from "../pr/contracts";

const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
const repository = z
  .object({
    name: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    id: z.string().min(1),
    url: z.string().url(),
  })
  .strict();

export const PRIdentitySchema = z
  .object({
    url: z.string().url(),
    number: z.number().int().positive(),
    id: z.string().min(1),
    upstream: repository,
    head: repository.extend({ branch: z.string().min(1), sha }).strict(),
    base: z.object({ branch: z.string().min(1), sha }).strict(),
    viewer: z.string().min(1),
    can_push: z.boolean(),
    state: z.enum(["open", "closed"]),
    checked_at: z.string().datetime(),
  })
  .strict();
export type PRIdentity = z.infer<typeof PRIdentitySchema>;

export const RepairWorkspaceSchema = z
  .object({
    branch_name: z.string(),
    worktree_path: z.string(),
    branch_owned: z.boolean(),
    git_common_dir: z.string(),
    source_worktrees: z.string(),
    operation: z
      .object({
        kind: z.string(),
        pid: z.number().int().positive(),
        identity: z.string(),
        started_at: z.string().datetime(),
      })
      .strict()
      .nullable()
      .optional(),
    original_head: sha,
    original_base: sha,
    fetched_base: sha.nullable(),
    integrated_head: sha.nullable(),
    merge_commit: sha.nullable(),
    merge_state: z.enum(["not_started", "intent", "conflict", "complete"]),
    conflict_paths: z.array(z.string()),
    conflict_index: z.string(),
    cleanup_head: sha.nullable().optional(),
    preparation: z.enum([
      "pending",
      "creating",
      "merging",
      "conflict",
      "ready",
      "removed",
      "removing",
    ]),
    remote_head: sha,
    remote_checked_at: z.string().datetime(),
  })
  .strict();
export type RepairWorkspace = z.infer<typeof RepairWorkspaceSchema>;

export const repairStatuses = [
  "created",
  "preparing",
  "ready_to_repair",
  "codex_implementing",
  "antigravity_verifying",
  "awaiting_manual_review",
  "ready_to_publish",
  "published",
  "failed",
  "cancelled",
  "interrupted",
  "merge_conflict",
  "stale_remote_head",
  "verification_blocked",
] as const;

const tests = z.array(
  z
    .object({
      command: z.string().min(1),
      status: z.enum(["passed", "failed", "blocked", "not_run"]),
      evidence: z.string(),
    })
    .strict(),
);
export const RepairImplementationSchema = z
  .object({
    summary: z.string().min(1),
    items: z.array(
      z
        .object({
          actionId: z.string().uuid(),
          status: z.enum(["implemented", "clarified", "unresolved", "blocked"]),
          files: z.array(z.string()),
          explanation: z.string().min(1),
          tests,
        })
        .strict(),
    ),
    tests,
    risks: z.array(z.string()),
  })
  .strict();
export const RepairVerificationSchema = z
  .object({
    overall: z.enum(["approved", "changes_requested", "blocked"]),
    summary: z.string().min(1),
    items: z.array(
      z
        .object({
          actionId: z.string().uuid(),
          status: z.enum(["accepted", "incomplete", "unverified"]),
          files: z.array(z.string()),
          explanation: z.string().min(1),
        })
        .strict(),
    ),
    tests,
    risks: z.array(z.string()),
  })
  .strict();

export interface RepairSession {
  id: string;
  job_id: string;
  repo_id: string;
  analysis_id: string;
  identity: PRIdentity;
  context: PRAnalysisSession;
  actions: ReviewAction[];
  instructions: string;
  configuration: {
    codex: z.infer<typeof StageConfigSchema>;
    antigravity: z.infer<typeof StageConfigSchema>;
  };
  workspace: RepairWorkspace;
  status: (typeof repairStatuses)[number];
  error: string | null;
  created_at: string;
  updated_at: string;
  review_hash: string | null;
  approved_hash: string | null;
  implementation: z.infer<typeof RepairImplementationSchema> | null;
  verification: z.infer<typeof RepairVerificationSchema> | null;
}
const snapshotSchema = z
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
            comments: z
              .array(z.object({ id: z.string(), body: z.string() }).strict())
              .optional(),
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
            type: z.enum([
              "issue_comment",
              "review_comment",
              "review",
              "thread",
            ]),
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
const contextSchema = z
  .object({
    id: z.string().uuid(),
    job_id: z.string().uuid(),
    status: z.enum([
      "running",
      "completed",
      "partial",
      "failed",
      "cancelled",
      "interrupted",
    ]),
    started_at: z.string().datetime(),
    ended_at: z.string().datetime().nullable(),
    phase: z.string(),
    configuration: StageConfigSchema.extend({
      provider: z.enum(["codex", "antigravity"]),
    }).strict(),
    snapshot: snapshotSchema.optional(),
    method: z.enum(["deterministic", "utility_ai", "reused"]).optional(),
    changes: z.array(z.string()).optional(),
    error: z.string().optional(),
    report: z
      .object({
        summary: z.string(),
        actions: z.array(ReviewActionSchema),
        coverage: ReviewAnalysisSchema.shape.coverage,
        complete: z.boolean(),
        warnings: z.array(z.string()),
      })
      .strict()
      .optional(),
  })
  .strict();
export const RepairSessionSchema = z
  .object({
    id: z.string().uuid(),
    job_id: z.string().uuid(),
    repo_id: z.string().uuid(),
    analysis_id: z.string().uuid(),
    identity: PRIdentitySchema,
    context: z.custom<PRAnalysisSession>(
      (value) => contextSchema.safeParse(value).success,
    ),
    actions: z.array(ReviewActionSchema).min(1),
    instructions: z.string(),
    configuration: z
      .object({
        codex: StageConfigSchema.strict(),
        antigravity: StageConfigSchema.strict(),
      })
      .strict(),
    workspace: RepairWorkspaceSchema,
    status: z.enum(repairStatuses),
    error: z.string().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    review_hash: z.string().nullable(),
    approved_hash: z.string().nullable(),
    implementation: RepairImplementationSchema.nullable(),
    verification: RepairVerificationSchema.nullable(),
  })
  .strict();
