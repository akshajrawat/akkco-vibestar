import { migrations } from "./migrations";
import BetterSqlite3 from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import { exists } from "../workspace/paths";
import { PersistedRecords } from "./records";
import { RepositoryRecordSchema } from "./contracts";
import {
  defaultSettings,
  AdeError,
  SettingsSchema,
  now,
  type Repository,
  type Settings,
} from "../domain";

export class Database {
  private readonly connection: BetterSqlite3.Database;

  readonly records = new PersistedRecords(this);

  static open = async (path: string) => {
    if (path !== ":memory:" && (await exists(path))) {
      const source = new BetterSqlite3(path, {
        readonly: true,
        fileMustExist: true,
      });

      try {
        const table = source
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
          .get();

        const version = table
          ? ((
              source.prepare("SELECT max(version) version FROM schema_migrations").get() as {
                version: number | null;
              }
            ).version ?? -1)
          : -1;

        if (version < migrations.at(-1)!.version) {
          const backup = `${path}.before-v${version}-${randomUUID()}.sqlite`;
          await source.backup(backup);
          await chmod(backup, 0o600);
        }
      } finally {
        source.close();
      }
    }

    return new Database(path);
  };

  constructor(path: string) {
    this.connection = new BetterSqlite3(path);
    try {
      this.connection.pragma("journal_mode = WAL");
      this.connection.pragma("foreign_keys = ON");
      this.connection.pragma("busy_timeout = 5000");

      this.connection.exec(
        "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)",
      );

      for (const migration of migrations) {
        if (
          !this.connection
            .prepare("SELECT version FROM schema_migrations WHERE version=?")
            .get(migration.version)
        ) {
          const rebuild = "foreign_keys_off" in migration && migration.foreign_keys_off;
          if (rebuild) {
            this.connection.pragma("foreign_keys = OFF");
          }

          try {
            this.connection.transaction(() => {
              this.connection.exec(migration.sql);

              this.run(
                "INSERT OR IGNORE INTO schema_migrations VALUES(?,?)",
                migration.version,
                now(),
              );

              if (this.all("PRAGMA foreign_key_check").length) {
                throw new Error("Repository migration failed foreign key verification");
              }
            })();
          } finally {
            if (rebuild) {
              this.connection.pragma("foreign_keys = ON");
            }
          }
        }
      }

      this.records.initialize();
    } catch (error) {
      this.connection.close();
      throw error;
    }
  }

  run = (sql: string, ...params: unknown[]) => this.connection.prepare(sql).run(...params);

  transaction = <T>(operation: () => T) => this.connection.transaction(operation)();

  backup = (path: string) => this.connection.backup(path);

  all = <T extends object = Record<string, unknown>>(sql: string, ...params: unknown[]) =>
    this.connection.prepare(sql).all(...params) as T[];

  repositories = () =>
    this.records.list<Repository>(
      "repositories",
      this.all<{ id: string; data: string }>(
        "SELECT id,data FROM repositories ORDER BY owner,name",
      ),
      RepositoryRecordSchema.parse,
      "id",
    );

  repository = (id: string | null) => {
    if (!id) {
      throw new AdeError("repository_required", "This operation requires an attached repository.");
    }

    const row = this.all<{ data: string }>("SELECT data FROM repositories WHERE id=?", id)[0];
    if (!row) {
      throw new Error("Repository is not registered");
    }

    return this.records.decode<Repository>(
      {
        table: "repositories",
        id,
        column: "data",
        source: row.data,
        identity: "id",
      },
      RepositoryRecordSchema.parse,
    );
  };

  saveRepository = (r: Repository) =>
    this.run(
      "INSERT INTO repositories VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      r.id,
      r.owner,
      r.name,
      JSON.stringify(r),
    );

  assertOwnershipRecords = () => {
    if (this.repositories().length !== this.all("SELECT id FROM repositories").length) {
      throw new AdeError(
        "corrupt_record",
        "Saved workspace ownership records are corrupt. Preserve the data root and inspect persistence diagnostics before cleanup or migration.",
      );
    }
  };

  settings = () => {
    const row = this.all<{ value: string }>("SELECT value FROM settings WHERE key='pipeline'")[0];
    return row
      ? this.records.decode(
          {
            table: "settings",
            id: "pipeline",
            column: "value",
            source: row.value,
          },
          SettingsSchema.parse,
        )
      : structuredClone(defaultSettings);
  };

  displaySettings = () => {
    try {
      return this.settings();
    } catch (error) {
      if (error instanceof AdeError && error.kind === "corrupt_record") {
        return structuredClone(defaultSettings);
      }

      throw error;
    }
  };

  saveSettings = (s: Settings) =>
    this.run(
      "INSERT INTO settings VALUES('pipeline',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      JSON.stringify(SettingsSchema.parse(s)),
    );

  recover = () => {
    this.connection.transaction(() => {
      this.run(
        "UPDATE utility_runs SET status='interrupted',ended_at=? WHERE status='running'",
        now(),
      );

      this.run(
        "UPDATE viber_sessions SET thread=json_set(thread,'$.status','uncertain') WHERE thread IS NOT NULL AND id IN (SELECT session_id FROM viber_messages WHERE status='pending' AND effects<>'none')",
      );

      this.run(
        "UPDATE viber_messages SET status='interrupted',error='Execution core stopped; send a new message to retry' WHERE status='pending'",
      );

      this.run(
        "UPDATE ai_usage SET status='interrupted',ended_at=?,duration_ms=CAST((julianday(?) - julianday(started_at))*86400000 AS INTEGER) WHERE status='running'",
        now(),
        now(),
      );
    })();
  };

  close = () => {
    if (this.connection.open) {
      this.connection.close();
    }
  };
}
