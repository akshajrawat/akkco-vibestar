import { z } from "zod";
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
  effort: z.string(),
  timeout_secs: z.number().int().min(10).max(86400),
});
export const SettingsSchema = z
  .object({
    concurrency: z.number().int().min(1).max(4),
    antigravity: StageConfigSchema.extend({
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
    }),
    codex_plan: StageConfigSchema.extend({
      effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]),
    }),
    codex_implementation: StageConfigSchema.extend({
      effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]),
    }),
  })
  .superRefine((settings, context) => {
    const error = modelEffortError(
      "antigravity",
      settings.antigravity.model,
      settings.antigravity.effort,
    );
    if (error)
      context.addIssue({
        code: "custom",
        path: ["antigravity", "effort"],
        message: error,
      });
  });
export type Settings = z.infer<typeof SettingsSchema>;
export type StageConfig = z.infer<typeof StageConfigSchema>;
export const defaultSettings: Settings = {
  concurrency: 2,
  antigravity: { model: "", effort: "high", timeout_secs: 1800 },
  codex_plan: { model: "", effort: "high", timeout_secs: 1800 },
  codex_implementation: { model: "", effort: "high", timeout_secs: 3600 },
};
export const taskStatuses = [
  "queued",
  "preparing",
  "planning_antigravity",
  "planning_codex",
  "implementing",
  "validating",
  "ready_for_review",
  "failed",
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
}
export interface Task {
  id: string;
  repo_id: string;
  issue_number: number;
  issue_url: string;
  claimed_scope: string;
  notes: string;
  issue: Record<string, unknown>;
  execution_settings?: Settings;
  branch_name: string;
  base_branch: string;
  base_commit_sha: string;
  worktree_path: string;
  created_at: string;
  updated_at: string;
  status: TaskStatus;
  stage: number;
  error: string | null;
}
export interface CoreEvent {
  event: string;
  task_id?: string;
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
    target > 4 ||
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
    u.protocol !== "https:" ||
    u.hostname !== "github.com" ||
    u.username ||
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
