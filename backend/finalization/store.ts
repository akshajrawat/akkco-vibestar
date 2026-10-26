import { AdeError, now } from "../domain";
import type { Database } from "../storage/database";
import { redact } from "../execution/runtime/process";
import { FinalizationSchema, type Finalization } from "./contracts";

export class FinalizationStore {
  constructor(private readonly db: Database) {}
  private validate = (taskId: string, source: unknown) => {
    const record = FinalizationSchema.parse(source);
    if (record.task_id !== taskId)
      throw new AdeError(
        "ownership",
        "Saved Git operation task ownership does not match its persisted owner.",
      );
    return record;
  };
  list = (taskId: string) =>
    this.db.records.list(
      "git_finalizations",
      this.db.all<{ id: string; data: string }>(
        "SELECT id,data FROM git_finalizations WHERE task_id=? ORDER BY created_at DESC,rowid DESC",
        taskId,
      ),
      (source) => this.validate(taskId, source),
      "id",
    );
  get = (taskId: string, id: string) => {
    const record = this.db.all<{ data: string }>(
      "SELECT data FROM git_finalizations WHERE id=? AND task_id=?",
      id,
      taskId,
    )[0];
    if (!record) throw new AdeError("not_found", "Git operation does not belong to this task.");
    return this.db.records.decode(
      {
        table: "git_finalizations",
        id,
        column: "data",
        source: record.data,
        identity: "id",
      },
      (source) => this.validate(taskId, source),
    );
  };
  save = (record: Finalization) => {
    record.updated_at = now();
    const value = FinalizationSchema.parse(record);
    const result = this.db.run(
      "INSERT INTO git_finalizations VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data,updated_at=excluded.updated_at WHERE git_finalizations.task_id=excluded.task_id",
      value.id,
      value.task_id,
      value.status,
      JSON.stringify(value),
      value.created_at,
      value.updated_at,
    );
    if (result.changes !== 1)
      throw new AdeError(
        "ownership",
        "This Git request identity already belongs to a different task.",
      );
  };
  event = (record: Finalization, phase: string, output = "", code: number | null = null) => {
    const text = Buffer.from(redact(output), "utf8");
    let start = Math.max(0, text.length - 65536);
    while (start < text.length && (text[start] & 0xc0) === 0x80) start++;
    return this.db.run(
      "INSERT INTO git_operation_events(finalization_id,phase,output,exit_code,timestamp) VALUES(?,?,?,?,?)",
      record.id,
      phase,
      `${start ? "[Earlier output omitted after the 64 KiB event limit.]\n" : ""}${text.subarray(start).toString("utf8")}`,
      code,
      now(),
    );
  };
  remove = (id: string) =>
    this.db.transaction(() => {
      this.db.run("DELETE FROM git_operation_events WHERE finalization_id=?", id);
      this.db.run("DELETE FROM git_finalizations WHERE id=?", id);
    });
  events = (id: string, before?: number) =>
    this.db
      .all<{
        id: number;
        phase: string;
        output: string;
        exit_code: number | null;
        timestamp: string;
      }>(
        "SELECT id,phase,output,exit_code,timestamp FROM git_operation_events WHERE finalization_id=? AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT 201",
        id,
        before ?? null,
        before ?? null,
      )
      .reverse();
}
