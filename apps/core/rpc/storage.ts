import { z } from "zod";

import { AdeError } from "../domain";
import { capture, checked } from "../execution/runtime/process";
import type { RpcServices } from "./services";

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
] as const;

/** Validates and dispatches storage requests through their existing domain services. */
export const callStorage = async (
  services: Pick<RpcServices, "engine" | "storage">,
  method: string,
  input: unknown,
) => {
  const e = services.engine;
  switch (method) {
    case "storage.info":
      return services.storage.info();

    case "storage.blockers": {
      const p = z
        .object({
          session_id: z.string().uuid().optional(),
          task_id: z.string().uuid().optional(),
        })
        .parse(input);

      return e.cleanupBlockers(p.session_id || p.task_id);
    }

    case "storage.stopBlockers": {
      const p = z
        .object({
          session_id: z.string().uuid().optional(),
          task_id: z.string().uuid().optional(),
          ids: z.array(z.string()).max(100),
        })
        .parse(input);

      const targetId = p.session_id || p.task_id;

      const blockers = e
        .cleanupBlockers(targetId)
        .filter((b) => b.stoppable && p.ids.includes(b.id));

      await Promise.all(blockers.map((b) => e.stopActivity(b.id)));

      return e.cleanupBlockers(targetId);
    }

    case "storage.open": {
      if (process.env.WSL_DISTRO_NAME) {
        await capture("explorer.exe", [await checked("wslpath", ["-w", e.root], e.root)], e.root);
      } else {
        await capture("xdg-open", [e.root], e.root);
      }

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
      if (blockers.length) {
        throw new AdeError("busy", "Data reset is waiting for active operations to finish.", {
          blockers,
        });
      }

      return services.storage.reset(p.preview_token);
    }

    default:
      throw new AdeError("invalid_method", `Unknown method: ${method}`);
  }
};
