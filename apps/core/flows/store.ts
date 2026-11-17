import { z } from "zod";

import { AdeError, now } from "../domain";
import type { Database } from "../storage/database";
import {
  AgentProfileSchema,
  CanvasLayoutSchema,
  FlowDefinitionSchema,
  FlowRevisionSchema,
  type AgentProfile,
  type FlowDefinition,
} from "./contracts";

const identity = z.string().uuid();

/** Saves configurations only; profile, revision and layout edits authorize no execution. */
export class FlowStore {
  constructor(private readonly db: Database) {}

  saveProfile = (input: AgentProfile, expectedRevision: number | null) => {
    const profile = AgentProfileSchema.parse(input);
    if (profile.revision !== (expectedRevision || 0) + 1)
      throw new AdeError("invalid_input", "Profile revisions must advance by one.");

    return this.db.transaction(() => {
      this.assertRevision("agent_profiles", profile.id, expectedRevision);
      const timestamp = now();

      this.db.run(
        "INSERT INTO agent_profiles VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET current_revision=excluded.current_revision,updated_at=excluded.updated_at",
        profile.id,
        profile.revision,
        timestamp,
        timestamp,
      );

      this.db.run(
        "INSERT INTO agent_profile_revisions VALUES(?,?,?,?)",
        profile.id,
        profile.revision,
        JSON.stringify(profile),
        timestamp,
      );

      return profile;
    });
  };

  profile = (id: string, revision?: number) => {
    identity.parse(id);

    const row = this.db.all<{ revision: number; data: string }>(
      "SELECT r.revision,r.data FROM agent_profile_revisions r JOIN agent_profiles p ON p.id=r.profile_id WHERE p.id=? AND r.revision=COALESCE(?,p.current_revision)",
      id,
      revision ?? null,
    )[0];

    if (!row) throw new AdeError("not_found", "Agent profile revision not found.");

    return this.db.records.decode(
      {
        table: "agent_profile_revisions",
        id: `${id}:${row.revision}`,
        column: "data",
        source: row.data,
      },
      (value) => {
        const profile = AgentProfileSchema.parse(value);
        if (profile.id !== id || profile.revision !== row.revision)
          throw new Error("Profile identity mismatch.");
        return profile;
      },
    );
  };

  saveDefinition = (
    id: string,
    input: FlowDefinition,
    expectedRevision: number | null,
    taskId?: string,
  ) => {
    identity.parse(id);
    const definition = FlowDefinitionSchema.parse(input);

    return this.db.transaction(() => {
      const existing = this.assertRevision("flow_definitions", id, expectedRevision);
      if (existing && taskId !== undefined && taskId !== existing.task_id)
        throw new AdeError("isolation", "A saved flow cannot move to another task.");
      const revision = (expectedRevision || 0) + 1;
      const timestamp = now();

      const record = FlowRevisionSchema.parse({
        flow_id: id,
        revision,
        definition,
        created_at: timestamp,
      });

      this.db.run(
        "INSERT INTO flow_definitions VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET current_revision=excluded.current_revision,updated_at=excluded.updated_at",
        id,
        taskId ?? existing?.task_id ?? null,
        revision,
        timestamp,
        timestamp,
      );

      this.db.run(
        "INSERT INTO flow_revisions VALUES(?,?,?,?)",
        id,
        revision,
        JSON.stringify(record),
        timestamp,
      );

      return record;
    });
  };

  definition = (id: string, revision?: number) => {
    identity.parse(id);

    const row = this.db.all<{ revision: number; data: string }>(
      "SELECT r.revision,r.data FROM flow_revisions r JOIN flow_definitions f ON f.id=r.flow_id WHERE f.id=? AND r.revision=COALESCE(?,f.current_revision)",
      id,
      revision ?? null,
    )[0];

    if (!row) throw new AdeError("not_found", "Flow revision not found.");

    return this.db.records.decode(
      { table: "flow_revisions", id: `${id}:${row.revision}`, column: "data", source: row.data },
      (value) => {
        const record = FlowRevisionSchema.parse(value);
        if (record.flow_id !== id || record.revision !== row.revision)
          throw new Error("Flow identity mismatch.");
        return record;
      },
    );
  };

  saveLayout = (id: string, input: z.infer<typeof CanvasLayoutSchema>) => {
    identity.parse(id);
    const layout = CanvasLayoutSchema.parse(input);
    const definition = this.definition(id).definition;
    const nodes = new Set(definition.nodes.map((node) => node.id));
    if (Object.keys(layout.positions).some((nodeId) => !nodes.has(nodeId)))
      throw new AdeError("invalid_input", "Canvas positions must belong to nodes in this flow.");

    this.db.run(
      "INSERT INTO flow_canvas_layouts VALUES(?,?,?) ON CONFLICT(flow_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",
      id,
      JSON.stringify(layout),
      now(),
    );

    return layout;
  };

  layout = (id: string) => {
    identity.parse(id);

    const row = this.db.all<{ data: string }>(
      "SELECT data FROM flow_canvas_layouts WHERE flow_id=?",
      id,
    )[0];

    if (!row) return null;
    return this.db.records.decode(
      { table: "flow_canvas_layouts", id, column: "data", source: row.data },
      CanvasLayoutSchema.parse,
    );
  };

  private assertRevision = (
    table: "agent_profiles" | "flow_definitions",
    id: string,
    expected: number | null,
  ) => {
    if (expected !== null) z.number().int().positive().parse(expected);

    const row = this.db.all<{ current_revision: number; task_id?: string | null }>(
      `SELECT * FROM ${table} WHERE id=?`,
      id,
    )[0];

    if ((row?.current_revision ?? null) !== expected)
      throw new AdeError(
        "stale_configuration",
        "The saved configuration changed. Reload it before applying your edits.",
      );
    return row;
  };
}
