import { randomUUID } from "node:crypto";
import { AdeError, now } from "../../domain";
import type { Database } from "../../storage/database";
import { RepairSessionSchema, type RepairSession } from "./contracts";

export class RepairStore {
  constructor(private readonly db: Database) {}
  list = (jobId?: string) =>
    this.db.records.list(
      "pr_repairs",
      this.db.all<{ id: string; data: string }>(
        `SELECT id,data FROM pr_repairs ${jobId ? "WHERE job_id=?" : ""} ORDER BY created_at DESC,rowid DESC`,
        ...(jobId ? [jobId] : []),
      ),
      RepairSessionSchema.parse,
      "id",
    );
  get = (id: string) => {
    const row = this.db.all<{ data: string }>(
      "SELECT data FROM pr_repairs WHERE id=?",
      id,
    )[0];
    if (!row) throw new AdeError("not_found", "PR repair session not found.");
    return this.db.records.decode(
      {
        table: "pr_repairs",
        id,
        column: "data",
        source: row.data,
        identity: "id",
      },
      RepairSessionSchema.parse,
    );
  };
  save = (session: RepairSession) => {
    session.updated_at = now();
    const value = RepairSessionSchema.parse(session);
    this.db.run(
      "INSERT INTO pr_repairs VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data,updated_at=excluded.updated_at",
      value.id,
      value.job_id,
      value.repo_id,
      value.analysis_id,
      value.status,
      JSON.stringify(value),
      value.created_at,
      value.updated_at,
    );
  };
  activity = (session: RepairSession, kind: string, data: unknown) =>
    this.db.run(
      "INSERT INTO repair_activity(repair_id,kind,data,timestamp) VALUES(?,?,?,?)",
      session.id,
      kind,
      JSON.stringify(data),
      now(),
    );
  message = (id: string, content: string, requestId: string = randomUUID()) =>
    this.db.run(
      "INSERT INTO repair_messages VALUES(?,?,'user',?,?)",
      requestId,
      id,
      content,
      now(),
    );
  transition = (
    session: RepairSession,
    status: RepairSession["status"],
    error: string | null = null,
  ) => {
    const previous = session.status;
    session.status = status;
    session.error = error;
    this.db.transaction(() => {
      this.save(session);
      this.activity(session, "transition", {
        from: previous,
        to: status,
        error,
      });
    });
  };
}
