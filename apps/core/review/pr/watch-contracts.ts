import { z } from "zod";

import { FollowupConfigSchema } from "../../domain";

export const PRWatchStartSchema = z
  .object({
    request_id: z.string().uuid(),
    trigger: z.enum(["open", "recheck"]),
    configuration: FollowupConfigSchema.optional(),
  })
  .strict();

export const PRWatchItemSchema = z.object({
  url: z.string(),
  title: z.string(),
  lifecycle: z.enum(["OPEN", "CLOSED", "MERGED", "UNKNOWN"]),
  status: z.enum(["checking", "review", "waiting", "clear", "unknown", "closed"]),
  reason: z.string(),
  checked_at: z.string().nullable(),
  fingerprint: z.string().nullable(),
  head_sha: z.string().optional(),
  source_urls: z.array(z.string()),
});

export const PRWatchStateSchema = z.object({
  request_id: z.string().uuid(),
  status: z.enum(["running", "cancelling", "completed", "cancelled", "failed", "interrupted"]),
  phase: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  error: z.string().nullable(),
  items: z.array(PRWatchItemSchema),
});

export type PRWatchState = z.infer<typeof PRWatchStateSchema>;
export type PRWatchItem = z.infer<typeof PRWatchItemSchema>;

export const PRWatchResultSchema = z
  .object({
    results: z.array(
      z
        .object({
          key: z.string(),
          needs_review: z.boolean(),
          reason: z.string().min(1).max(400),
          source_ids: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .strict();
