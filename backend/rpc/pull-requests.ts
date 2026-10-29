import { z } from "zod";

import { AdeError, FollowupConfigSchema } from "../domain";
import { BatchSelectionSchema, StartPRBatchSchema } from "../review/pr/batches";
import { GitHubMonitor } from "../scheduled/github";
import { readLogTail } from "../storage/logs";
import type { RpcServices } from "./services";
import { idInput } from "./validation";

export const pullRequestsMethods = [
  "pr.watch.start",
  "pr.watch.cancel",
  "scheduled.add",
  "scheduled.analyze",
  "scheduled.batch.preview",
  "scheduled.batch.start",
  "scheduled.batch.cancel",
  "scheduled.cancel",
  "scheduled.detail",
  "scheduled.logs",
  "scheduled.enabled",
  "scheduled.run",
  "scheduled.remove",
  "scheduled.dismiss",
  "scheduled.fix",
  "scheduled.discover",
] as const;

/** Validates and dispatches pull-requests requests through their existing domain services. */
export const callPullRequests = async (
  services: Pick<RpcServices, "engine" | "scheduler" | "prBatches" | "prWatch">,
  method: string,
  input: unknown,
) => {
  const e = services.engine;
  switch (method) {
    case "pr.watch.start":
      return services.prWatch.start(input);

    case "pr.watch.cancel":
      z.object({}).strict().parse(input);
      return services.prWatch.cancel();

    case "scheduled.add":
      return services.scheduler.add(input);

    case "scheduled.analyze": {
      const p = idInput
        .extend({ request_id: z.string().uuid(), configuration: FollowupConfigSchema.optional() })
        .strict()
        .parse(input);

      return services.scheduler.analyze(
        p.id,
        p.request_id,
        p.configuration
          ? {
              configuration: { ...p.configuration.config, provider: p.configuration.provider },
            }
          : undefined,
      );
    }

    case "scheduled.batch.preview":
      return services.prBatches.preview(BatchSelectionSchema.parse(input));

    case "scheduled.batch.start":
      return services.prBatches.start(StartPRBatchSchema.parse(input));

    case "scheduled.batch.cancel":
      return services.prBatches.cancel(idInput.strict().parse(input).id);

    case "scheduled.cancel":
      return services.scheduler.cancel(idInput.strict().parse(input).id);

    case "scheduled.detail": {
      const p = idInput.strict().parse(input);
      if (!services.scheduler.jobs().some((job) => job.id === p.id))
        throw new AdeError("not_found", "Tracked PR not found");
      return {
        analyses: services.scheduler.analysis.history(p.id),
        runs: e.db.all(
          "SELECT * FROM scheduled_agent_runs WHERE job_id=? ORDER BY started_at",
          p.id,
        ),
        usage: e.db.all("SELECT * FROM ai_usage WHERE job_id=? ORDER BY started_at DESC", p.id),
      };
    }

    case "scheduled.logs": {
      const p = idInput
        .extend({
          run_id: z.string().uuid(),
          stream: z.enum(["stdout", "stderr"]),
        })
        .strict()
        .parse(input);

      if (
        !e.db.all("SELECT id FROM scheduled_agent_runs WHERE id=? AND job_id=?", p.run_id, p.id)
          .length
      )
        throw new AdeError("isolation", "Run does not belong to this PR");
      return readLogTail(e.root, `pr-watch-${p.id}`, p.run_id, p.stream);
    }

    case "scheduled.enabled": {
      const p = idInput.extend({ enabled: z.boolean() }).parse(input);
      return services.scheduler.setEnabled(p.id, p.enabled);
    }

    case "scheduled.run": {
      const p = idInput.extend({ retry: z.boolean().default(false) }).parse(input);
      return services.scheduler.runNow(p.id);
    }

    case "scheduled.remove": {
      const p = idInput.extend({ confirmed: z.literal(true) }).parse(input);
      if (e.db.all("SELECT id FROM pr_repairs WHERE job_id=?", p.id).length)
        throw new AdeError(
          "repair_history",
          "Remove this PR's repair workspaces and history explicitly before removing the tracked PR.",
        );
      const job = services.scheduler.jobs().find((j) => j.id === p.id);
      if (
        job &&
        (["analyzing", "polling"].includes(job.status) ||
          e.cleanupBlockers().some((activity) => activity.id === `pr-watch:${p.id}`))
      )
        throw new AdeError("busy", "Wait for inspection to finish");
      e.db.run("DELETE FROM scheduled_jobs WHERE id=?", p.id);
      e.changed();
      return null;
    }

    case "scheduled.dismiss":
      return services.scheduler.dismiss(idInput.parse(input).id);

    case "scheduled.fix":
      idInput.strict().parse(input);
      return services.scheduler.fix();

    case "scheduled.discover": {
      const p = z.object({ repository: z.string().max(200) }).parse(input);
      return new GitHubMonitor(e.root).discover(p.repository, new AbortController().signal);
    }

    default:
      throw new AdeError("invalid_method", `Unknown method: ${method}`);
  }
};
