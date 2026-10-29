/** Retains legacy Git journals for restart safety and storage protection; no commit or push execution. */
import { AdeError, now } from "../domain";
import type { Database } from "./database";
import { z } from "zod";

import { planSchemas } from "../execution/providers/contracts";

const GitPresetSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    commit_hooks: z.enum(["normal", "skip"]),
    push: z.enum(["none", "normal", "skip"]),
    remote: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
    branch: z.string().min(1).max(240),
  })
  .strict();

const FinalizationSchema = z
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

type Finalization = z.infer<typeof FinalizationSchema>;

export class HistoricalFinalizations {
  constructor(private readonly db: Database) {}

  private validate = (taskId: string, source: unknown) => {
    const record = FinalizationSchema.parse(source);
    if (record.task_id !== taskId)
      throw new AdeError(
        "ownership",
        "Saved Git operation task ownership does not match its persisted owner.",
      );
    return record;
  };

  list = (taskId: string) =>
    this.db.records.list(
      "git_finalizations",
      this.db.all<{ id: string; data: string }>(
        "SELECT id,data FROM git_finalizations WHERE task_id=? ORDER BY created_at DESC,rowid DESC",
        taskId,
      ),
      (source) => this.validate(taskId, source),
      "id",
    );

  save = (record: Finalization) => {
    record.updated_at = now();
    const value = FinalizationSchema.parse(record);

    const result = this.db.run(
      "INSERT INTO git_finalizations VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data,updated_at=excluded.updated_at WHERE git_finalizations.task_id=excluded.task_id",
      value.id,
      value.task_id,
      value.status,
      JSON.stringify(value),
      value.created_at,
      value.updated_at,
    );

    if (result.changes !== 1)
      throw new AdeError(
        "ownership",
        "This Git request identity already belongs to a different task.",
      );
  };
}

export const HistoricalRepairPublicationSchema = z
  .object({
    pid: z.number().int().positive().nullable().optional(),
    process_identity: z.string().nullable().optional(),
    id: z.string().uuid(),
    repair_id: z.string().uuid(),
    pr_url: z.string().url(),
    destination: z
      .object({
        repository: z.string(),
        repository_id: z.string(),
        url: z.string(),
        branch: z.string(),
      })
      .strict(),
    expected_remote_head: z.string(),
    local_head: z.string(),
    fingerprint: z.string(),
    upstream_base: z.object({ branch: z.string(), sha: z.string() }).strict(),
    dirty: z.boolean(),
    changes: z
      .object({
        files: z.number().int(),
        additions: z.number().int(),
        deletions: z.number().int(),
      })
      .strict(),
    validation: z
      .object({
        observed_passed: z.number().int(),
        observed_failed: z.number().int(),
        reported_blocked: z.number().int(),
      })
      .strict(),
    commits: z.array(
      z.object({ sha: z.string(), parents: z.string(), subject: z.string() }).strict(),
    ),
    confirmation: z
      .object({
        viewer: z.string(),
        approved_at: z.string(),
        reviewed_hash: z.string(),
        confirmed_at: z.string().nullable(),
      })
      .strict(),
    outcome: z.enum([
      "prepared",
      "pushing",
      "published",
      "not_published",
      "stale_remote_head",
      "uncertain",
    ]),
    error: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    published_at: z.string().nullable(),
  })
  .strict();
