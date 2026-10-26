import { z } from "zod";
import { StageConfigSchema } from "../domain";

const identity = z.string().min(1).max(256);
const text = z.string().max(1048576);
const timestamp = z.string().datetime({ offset: true });
export const RepositoryIdentitySchema = z
  .object({
    id: identity,
    full_name: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/)
      .max(200),
    url: z.string().max(500),
  })
  .strict();
export const IssueReferenceSchema = z
  .object({
    repository: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/)
      .max(200),
    number: z.number().int().positive().safe(),
  })
  .strict();
export const WatchRulesSchema = z
  .object({
    compiler_version: z.literal(1),
    open_only: z.literal(true),
    exclude_pull_requests: z.literal(true),
    excluded_labels: z.array(z.string().min(1).max(100)).max(30),
    excluded_issues: z.array(IssueReferenceSchema).max(200),
    trackers: z
      .array(
        z
          .object({
            url: z.string().min(1).max(500),
            comments: z.enum(["none", "all"]),
          })
          .strict(),
      )
      .max(5),
    unassigned_only: z.boolean(),
    active_claims: z.literal("review_possible_exclude_confirmed"),
    competing_pull_requests: z.literal("exclude_confirmed_open"),
  })
  .strict();
export const WatchLimitsSchema = z
  .object({
    max_candidates: z.number().int().min(1).max(200).default(200),
    max_context_candidates: z.number().int().min(1).max(40).default(40),
    max_semantic_candidates: z.number().int().min(1).max(20).default(20),
    max_requests: z.number().int().min(5).max(400).default(400),
  })
  .strict();
export const WatchConfigurationSchema = z
  .object({
    prompt: z.string().min(1).max(8000),
    rules: WatchRulesSchema,
    preview_digest: z.string().regex(/^[a-f0-9]{64}$/),
    ambiguity_decisions: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            interpretation: z.enum(["semantic_preference", "confirmed_controls"]),
          })
          .strict(),
      )
      .max(100),
    model: StageConfigSchema.extend({
      provider: z.enum(["codex", "antigravity"]),
      model: StageConfigSchema.shape.model.min(1),
      timeout_secs: z.number().int().min(10).max(120),
    }).strict(),
    limits: WatchLimitsSchema,
  })
  .strict();
export const WatchSaveInput = z
  .object({
    request_id: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    repository: z.string().trim().min(1).max(500),
    configuration: WatchConfigurationSchema,
  })
  .strict();
export const WatchUpdateInput = WatchSaveInput.extend({
  watch_id: z.string().uuid(),
  expected_revision: z.number().int().positive(),
}).strict();
export const WatchSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(120),
    repository: RepositoryIdentitySchema,
    current_revision: z.number().int().positive(),
    archived: z.boolean(),
    created_at: timestamp,
    updated_at: timestamp,
    last_complete_scan_id: z.string().uuid().nullable(),
  })
  .strict();
export const WatchRevisionSchema = z
  .object({
    watch_id: z.string().uuid(),
    revision: z.number().int().positive(),
    created_at: timestamp,
    rules_digest: z.string().regex(/^[a-f0-9]{64}$/),
    configuration: WatchConfigurationSchema,
    explanation: z
      .array(
        z
          .object({
            start: z.number().int().nonnegative(),
            end: z.number().int().nonnegative(),
            text: z.string().max(8000),
            rule: z.string().max(300),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
export const IssueSnapshotSchema = z
  .object({
    id: identity,
    repository_id: identity,
    repository: z.string().max(200),
    number: z.number().int().positive().safe(),
    url: z.string().max(500),
    title: z.string().max(2000),
    body: text,
    state: z.enum(["open", "closed"]),
    pull_request: z.boolean(),
    labels: z.array(z.string().max(100)).max(200),
    assignees: z.array(z.string().max(100)).max(100),
    created_at: timestamp,
    updated_at: timestamp,
    comment_count: z.number().int().nonnegative(),
  })
  .strict();
export const SourceSchema = z
  .object({
    key: identity,
    kind: z.enum([
      "issue",
      "comment",
      "timeline",
      "pull_request",
      "policy",
      "tracker",
      "tracker_comment",
    ]),
    url: z.string().max(1000),
    requested_url: z.string().max(1000).optional(),
    issue_id: identity.nullable(),
    repository_id: identity,
    revision: z.string().max(256),
    fetched_at: timestamp,
    complete: z.boolean(),
    text,
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    actor: z.string().max(100).nullable(),
    association: z.string().max(100).nullable(),
    created_at: timestamp.nullable(),
    updated_at: timestamp.nullable(),
    references: z.array(IssueReferenceSchema).max(2000),
  })
  .strict();
export const ClaimStateSchema = z.enum([
  "candidate_for_claim_request",
  "possibly_claimed",
  "assigned",
  "competing_pr_detected",
  "maintainer_approval_needed",
  "eligibility_uncertain",
  "ineligible",
]);
export const ClaimEvidenceSchema = z
  .object({
    kind: z.enum([
      "assignment",
      "label",
      "claim_request",
      "maintainer_grant",
      "maintainer_wait",
      "claim_withdrawal",
      "open_pr",
      "closed_pr",
      "contribution_policy",
    ]),
    source_key: identity,
    actor: z.string().max(100).nullable(),
    excerpt: z.string().max(4000),
    authority: z.enum(["github_fact", "text_interpretation"]),
  })
  .strict();
export const SemanticResultSchema = z
  .object({
    issue_id: identity,
    relevance: z.enum(["match", "no_match", "uncertain"]),
    description: z.string().max(2000),
    why_it_matches: z.string().max(4000),
    technical_area: z.string().max(200),
    difficulty: z.enum(["small", "moderate", "large", "unknown"]),
    claim_assessment: ClaimStateSchema,
    blockers: z.array(z.string().max(1000)).max(20),
    uncertainty: z.array(z.string().max(1000)).max(20),
    evidence: z
      .array(
        z
          .object({
            source_key: identity,
            excerpt: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .max(30),
  })
  .strict();
export const ClassificationSchema = z.enum([
  "initial_discovery",
  "new_issue",
  "newly_matching",
  "reentered",
  "criteria_changed",
  "existing_match",
  "manual_review",
  "no_longer_eligible",
  "not_rechecked",
  "excluded",
]);
export const CandidateSchema = z
  .object({
    issue: IssueSnapshotSchema,
    checked_at: timestamp,
    eligible: z.boolean(),
    claim_state: ClaimStateSchema,
    reasons: z.array(z.string().max(1000)).max(100),
    uncertainty: z.array(z.string().max(1000)).max(100),
    evidence: z.array(ClaimEvidenceSchema).max(1000),
    source_keys: z.array(identity).max(2000),
    semantic_state: z.enum(["not_needed", "pending", "completed", "unavailable", "invalid"]),
    semantic: SemanticResultSchema.nullable(),
    classification: ClassificationSchema,
    dismissed_at: timestamp.nullable(),
  })
  .strict();
export const CoverageSchema = z
  .object({
    query: z.string().max(4000),
    search_total: z.number().int().nonnegative().nullable(),
    discovered: z.number().int().nonnegative(),
    checked: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
    context_checked: z.number().int().nonnegative(),
    semantic_checked: z.number().int().nonnegative(),
    requests: z.number().int().nonnegative(),
    retained_bytes: z.number().int().nonnegative(),
    search_complete: z.boolean(),
    exclusions_complete: z.boolean(),
    evidence_complete: z.boolean(),
    semantic_complete: z.boolean(),
    warnings: z.array(z.string().max(2000)).max(1000),
  })
  .strict();
export const ScanStatusSchema = z.enum([
  "running",
  "cancelling",
  "completed",
  "partial",
  "blocked",
  "failed",
  "cancelled",
  "interrupted",
]);
export const ScanSchema = z
  .object({
    id: z.string().uuid(),
    watch_id: z.string().uuid(),
    revision: z.number().int().positive(),
    parent_scan_id: z.string().uuid().nullable(),
    intent: z.enum(["scan", "retry", "continue", "recheck"]),
    status: ScanStatusSchema,
    phase: z.string().max(200),
    started_at: timestamp,
    ended_at: timestamp.nullable(),
    semantic_attempts: z.number().int().min(0).max(1),
    utility_run_id: z.string().uuid().nullable(),
    instruction_override: z.string().max(8000).nullable(),
    candidate_ids: z.array(identity).max(200).nullable(),
    coverage: CoverageSchema,
    error: z.string().max(4000).nullable(),
    context_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    summary: z.partialRecord(ClassificationSchema, z.number().int().nonnegative()),
  })
  .strict();
export const ScanInput = z
  .object({
    watch_id: z.string().uuid(),
    expected_revision: z.number().int().positive(),
    request_id: z.string().uuid(),
    instruction_override: z.string().min(1).max(8000).optional(),
    candidate_ids: z.array(identity).min(1).max(200).optional(),
  })
  .strict();
export type Watch = z.infer<typeof WatchSchema>;
export type WatchRules = z.infer<typeof WatchRulesSchema>;
export type WatchRevision = z.infer<typeof WatchRevisionSchema>;
export type WatchConfiguration = z.infer<typeof WatchConfigurationSchema>;
export type WatchLimits = z.infer<typeof WatchLimitsSchema>;
export type RepositoryIdentity = z.infer<typeof RepositoryIdentitySchema>;
export type IssueSnapshot = z.infer<typeof IssueSnapshotSchema>;
export type IssueReference = z.infer<typeof IssueReferenceSchema>;
export type WatchSource = z.infer<typeof SourceSchema>;
export type WatchCandidate = z.infer<typeof CandidateSchema>;
export type ClaimEvidence = z.infer<typeof ClaimEvidenceSchema>;
export type WatchScan = z.infer<typeof ScanSchema>;
export type CandidateSummary = Omit<WatchCandidate, "issue" | "evidence" | "source_keys"> & {
  issue: Omit<IssueSnapshot, "body">;
  body_bytes: number;
  evidence_count: number;
  source_count: number;
};
