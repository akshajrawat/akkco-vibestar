import { z } from "zod";

import { AdeError } from "../domain";
import { readLogTail } from "../storage/logs";
import type { RpcServices } from "./services";
import { idInput } from "./validation";

export const outputMethods = ["repair.events", "repair.logs", "task.events", "task.logs"] as const;

/** Validates and dispatches output requests through their existing domain services. */
export const callOutput = async (
  services: Pick<RpcServices, "engine" | "repairs">,
  method: string,
  input: unknown,
) => {
  const e = services.engine;
  switch (method) {
    case "repair.events":
    case "repair.logs":
    case "task.events":
    case "task.logs": {
      const p = idInput
        .extend({
          run_id: z.string().uuid().nullable(),
          stream: z.enum(["stdout", "stderr"]).default("stdout"),
          before: z.number().int().nonnegative().optional(),
          after: z.number().int().nonnegative().optional(),
          search: z.string().max(256).optional(),
          paged: z.boolean().optional(),
        })
        .parse(input);

      const owner = method.startsWith("repair.") ? "repair_id" : "task_id";
      if (owner === "repair_id") services.repairs.store.get(p.id);
      else e.db.task(p.id);
      if (
        p.run_id &&
        !e.db.all(`SELECT id FROM agent_runs WHERE id=? AND ${owner}=?`, p.run_id, p.id).length
      )
        throw new AdeError("isolation", "Run does not belong to this task");
      if (method.endsWith(".events")) {
        const rows = e.db.all<{ id: number; data: string; kind: string }>(
          `SELECT * FROM agent_events WHERE ${owner}=? AND run_id=?
             AND id<? AND id>? AND (?='' OR instr(lower(data || raw),lower(?))>0)
             ORDER BY id ${p.after !== undefined ? "ASC" : "DESC"} LIMIT 501`,
          p.id,
          p.run_id,
          p.before ?? Number.MAX_SAFE_INTEGER,
          p.after ?? 0,
          p.search || "",
          p.search || "",
        );

        const more = rows.length > 500;
        const events = rows.slice(0, 500);
        if (p.after === undefined) events.reverse();

        const calls = [
          ...new Set(
            events
              .filter((event) => event.kind !== "message")
              .flatMap((event) => {
                try {
                  const data = JSON.parse(event.data);
                  return data.call_id == null ? [] : [String(data.call_id)];
                } catch {
                  return [];
                }
              }),
          ),
        ];

        const context = calls.length
          ? e.db.all(
              `SELECT * FROM agent_events WHERE id IN (
             SELECT MIN(id) FROM agent_events WHERE ${owner}=? AND run_id=? AND json_valid(data)
             AND CAST(json_extract(CASE WHEN json_valid(data) THEN data END,'$.call_id') AS TEXT) IN (${calls.map(() => "?").join(",")}) GROUP BY json_extract(CASE WHEN json_valid(data) THEN data END,'$.call_id')
             UNION SELECT MAX(id) FROM agent_events WHERE ${owner}=? AND run_id=? AND json_valid(data)
             AND CAST(json_extract(CASE WHEN json_valid(data) THEN data END,'$.call_id') AS TEXT) IN (${calls.map(() => "?").join(",")}) GROUP BY json_extract(CASE WHEN json_valid(data) THEN data END,'$.call_id')
             ) ORDER BY id`,
              p.id,
              p.run_id,
              ...calls,
              p.id,
              p.run_id,
              ...calls,
            )
          : [];

        return { events, context, more };
      }

      return readLogTail(
        e.root,
        p.id,
        p.run_id,
        p.stream,
        p.paged ? { before: p.before, after: p.after, search: p.search } : undefined,
      );
    }

    default:
      throw new AdeError("invalid_method", `Unknown method: ${method}`);
  }
};
