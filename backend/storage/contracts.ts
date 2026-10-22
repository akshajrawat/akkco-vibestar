import { z } from "zod";
import {
  SettingsSchema,
  FollowupConfigSchema,
  taskStatuses,
  type Task,
  type Repository,
} from "../domain";

// Historical objects may be sparse. Validate fields that exist without inventing
// missing workflow/ownership values or rewriting their original source bytes.
export const TaskRecordSchema = z
  .object({
    id: z.string(),
    repo_id: z.string().optional(),
    issue_number: z.number().int().positive().optional(),
    issue_url: z.string().optional(),
    claimed_scope: z.string().optional(),
    notes: z.string().optional(),
    scope_mode: z.enum(["whole_issue", "partial"]).optional(),
    branch_name: z.string().optional(),
    branch_owned: z.boolean().optional(),
    base_branch: z.string().optional(),
    base_commit_sha: z.string().optional(),
    worktree_path: z.string().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    status: z.enum(taskStatuses).optional(),
    stage: z.number().int().min(0).max(6).optional(),
    error: z.string().nullable().optional(),
    archived: z.boolean().optional(),
    issue: z
      .object({ title: z.string().optional(), body: z.string().optional() })
      .loose()
      .optional(),
    runtime: z
      .object({
        python: z.string().nullable(),
        dependencies: z.array(z.string()),
        warnings: z.array(z.string()),
      })
      .optional(),
    execution_settings: SettingsSchema.optional(),
    followup_config: FollowupConfigSchema.optional(),
    continuation: z.enum(["pipeline", "planning", "implementation"]).optional(),
    final_review_hash: z.string().optional(),
    approval_gate: z
      .enum([
        "antigravity_plan",
        "codex_plan",
        "implementation",
        "final_review",
      ])
      .optional(),
    workspace_checkpoint: z
      .object({
        state: z.enum(["fetching", "creating", "ready", "removing", "removed"]),
        git_common_dir: z.string(),
        started_at: z.string(),
        cleanup_head: z.string().optional(),
        operation: z
          .object({
            kind: z.string(),
            pid: z.number().int().min(2),
            identity: z.string(),
            started_at: z.string(),
          })
          .nullable()
          .optional(),
      })
      .optional(),
  })
  .loose()
  .transform((value) => value as Task);

export const RepositoryRecordSchema = z
  .object({
    id: z.string(),
    owner: z.string().optional(),
    name: z.string().optional(),
    upstream_url: z.string().optional(),
    origin_url: z.string().nullable().optional(),
    base_branch: z.string().optional(),
    path: z.string().optional(),
    last_fetched: z.string().nullable().optional(),
    created_at: z.string().optional(),
    source: z.enum(["managed", "imported"]).optional(),
    connected: z.boolean().optional(),
    clone_status: z.enum(["cloning", "ready"]).optional(),
    selection: z.literal("explicit").optional(),
    environment: z.enum(["wsl", "windows"]).optional(),
    distro: z.string().optional(),
    windows_path: z.string().optional(),
    upstream_remote: z.string().optional(),
    origin_remote: z.string().nullable().optional(),
  })
  .loose()
  .transform((value) => value as Repository);
