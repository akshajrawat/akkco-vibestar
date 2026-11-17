import { createHash } from "node:crypto";

import { AdeError, now } from "../domain";
import type { Database } from "./database";

interface StoredJson {
  table: string;
  id: string | number;
  column: string;
  source: string;
  identity?: string;
}

export interface PersistenceDiagnostic {
  table_name: string;
  record_id: string;
  column_name: string;
  source_hash: string;
  first_seen: string;
  last_seen: string;
}

const objectValue = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a saved object");
  return value as Record<string, unknown>;
};

export class PersistedRecords {
  private ready = false;

  private pending = new Map<string, StoredJson>();

  constructor(private readonly db: Database) {}

  initialize = () => {
    this.ready = true;
    for (const record of this.pending.values()) this.report(record);
    this.pending.clear();
  };

  private report = (record: StoredJson) => {
    if (!this.ready) {
      this.pending.set(JSON.stringify([record.table, record.id, record.column]), record);
      return;
    }

    // Source bytes remain in their original record and pre-migration backup.
    // Diagnostics never copy potentially sensitive payloads into UI or errors.
    this.db.run(
      "INSERT INTO persistence_diagnostics(table_name,record_id,column_name,source_hash,first_seen,last_seen) VALUES(?,?,?,?,?,?) ON CONFLICT(table_name,record_id,column_name) DO UPDATE SET source_hash=excluded.source_hash,last_seen=excluded.last_seen,resolved_at=NULL",
      record.table,
      String(record.id),
      record.column,
      createHash("sha256").update(record.source).digest("hex"),
      now(),
      now(),
    );
  };

  decode = <T = Record<string, unknown>>(
    record: StoredJson,
    parse = (value: unknown) => objectValue(value) as T,
  ) => {
    let value: T;
    try {
      if (Buffer.byteLength(record.source) > 32 * 1024 * 1024)
        throw new Error("Saved record exceeded its decoding budget");
      value = parse(JSON.parse(record.source));
      if (record.identity && String(objectValue(value)[record.identity]) !== String(record.id))
        throw new Error("Saved identity does not match its owner");
    } catch {
      this.report(record);
      throw new AdeError(
        "corrupt_record",
        `Saved ${record.table} record ${record.id} could not be decoded safely. Its original data is preserved; inspect persistence diagnostics before using this record.`,
        { table: record.table, id: String(record.id), column: record.column },
      );
    }

    if (this.ready)
      this.db.run(
        "UPDATE persistence_diagnostics SET resolved_at=? WHERE table_name=? AND record_id=? AND column_name=? AND resolved_at IS NULL",
        now(),
        record.table,
        String(record.id),
        record.column,
      );
    return value;
  };

  tryDecode = <T = Record<string, unknown>>(record: StoredJson, parse?: (value: unknown) => T) => {
    try {
      return this.decode(record, parse);
    } catch (error) {
      if (error instanceof AdeError && error.kind === "corrupt_record") return undefined;
      throw error;
    }
  };

  list = <T = Record<string, unknown>>(
    table: string,
    rows: { id: string | number; data: string }[],
    parse?: (value: unknown) => T,
    identity?: string,
  ) =>
    rows.flatMap((row) => {
      const value = this.tryDecode(
        { table, id: row.id, column: "data", source: row.data, identity },
        parse,
      );

      return value === undefined ? [] : [value];
    });

  diagnostics = () =>
    this.db.all<PersistenceDiagnostic>(
      "SELECT table_name,record_id,column_name,source_hash,first_seen,last_seen FROM persistence_diagnostics WHERE resolved_at IS NULL ORDER BY table_name,record_id,column_name",
    );
}
