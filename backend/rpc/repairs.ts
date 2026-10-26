import { z } from "zod";

import { AdeError } from "../domain";
import { CommitMessageSchema } from "../workspace/commit-message";
import type { RpcServices } from "./services";
import { idInput } from "./validation";

export const repairsMethods = [
  "repair.create",
  "repair.list",
  "repair.detail",
  "repair.start",
  "repair.cancel",
  "repair.approve",
  "repair.approveLocal",
  "repair.commit",
  "repair.preparePublication",
  "repair.publish",
  "repair.reconcilePublication",
  "repair.keepLocal",
  "repair.cleanup",
  "repair.reviewFiles",
  "repair.reviewed",
  "repair.recoverConflict",
  "repair.diff",
  "repair.file",
] as const;

/** Validates and dispatches repairs requests through their existing domain services. */
export const callRepairs = async (
  services: Pick<RpcServices, "engine" | "repairs">,
  method: string,
  input: unknown,
) => {
  const e = services.engine;
  switch (method) {
    case "repair.create":
      return services.repairs.create(input);

    case "repair.list": {
      const p = z.object({ job_id: z.string().uuid().optional() }).strict().parse(input);
      return services.repairs.store.list(p.job_id);
    }

    case "repair.detail":
      return services.repairs.detail(idInput.strict().parse(input).id);

    case "repair.start": {
      const p = idInput
        .extend({
          instructions: z.string().max(16000).default(""),
          request_id: z.string().uuid().optional(),
        })
        .strict()
        .parse(input);

      return services.repairs.start(p.id, p.instructions, p.request_id);
    }

    case "repair.cancel":
      return services.repairs.cancel(idInput.strict().parse(input).id);

    case "repair.approve": {
      const p = idInput
        .extend({
          expected_hash: z.string().regex(/^[a-f0-9]{64}$/),
          confirmed: z.literal(true),
        })
        .strict()
        .parse(input);

      return services.repairs.approve(p.id, p.expected_hash);
    }

    case "repair.approveLocal": {
      const p = idInput
        .extend({
          expected_hash: z.string().regex(/^[a-f0-9]{64}$/),
          confirmed: z.literal(true),
        })
        .strict()
        .parse(input);

      return services.repairs.approveLocal(p.id, p.expected_hash);
    }

    case "repair.commit": {
      const p = idInput
        .extend({
          expected_hash: z.string().regex(/^[a-f0-9]{64}$/),
          message: CommitMessageSchema,
          confirmed: z.literal(true),
        })
        .strict()
        .parse(input);

      return services.repairs.commit(p.id, p.expected_hash, p.message);
    }

    case "repair.preparePublication":
      return services.repairs.preparePublication(idInput.strict().parse(input).id);

    case "repair.publish": {
      const p = idInput
        .extend({
          publication_id: z.string().uuid(),
          confirmed: z.literal(true),
        })
        .strict()
        .parse(input);

      return services.repairs.publish(p.id, p.publication_id);
    }

    case "repair.reconcilePublication": {
      const p = idInput.extend({ publication_id: z.string().uuid() }).strict().parse(input);
      return services.repairs.reconcilePublication(p.id, p.publication_id);
    }

    case "repair.keepLocal":
      return services.repairs.keepLocal(idInput.strict().parse(input).id);

    case "repair.cleanup": {
      const p = idInput
        .extend({
          confirmed: z.literal(true),
          history: z.boolean().default(false),
        })
        .strict()
        .parse(input);

      return services.repairs.cleanup(p.id, p.history);
    }

    case "repair.reviewFiles":
      return services.repairs.reviewFiles(idInput.strict().parse(input).id);

    case "repair.reviewed": {
      const p = idInput
        .extend({
          path: z.string().min(1).max(4000),
          old_path: z.string().nullable().optional(),
          expected_hash: z.string().regex(/^[a-f0-9]{64}$/),
          reviewed: z.boolean(),
        })
        .strict()
        .parse(input);

      return services.repairs.reviewed(p.id, p.path, p.old_path, p.expected_hash, p.reviewed);
    }

    case "repair.recoverConflict":
      return services.repairs.recoverConflict(
        idInput
          .extend({ confirmed: z.literal(true) })
          .strict()
          .parse(input).id,
      );

    case "repair.diff": {
      const p = idInput
        .extend({
          layer: z.enum(["original", "upstream", "repair"]).default("repair"),
        })
        .strict()
        .parse(input);

      const session = services.repairs.store.get(p.id);
      await services.repairs.workspaces.assert(session, e.db.repository(session.repo_id));
      const assignment = services.repairs.assignment(p.id);
      if (p.layer === "repair") return e.git.diff(assignment);

      const base =
        p.layer === "original" ? session.workspace.original_base : session.workspace.original_head;

      const head =
        p.layer === "original"
          ? session.workspace.original_head
          : session.workspace.integrated_head;

      if (!head) throw new AdeError("invalid_state", "Upstream integration has not completed.");
      return e.git.diff({ ...assignment, base_commit_sha: base }, head);
    }

    case "repair.file": {
      const p = idInput
        .extend({
          path: z.string().max(4000),
          old_path: z.string().nullable().optional(),
          layer: z.enum(["original", "upstream", "repair"]).default("repair"),
        })
        .strict()
        .parse(input);

      const session = services.repairs.store.get(p.id);
      await services.repairs.workspaces.assert(session, e.db.repository(session.repo_id));
      return e.git.file(
        {
          ...services.repairs.assignment(p.id),
          base_commit_sha:
            p.layer === "original"
              ? session.workspace.original_base
              : p.layer === "upstream"
                ? session.workspace.original_head
                : session.workspace.integrated_head || session.workspace.original_head,
        },
        p.path,
        p.old_path,
        p.layer === "original"
          ? session.workspace.original_head
          : p.layer === "upstream"
            ? session.workspace.integrated_head || undefined
            : undefined,
      );
    }

    default:
      throw new AdeError("invalid_method", `Unknown method: ${method}`);
  }
};
