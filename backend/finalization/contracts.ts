import { z } from "zod";

import { planSchemas } from "../execution/providers/contracts";

export const GitPresetSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    commit_hooks: z.enum(["normal", "skip"]),
    push: z.enum(["none", "normal", "skip"]),
    remote: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
    branch: z.string().min(1).max(240),
  })
  .strict();

export type GitPreset = z.infer<typeof GitPresetSchema>;

export const FinalizationSchema = z
  .object({
    id: z.string().uuid(),
    task_id: z.string().uuid(),
    request_digest: z.string(),
    status: z.enum([
      "preparing",
      "draft",
      "reviewing",
      "reviewed",
      "approved",
      "committing",
      "committed",
      "prepared",
      "pushing",
      "published",
      "not_published",
      "uncertain",
      "failed",
      "interrupted",
    ]),
    source_hash: z.string(),
    source_content_hash: z.string(),
    source_index: z.string(),
    projected_index: z.string(),
    hook_configuration: z.string().max(4096).nullable().default(null),
    parent: z.string(),
    base: z.string(),
    paths: z.array(z.string()),
    staged_paths: z.array(z.string()),
    preview_path: z.string(),
    preview_branch: z.string(),
    tree: z.string().nullable(),
    review: planSchemas[5].nullable(),
    review_source: z.enum(["pipeline", "selection"]).nullable(),
    review_run_id: z.string().uuid().nullable().default(null),
    verification_gap: z.string().nullable().default(null),
    approved_at: z.string().nullable(),
    message: z.string().nullable(),
    preset: GitPresetSchema,
    head: z.string().nullable(),
    committed_source_hash: z.string().nullable(),
    destination: z
      .object({
        remote: z.string(),
        url: z.string(),
        repository: z.string(),
        repository_id: z.string(),
        upstream: z.string(),
        branch: z.string(),
        viewer: z.string(),
        expected_remote: z.string(),
      })
      .strict()
      .nullable(),
    error: z.string().nullable(),
    pid: z.number().int().positive().nullable(),
    process_identity: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();

export type Finalization = z.infer<typeof FinalizationSchema>;

export const FinalizationViewSchema = FinalizationSchema.omit({
  source_index: true,
  projected_index: true,
  source_content_hash: true,
  request_digest: true,
  pid: true,
  process_identity: true,
}).strip();

export type FinalizationView = z.infer<typeof FinalizationViewSchema>;

export const SelectedFilesInput = z
  .object({
    id: z.string().uuid(),
    request_id: z.string().uuid(),
    expected_hash: z.string(),
    paths: z.array(z.string().min(1).max(2000)).max(500),
    replace_selected_staged: z.boolean(),
    preset: GitPresetSchema.optional(),
  })
  .strict();
