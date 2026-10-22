import { PullRequestStateSchema } from "../../scheduled/contracts";
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
    snapshot: PullRequestStateSchema.optional(),
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
