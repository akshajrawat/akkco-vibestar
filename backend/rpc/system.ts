import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { AdeError, SettingsSchema } from "../domain";
import { capture, checked } from "../execution/runtime/process";
import { Usage } from "../execution/output/usage";
import { GitHubClient } from "../github/client";
import { reviewActionState } from "../review/pr/inbox";
import { Editors } from "../workspace/editors";
import { taskRoot } from "../workspace/paths";
import type { RpcServices } from "./services";
import { idInput } from "./validation";

export const systemMethods = [
  "editors.list",
  "editors.open",
  "usage.info",
  "snapshot",
  "persistence.diagnostics",
  "usage.list",
  "settings.save",
  "providers.detect",
  "auth.connect",
  "auth.input",
  "auth.close",
  "open.directory",
] as const;

/** Validates and dispatches system requests through their existing domain services. */
export const callSystem = async (
  services: Pick<RpcServices, "engine" | "repairs" | "scheduler" | "prBatches" | "github" | "auth">,
  method: string,
  input: unknown,
) => {
  const e = services.engine;
  switch (method) {
    case "editors.list":
      return new Editors(e).list();

    case "editors.open": {
      const p = idInput
        .extend({
          kind: z.enum(["task", "repository", "repair"]),
          editor: z.enum(["code", "cursor", "windsurf", "codium"]),
        })
        .strict()
        .parse(input);

      return new Editors(e, services.repairs.openPath).open(p.id, p.kind, p.editor);
    }

    case "usage.info":
      return {
        root: e.root,
        capabilities: { manual_issue_watch: true, issue_watch_contract: 1 },
        database: join(e.root, "state", "vibestar.sqlite"),
        schema: e.db.all("SELECT max(version) version FROM schema_migrations")[0],
        runs: e.db.all("SELECT count(*) count FROM ai_usage")[0],
      };

    case "snapshot": {
      const snapshot = {
        repositories: e.db.repositories(),
        tasks: e.db.tasks(),
        settings: e.db.displaySettings(),
        root: e.root,
        capabilities: { manual_issue_watch: true, issue_watch_contract: 1 },
        execution_environment: {
          distro: process.env.WSL_DISTRO_NAME || "Linux",
        },
        repository_index: e.repositoryIndex.snapshot(),
        active_tasks: e.db
          .tasks()
          .filter((t) => e.isActive(t.id))
          .map((t) => t.id),
        scheduled: services.scheduler.jobs(),
        pr_batches: services.prBatches.list(),
        repairs: services.repairs.store.list(),
        pr_reports: services.scheduler.jobs().map((job) => {
          const history = services.scheduler.analysis.history(job.id);
          const analysis = history.find((record) => record.report);
          const latest = history[0];

          const actions =
            analysis?.report?.actions.filter(
              (action) =>
                ["required_change", "suggested_change", "question"].includes(
                  action.classification,
                ) && action.responseState !== "answered",
            ) || [];

          return {
            job_id: job.id,
            action_state:
              latest &&
              !latest.report &&
              ["partial", "failed", "cancelled", "interrupted"].includes(latest.status)
                ? "Analysis incomplete"
                : analysis &&
                    latest?.snapshot &&
                    !services.scheduler.analysis.canReuse(job.id, latest.snapshot)
                  ? "Analysis stale"
                  : reviewActionState(
                      analysis,
                      services.github
                        .prs()
                        .find((pr) => pr.url.toLowerCase() === job.url.toLowerCase()),
                    ),
            analyzed_head: analysis?.snapshot?.headRefOid || null,
            analyzed_at: analysis?.ended_at || null,
            outstanding: actions.length,
            unanswered_questions: actions.filter((action) => action.classification === "question")
              .length,
          };
        }),
        attention: services.scheduler.attention(),
        github: services.github.snapshot(),
      };

      const persistence = e.db.records.diagnostics();
      return {
        ...snapshot,
        persistence,
        ...(persistence.length
          ? {
              warning: `${persistence.length} saved record(s) need recovery. Original data is preserved; open Settings for persistence diagnostics.`,
            }
          : {}),
      };
    }

    case "persistence.diagnostics":
      return e.db.records.diagnostics();

    case "usage.list": {
      const p = z
        .object({
          task_id: z.string().uuid().optional(),
          job_id: z.string().uuid().optional(),
          watch_id: z.string().uuid().optional(),
          scan_id: z.string().uuid().optional(),
          days: z.number().int().min(1).max(3650).optional(),
        })
        .parse(input);

      return new Usage(e.db)
        .list(p.task_id, p.days)
        .filter(
          (r) =>
            (!p.job_id || r.job_id === p.job_id) &&
            (!p.watch_id || r.watch_id === p.watch_id) &&
            (!p.scan_id || r.scan_id === p.scan_id),
        );
    }

    case "settings.save":
      e.db.saveSettings(SettingsSchema.parse(input));
      e.start();
      e.changed();
      return e.db.settings();

    case "providers.detect": {
      const [agents, github] = await Promise.all([
        e.providers(),
        new GitHubClient(e.root).detect(),
      ]);

      return [
        ...agents,
        {
          provider: "github",
          installed: github.installed,
          version: github.version,
          connected: github.connected,
          accountLabel: github.username ? `@${github.username}` : undefined,
          models: [],
          efforts: [],
          capabilities: github.installed ? ["repository-discovery", "pr-watch"] : [],
          error: github.error,
        },
      ];
    }

    case "auth.connect":
      return services.auth.connect(
        z.object({ provider: z.enum(["codex", "antigravity", "github"]) }).parse(input).provider,
      );

    case "auth.input": {
      const p = z.object({ session_id: z.string().uuid(), text: z.string() }).parse(input);
      services.auth.input(p.session_id, p.text);
      return null;
    }

    case "auth.close":
      services.auth.close(z.object({ session_id: z.string().uuid() }).parse(input).session_id);
      return null;

    case "open.directory": {
      const p = idInput.extend({ kind: z.enum(["task", "repository", "repair"]) }).parse(input);

      const path =
        p.kind === "repair"
          ? await services.repairs.openPath(p.id)
          : p.kind === "task"
            ? await taskRoot(e.root, e.db.task(p.id))
            : await realpath(e.db.repository(p.id).path);

      if (process.env.WSL_DISTRO_NAME) {
        const windows = await checked("wslpath", ["-w", path], e.root);
        await capture("explorer.exe", [windows], e.root);
      } else await capture("xdg-open", [path], e.root);
      return null;
    }

    default:
      throw new AdeError("invalid_method", `Unknown method: ${method}`);
  }
};
