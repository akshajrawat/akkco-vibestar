import { z } from "zod";
import type {
  VerificationEnvironment,
  BrowserEnvironmentReport,
} from "./execution/browser/contracts";
export interface ActivityBlocker {
  id: string;
  kind:
    | "task"
    | "terminal"
    | "pr_watch"
    | "github_sync"
    | "repository_scan"
    | "repository"
    | "issue_watch"
    | "maintenance";
  label: string;
  task_id?: string;
  stoppable: boolean;
}
export class AdeError extends Error {
  constructor(
    public readonly kind: string,
    message: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AdeError";
  }
}
export const modelEffortError = (
  provider: string,
  model: string,
  effort: string,
) => {
  const suffix =
    provider === "antigravity"
      ? model.match(/-(low|medium|high|xhigh|max)$/)?.[1]
      : null;
  return suffix && suffix !== effort
    ? `Antigravity model ${model} encodes ${suffix} effort and conflicts with ${effort}. Select a matching model or effort.`
    : null;
};
export const StageConfigSchema = z.object({
  model: z
    .string()
    .max(200)
    .regex(/^[^\x00-\x1f]*$/),
  effort: z.string().min(1).max(30),
  timeout_secs: z.number().int().min(10).max(86400),
});
export const FollowupConfigSchema = z.object({
  provider: z.enum(["codex", "antigravity"]),
  config: StageConfigSchema,
});
export const PipelineStageSettingsSchema = z
  .object({
    1: StageConfigSchema.optional(),
    2: StageConfigSchema.optional(),
    3: StageConfigSchema.optional(),
    5: StageConfigSchema.optional(),
  })
  .strict();
export const SettingsSchema = z
  .object({
    concurrency: z.number().int().min(1).max(4),
    antigravity: StageConfigSchema,
    antigravity_review: StageConfigSchema.optional(),
    codex_plan: StageConfigSchema,
    codex_implementation: StageConfigSchema,
    utility_ai: StageConfigSchema.extend({
      provider: z.enum(["antigravity", "codex"]),
    }).default({
      provider: "antigravity",
      model: "",
      effort: "medium",
      timeout_secs: 120,
    }),
    default_editor: z
      .enum(["", "code", "cursor", "windsurf", "codium"])
      .default(""),
    review_ai: StageConfigSchema.extend({
      provider: z.enum(["antigravity", "codex"]),
    })
      .nullable()
      .default(null),
    repository_discovery: z
      .object({
        roots: z.array(z.string().min(1).max(2000)).max(30),
        max_depth: z.number().int().min(1).max(8),
        scan_home: z.boolean(),
      })
      .default({
        roots: ["~/projects", "~/repos", "~/src", "~/code", "~/workspace"],
        max_depth: 4,
        scan_home: true,
      }),
  })
  .superRefine((settings, context) => {
    for (const key of ["antigravity", "antigravity_review"] as const) {
      const config = settings[key];
      if (!config) continue;
      const error = modelEffortError(
        "antigravity",
        config.model,
        config.effort,
      );
      if (error)
        context.addIssue({
          code: "custom",
          path: [key, "effort"],
          message: error,
        });
    }
    if (settings.review_ai) {
      const reviewError = modelEffortError(
        settings.review_ai.provider,
        settings.review_ai.model,
        settings.review_ai.effort,
      );
      if (reviewError)
        context.addIssue({
          code: "custom",
          path: ["review_ai", "effort"],
          message: reviewError,
        });
    }
    if (settings.utility_ai.provider === "antigravity") {
      const utilityError = modelEffortError(
        "antigravity",
        settings.utility_ai.model,
        settings.utility_ai.effort,
      );
      if (utilityError)
        context.addIssue({
          code: "custom",
          path: ["utility_ai", "effort"],
          message: utilityError,
        });
    }
  });
export type Settings = z.infer<typeof SettingsSchema>;
export type StageConfig = z.infer<typeof StageConfigSchema>;
export const defaultSettings: Settings = {
  concurrency: 2,
  default_editor: "",
  review_ai: null,
  antigravity: { model: "", effort: "high", timeout_secs: 1800 },
  codex_plan: { model: "", effort: "high", timeout_secs: 1800 },
  codex_implementation: { model: "", effort: "high", timeout_secs: 3600 },
  utility_ai: {
    provider: "antigravity",
    model: "",
    effort: "medium",
    timeout_secs: 120,
  },
  repository_discovery: {
    roots: ["~/projects", "~/repos", "~/src", "~/code", "~/workspace"],
    max_depth: 4,
    scan_home: true,
  },
};
export const taskStatuses = [
  "not_started",
  "preserved",
  "queued",
  "preparing",
  "planning_antigravity",
  "planning_codex",
  "implementing",
  "validating",
  "reviewing_antigravity",
  "awaiting_approval",
  "ready_for_review",
  "reviewed_with_gaps",
  "failed",
  "verification_blocked",
  "cancelled",
  "interrupted",
  "completed",
] as const;
export type TaskStatus = (typeof taskStatuses)[number];
export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
}
export interface Repository {
  id: string;
  owner: string;
  name: string;
  upstream_url: string;
  origin_url: string | null;
  base_branch: string;
  path: string;
  last_fetched: string | null;
  created_at: string;
  source?: "managed" | "imported";
  connected?: boolean;
  clone_status?: "cloning" | "ready";
  selection?: "explicit";
  environment?: "wsl" | "windows";
  distro?: string;
  windows_path?: string;
  upstream_remote?: string;
  origin_remote?: string | null;
}
export interface Task {
  disposal_authorization?: {
    fingerprint: string;
    acknowledge_unpublished: boolean;
    authorized_at: string;
  };
  workflow_version?: 1;
  workflow_start?: {
    request_id: string;
    digest: string;
    started_at: string;
    message_ids: string[];
    summary: string;
  };
  verification_environment?: VerificationEnvironment;
  browser_environment_report?: BrowserEnvironmentReport;
  runtime?: {
    python: string | null;
    dependencies: string[];
    warnings: string[];
  };
  preparation_timing?: { started_at: string; ended_at: string | null };
  verification_policy?: "repository" | "extended_browser";
  id: string;
  repo_id: string;
  issue_number: number;
  issue_url: string;
  claimed_scope: string;
  scope_mode?: "whole_issue" | "partial";
  followup_config?: { provider: "codex" | "antigravity"; config: StageConfig };
  notes: string;
  issue: Record<string, unknown>;
  execution_settings?: Settings;
  stage_settings?: z.infer<typeof PipelineStageSettingsSchema>;
  branch_name: string;
  branch_owned?: boolean;
  workspace_checkpoint?: {
    state: "fetching" | "creating" | "ready" | "removing" | "removed";
    git_common_dir: string;
    started_at: string;
    cleanup_head?: string;
    operation?: {
      kind: string;
      pid: number;
      identity: string;
      started_at: string;
    } | null;
  };
  base_branch: string;
  base_commit_sha: string;
  worktree_path: string;
  created_at: string;
  updated_at: string;
  status: TaskStatus;
  stage: number;
  error: string | null;
  archived?: boolean;
  continuation?: "pipeline" | "planning" | "implementation";
  final_review_hash?: string;
  final_review_verdict?:
    "verified" | "code_approved_incomplete" | "changes_requested" | "blocked";
  review_gap_acknowledgment?: {
    fingerprint: string;
    evidence_hash: string;
    acknowledged_at: string;
  };
  approval_gate?:
    "antigravity_plan" | "codex_plan" | "implementation" | "final_review";
}
// Shared physical assignment; repair workflows do not become issue tasks.
export type WorkspaceAssignment = Pick<
  Task,
  "id" | "repo_id" | "branch_name" | "worktree_path" | "base_commit_sha"
>;
export interface CoreEvent {
  event: string;
  task_id?: string;
  repair_id?: string;
  watch_id?: string;
  scan_id?: string;
  run_id?: string;
  kind?: string;
  data?: unknown;
  session_id?: string;
  text?: string;
  stream?: string;
}
export interface NormalizedEvent {
  kind:
    | "run.started"
    | "message"
    | "analysis.status"
    | "file.read"
    | "file.changed"
    | "command.started"
    | "command.output"
    | "command.finished"
    | "test.result"
    | "run.completed"
    | "run.failed"
    | "run.cancelled";
  data: unknown;
}
export const stageStatuses: TaskStatus[] = [
  "preparing",
  "planning_antigravity",
  "planning_codex",
  "implementing",
  "validating",
  "reviewing_antigravity",
  "ready_for_review",
];
export const stageStatus = (stage: number) => {
  const status = stageStatuses[stage];
  if (!status) throw new AdeError("invalid_state", "Invalid pipeline stage");
  return status;
};
export const retryTarget = (task: Task, target: number, active: boolean) => {
  if (
    active ||
    target < 0 ||
    target > 5 ||
    target > task.stage ||
    (target === 0 && !!task.worktree_path)
  )
    throw new AdeError(
      "invalid_state",
      "Cannot retry an active task, future stage, or recreate an existing worktree.",
    );
  return target;
};
export const parseIssue = (input: string): IssueRef => {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new AdeError(
      "invalid_input",
      "Use https://github.com/owner/repository/issues/number",
    );
  }
  const m = u.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)\/?$/);
  if (
    u.protocol !== "https:" ||
    u.hostname !== "github.com" ||
    u.username ||
    u.password ||
    u.port ||
    !m ||
    [".", ".."].includes(m[1]) ||
    [".", ".."].includes(m[2])
  )
    throw new AdeError(
      "invalid_input",
      "Use https://github.com/owner/repository/issues/number",
    );
  const number = Number(m[3]);
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new AdeError("invalid_input", "Invalid GitHub issue number");
  return {
    owner: m[1],
    repo: m[2],
    number,
    url: `https://github.com/${m[1]}/${m[2]}/issues/${number}`,
  };
};
export const slug = (scope: string) =>
  scope
    .trim()
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(spec|test)\.(tsx?|jsx?)$/, "")
    .slice(0, 100)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "scope";
export const branchName = (number: number, scope: string, suffix = 0) =>
  `akkco/${number}-${slug(scope)}${suffix ? `-${suffix}` : ""}`;
export const remoteIdentity = (input: string) => {
  const u = new URL(
    input.startsWith("git@github.com:")
      ? `https://github.com/${input.slice(15)}`
      : input,
  );
  const m = u.pathname.match(/^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (
    !["https:", "ssh:"].includes(u.protocol) ||
    u.hostname !== "github.com" ||
    (u.username && !(u.protocol === "ssh:" && u.username === "git")) ||
    u.password ||
    u.port ||
    u.search ||
    u.hash ||
    !m ||
    m.slice(1).some((s) => s === "." || s === "..")
  )
    throw new AdeError(
      "invalid_input",
      "Use a GitHub HTTPS URL or git@github.com:owner/repository.git",
    );
  return { owner: m[1], name: m[2] };
};
export const now = () => new Date().toISOString();
export const repositoryMatchesIssue = (
  repository: Repository,
  reference: IssueRef,
) =>
  `${repository.owner}/${repository.name}`.toLowerCase() ===
  `${reference.owner}/${reference.repo}`.toLowerCase();
