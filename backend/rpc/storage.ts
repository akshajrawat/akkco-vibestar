import { z } from "zod";
import { AdeError } from "../domain";
import { capture, checked } from "../execution/runtime/process";
import { TaskDisposalSchema } from "../storage/disposal";
import type { RpcServices } from "./services";
import { idInput } from "./validation";
export const storageMethods = [
  "storage.info",
  "storage.blockers",
  "storage.stopBlockers",
  "storage.open",
  "storage.clear",
  "storage.cleanCompleted",
  "storage.removeUnused",
  "storage.resetPreview",
  "storage.reset",
  "task.cleanup",
  "task.archive",
  "task.disposal.preview",
  "task.disposal.discard",
  "task.disposal.preserve",
] as const;
/** Validates and dispatches storage requests through their existing domain services. */
export const callStorage = async (
  services: Pick<RpcServices, "engine" | "storage" | "terminals">,
  method: string,
  input: unknown,
) => {
  const e = services.engine;
  switch (method) {
    case "storage.info":
      return services.storage.info();
    case "storage.blockers": {
      const p = z.object({ task_id: z.string().uuid().optional() }).parse(input);
      return e.cleanupBlockers(p.task_id);
    }
    case "storage.stopBlockers": {
      const p = z
        .object({
          task_id: z.string().uuid().optional(),
          ids: z.array(z.string()).max(100),
        })
        .parse(input);
      const blockers = e
        .cleanupBlockers(p.task_id)
        .filter((b) => b.stoppable && p.ids.includes(b.id));
      await Promise.all(
        blockers.map((b) =>
          b.kind === "terminal" && b.task_id
            ? services.terminals.close(b.task_id)
            : e.stopActivity(b.id),
        ),
      );
      return e.cleanupBlockers(p.task_id);
    }
    case "storage.open": {
      if (process.env.WSL_DISTRO_NAME)
        await capture("explorer.exe", [await checked("wslpath", ["-w", e.root], e.root)], e.root);
      else await capture("xdg-open", [e.root], e.root);
      return null;
    }
    case "storage.clear": {
      const p = z
        .object({
          kind: z.enum(["logs", "cache"]),
          confirmed: z.literal(true),
        })
        .parse(input);
      await services.storage.clear(p.kind);
      return null;
    }
    case "storage.cleanCompleted": {
      z.object({ confirmed: z.literal(true) }).parse(input);
      return services.storage.cleanCompleted();
    }
    case "storage.removeUnused": {
      z.object({ confirmed: z.literal(true) }).parse(input);
      return services.storage.removeUnused();
    }
    case "storage.resetPreview":
      z.object({}).strict().parse(input);
      return services.storage.previewReset();
    case "storage.reset": {
      const p = z
        .object({
          confirmed: z.literal(true),
          confirmation: z.literal("RESET LOCAL TEST WORKSPACE"),
          preview_token: z.string().min(1),
        })
        .strict()
        .parse(input);
      const blockers = e.cleanupBlockers();
      if (blockers.length)
        throw new AdeError("busy", "Data reset is waiting for active operations to finish.", {
          blockers,
        });
      return services.storage.reset(p.preview_token);
    }
    case "task.cleanup": {
      const p = idInput
        .extend({
          confirmed: z.literal(true),
          worktree: z.boolean(),
          logs: z.boolean(),
          artifacts: z.boolean(),
          history: z.boolean(),
        })
        .parse(input);
      return services.storage.cleanupTask(p.id, p);
    }
    case "task.archive": {
      const p = idInput.extend({ archived: z.boolean() }).parse(input);
      if (!p.archived && e.db.task(p.id).status === "preserved")
        throw new AdeError(
          "invalid_state",
          "This retained worktree keeps its ownership record, but its conversation history has been removed.",
        );
      if (e.isActive(p.id) || e.db.task(p.id).status === "queued")
        throw new AdeError("busy", "Stop this task before archiving it.");
      e.db.saveTask({ ...e.db.task(p.id), archived: p.archived });
      e.changed(p.id);
      return null;
    }
    case "task.disposal.preview":
      return services.storage.previewTaskDisposal(idInput.strict().parse(input).id);
    case "task.disposal.discard": {
      const p = TaskDisposalSchema.parse(input);
      return services.storage.discardTask(p.id, p.fingerprint, p.acknowledge_unpublished);
    }
    case "task.disposal.preserve": {
      const p = idInput
        .extend({ confirmed: z.literal(true) })
        .strict()
        .parse(input);
      return services.storage.preserveTaskWork(p.id);
    }
    default:
      throw new AdeError("invalid_method", `Unknown method: ${method}`);
  }
};
