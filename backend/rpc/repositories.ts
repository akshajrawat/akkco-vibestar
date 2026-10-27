import { open } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { AdeError } from "../domain";
import { capture } from "../execution/runtime/process";
import { ConnectLocalInput, LocalRepositoryInput } from "../workspace/discovery";
import type { RpcServices } from "./services";
import { idInput } from "./validation";

export const repositoriesMethods = [
  "github.status",
  "github.sync",
  "github.configure",
  "github.resolve",
  "github.use",
  "github.clone",
  "github.clone.cancel",
  "github.clone.logs",
  "repository.verifyLocal",
  "repository.locateLocal",
  "repository.configureDestination",
  "repository.connectLocal",
  "repository.disconnect",
  "repository.reconnectManaged",
  "repository.verify",
  "repositories.scan",
  "repositories.index",
  "repositories.candidates",
  "repository.add",
  "repository.fetch",
  "repository.info",
  "repository.remove",
] as const;

/** Validates and dispatches repositories requests through their existing domain services. */
export const callRepositories = async (
  services: Pick<RpcServices, "engine" | "github" | "storage">,
  method: string,
  input: unknown,
) => {
  const e = services.engine;
  switch (method) {
    case "github.status":
      return services.github.client.detect();

    case "github.sync":
      return services.github.sync();

    case "github.configure":
      return services.github.configure(input);

    case "github.resolve":
      return services.github.resolve(
        z.object({ repository: z.string().max(200) }).parse(input).repository,
      );

    case "github.use": {
      const p = z
        .object({
          repository: z.string().max(200),
          local_path: z.string().max(2000).optional(),
        })
        .parse(input);

      return services.github.useLocally(p.repository, false, p.local_path);
    }

    case "github.clone": {
      const p = z
        .object({ repository: z.string().min(1).max(200) })
        .strict()
        .parse(input);

      return services.github.startClone(p.repository);
    }

    case "github.clone.cancel":
      return services.github.cancelClone(idInput.strict().parse(input).id);

    case "github.clone.logs": {
      const p = idInput.strict().parse(input);
      if (!services.github.cloneActivities().some((c) => c.id === p.id))
        throw new AdeError("not_found", "Clone activity not found");
      const log = await open(join(e.root, "logs", `clone-${p.id}.log`), "r");
      try {
        const size = (await log.stat()).size;
        const buffer = Buffer.alloc(Math.min(size, 1048576));
        await log.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
        return {
          text: buffer.toString("utf8"),
          truncated: size > buffer.length,
        };
      } finally {
        await log.close();
      }
    }

    case "repository.verifyLocal":
      return e.verifyLocalRepository(LocalRepositoryInput.parse(input));

    case "repository.locateLocal":
      return e.repositoryIndex.locateLocal(LocalRepositoryInput.parse(input));

    case "repository.configureDestination":
      return services.github.configureDestination(input);

    case "repository.connectLocal":
      return e.connectLocalRepository(ConnectLocalInput.parse(input));

    case "repository.disconnect": {
      const p = idInput
        .extend({ confirmed: z.literal(true) })
        .strict()
        .parse(input);

      return e.disconnectRepository(p.id);
    }

    case "repository.reconnectManaged":
      return e.reconnectRepository(idInput.strict().parse(input).id);

    case "repository.verify":
      return e.verifyRepository(idInput.strict().parse(input).id);

    case "repositories.scan": {
      e.assertAvailable();
      const result = await e.repositoryIndex.scan();
      e.changed();
      return result;
    }

    case "repositories.index":
      return e.repositoryIndex.snapshot();

    case "repositories.candidates": {
      e.assertAvailable();
      const p = z.object({ repository: z.string().max(200) }).parse(input);
      const metadata = await services.github.client.repository(p.repository);
      await e.repositoryIndex.scan();
      e.changed();

      const matches = [metadata.full_name, metadata.parent?.full_name]
        .filter((name) => !!name)
        .flatMap((name) => e.repositoryIndex.matches(name!));

      return {
        candidates: [...new Map(matches.map((r) => [r.path, r])).values()].filter(
          (candidate) =>
            !e.db.repositories().some((r) => r.connected !== false && r.path === candidate.path),
        ),
      };
    }

    case "repository.add": {
      const p = z
        .object({
          upstream_url: z.string().max(2000),
          origin_url: z.string().max(2000).nullable(),
          base_branch: z.string().max(200),
        })
        .parse(input);

      return e.register(p.upstream_url, p.origin_url, p.base_branch);
    }

    case "repository.fetch":
      return e.fetchRepository(idInput.parse(input).id);

    case "repository.info": {
      const r = e.db.repository(idInput.parse(input).id);
      const o = await capture("du", ["-sh", r.path], e.root);
      return {
        disk_usage: o.stdout.split("\t")[0],
        active_worktrees: e.db.tasks().filter((t) => t.repo_id === r.id && t.worktree_path).length,
      };
    }

    case "repository.remove": {
      const p = idInput.extend({ confirmed: z.literal(true) }).parse(input);
      return services.storage.removeRepository(p.id);
    }

    default:
      throw new AdeError("invalid_method", `Unknown method: ${method}`);
  }
};
