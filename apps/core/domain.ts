import { z } from "zod";

export interface ActivityBlocker {
  id: string;
  kind: "viber" | "terminal" | "github_sync" | "repository_scan" | "repository" | "maintenance";
  label: string;
  session_id?: string;
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

export const modelEffortError = (provider: string, model: string, effort: string) => {
  const suffix =
    provider === "antigravity" ? model.match(/-(low|medium|high|xhigh|max)$/)?.[1] : null;

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

export const PipelineStageConfigSchema = StageConfigSchema.extend({
  provider: z.enum(["codex", "antigravity"]).optional(),
});

// Persisted settings keys retain compatibility with existing data.
const pipelineStages = [
  { key: "antigravity", provider: "antigravity" },
  { key: "codex_plan", provider: "codex" },
  { key: "codex_implementation", provider: "codex" },
  { key: "antigravity_review", provider: "antigravity" },
] as const;

export const SettingsSchema = z
  .object({
    concurrency: z.number().int().min(1).max(4),
    antigravity: PipelineStageConfigSchema,
    antigravity_review: PipelineStageConfigSchema.optional(),
    codex_plan: PipelineStageConfigSchema,
    codex_implementation: PipelineStageConfigSchema,
    default_editor: z.enum(["", "code", "cursor", "windsurf", "codium"]).default(""),
    notification_preference: z.enum(["necessary", "all"]).default("necessary"),
    repository_discovery: z
      .object({
        roots: z.array(z.string().min(1).max(2000)).max(30),
        max_depth: z.number().int().min(1).max(8),
        scan_home: z.boolean(),
      })
      .default({
        roots: ["~/projects", "~/repos", "~/src", "~/code", "~/workspace"],
        max_depth: 4,
        scan_home: false,
      }),
  })
  .superRefine((settings, context) => {
    for (const { key, provider } of pipelineStages) {
      const config = settings[key];
      if (!config) {
        continue;
      }

      const error = modelEffortError(config.provider || provider, config.model, config.effort);
      if (error) {
        context.addIssue({
          code: "custom",
          path: [key, "effort"],
          message: error,
        });
      }
    }
  });

export type Settings = z.infer<typeof SettingsSchema>;
export type StageConfig = z.infer<typeof StageConfigSchema>;

export const defaultSettings: Settings = {
  concurrency: 2,
  default_editor: "",
  notification_preference: "necessary",
  antigravity: { model: "", effort: "high", timeout_secs: 1800 },
  codex_plan: { model: "", effort: "high", timeout_secs: 1800 },
  codex_implementation: { model: "", effort: "high", timeout_secs: 3600 },
  repository_discovery: {
    roots: ["~/projects", "~/repos", "~/src", "~/code", "~/workspace"],
    max_depth: 4,
    scan_home: false,
  },
};

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

export interface WorkspaceAssignment {
  id: string;
  repo_id: string | null;
  branch_name: string;
  base_branch?: string;
  base_commit_sha: string;
  worktree_path: string;
  branch_owned?: boolean;
  workspace_mode?: "source";
  workspace_kind?: "managed";
  managed_removal_identity?: string;
  kind?: string;
  goal?: string;
  issue_number?: number | null;
  claimed_scope?: string;
  scope_mode?: string;
  workspace_checkpoint?: {
    state: "fetching" | "creating" | "ready" | "removing" | "removed";
    git_common_dir: string;
    started_at?: string;
    cleanup_head?: string;
    operation?: {
      kind: string;
      pid: number;
      identity: string;
      started_at: string;
    } | null;
  };
}

export interface CoreEvent {
  event: string;
  session_id?: string;
  run_id?: string;
  kind?: string;
  data?: unknown;
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

export const parseIssue = (input: string | null): IssueRef => {
  let u: URL;
  try {
    if (!input) {
      throw new Error("Issue URL is required.");
    }

    u = new URL(input.trim());
  } catch {
    throw new AdeError("invalid_input", "Use https://github.com/owner/repository/issues/number");
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
  ) {
    throw new AdeError("invalid_input", "Use https://github.com/owner/repository/issues/number");
  }

  const number = Number(m[3]);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new AdeError("invalid_input", "Invalid GitHub issue number");
  }

  return {
    owner: m[1],
    repo: m[2],
    number,
    url: `https://github.com/${m[1]}/${m[2]}/issues/${number}`,
  };
};

const slug = (scope: string) =>
  scope
    .trim()
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(spec|test)\.(tsx?|jsx?)$/, "")
    .slice(0, 100)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "scope";

export const branchName = (identifier: number | string, scope: string, suffix = 0) => {
  if (!/^[a-zA-Z0-9-]+$/.test(String(identifier))) {
    throw new AdeError("isolation", "Invalid task branch identifier.");
  }

  return `akkco/${identifier}-${slug(scope)}${suffix ? `-${suffix}` : ""}`;
};

export const remoteIdentity = (input: string) => {
  const u = new URL(
    input.startsWith("git@github.com:") ? `https://github.com/${input.slice(15)}` : input,
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
  ) {
    throw new AdeError(
      "invalid_input",
      "Use a GitHub HTTPS URL or git@github.com:owner/repository.git",
    );
  }

  return { owner: m[1], name: m[2] };
};

export const now = () => new Date().toISOString();
