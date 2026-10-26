import { z } from "zod";

import { StageConfigSchema, type Settings } from "../../domain";
import { PullRequestStateSchema, type PullRequestState } from "../../scheduled/contracts";

export const ReviewAnalysisSchema = z
  .object({
    summary: z.string().min(1),
    observations: z.array(
      z
        .object({
          existingActionId: z.string().nullable(),
          sourceId: z.string().min(1),
          originalText: z.string().min(1),
          classification: z.enum([
            "required_change",
            "suggested_change",
            "question",
            "positive_feedback",
            "informational",
          ]),
          priority: z.enum(["high", "medium", "low"]),
          affectedFiles: z.array(z.string()),
          recommendedAction: z.string(),
          authorReplyIds: z.array(z.string()),
          reviewerAcknowledgmentIds: z.array(z.string()),
          responseState: z.enum([
            "no_author_reply",
            "author_replied",
            "partially_answered",
            "answered",
            "needs_manual_judgment",
          ]),
          evidenceIds: z.array(z.string()),
          commitShas: z.array(z.string()),
          evidence: z.string(),
          confidence: z.enum(["high", "medium", "low"]),
        })
        .strict(),
    ),
    coverage: z.array(
      z
        .object({
          sourceId: z.string(),
          segmentIds: z.array(z.string()),
          disposition: z.enum(["analyzed", "informational", "deferred"]),
          reason: z.string(),
        })
        .strict(),
    ),
    warnings: z.array(z.string()),
  })
  .strict();

export type ReviewObservation = z.infer<typeof ReviewAnalysisSchema>["observations"][number];

export const ReviewActionSchema = ReviewAnalysisSchema.shape.observations.element
  .extend({
    id: z.string().uuid(),
    reviewer: z.string(),
    sourceUrl: z.string().nullable(),
    sourceThreadId: z.string().nullable(),
    threadResolved: z.boolean().nullable(),
    outdated: z.boolean().nullable(),
    codeStatus: z.literal("unverified"),
  })
  .strict();

export type ReviewAction = z.infer<typeof ReviewActionSchema>;

export interface PRAnalysisSession {
  id: string;
  job_id: string;
  status: "running" | "completed" | "partial" | "failed" | "cancelled" | "interrupted";
  started_at: string;
  ended_at: string | null;
  phase: string;
  configuration: Settings["utility_ai"];
  snapshot?: PullRequestState;
  method?: "deterministic" | "utility_ai" | "reused";
  changes?: string[];
  error?: string;
  report?: {
    summary: string;
    actions: ReviewAction[];
    coverage: z.infer<typeof ReviewAnalysisSchema>["coverage"];
    complete: boolean;
    warnings: string[];
  };
}

export const PRAnalysisSessionSchema = z
  .object({
    id: z.string(),
    job_id: z.string(),
    status: z.enum(["running", "completed", "partial", "failed", "cancelled", "interrupted"]),
    started_at: z.string().optional(),
    ended_at: z.string().nullable().optional(),
    phase: z.string().optional(),
    configuration: StageConfigSchema.extend({
      provider: z.enum(["codex", "antigravity"]),
    }).optional(),
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
      .optional(),
  })
  .loose()
  .transform((value) => value as PRAnalysisSession);
