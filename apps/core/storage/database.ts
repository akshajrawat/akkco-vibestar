import { baselineSchema, schemaVersion, sharedComputerSchema, viberSchedulesSchema } from "./schema";
import BetterSqlite3 from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { exists } from "../workspace/paths";
import { PersistedRecords } from "./records";
import { RepositoryRecordSchema, sqliteFilePaths } from "./contracts";
import { ViberSnapshots, loadViberSnapshotKey, viberSnapshotKeyPath } from "./viber-snapshots";
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

  readonly viberSnapshots: ViberSnapshots;

  static open = async (path: string) => {
    let initialize = true;
    let hasSealedSnapshots = false;
    if (path !== ":memory:") {
      for (const file of sqliteFilePaths(path)) {
        try {
          const entry = await lstat(file);
          if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink > 1) {
            throw new AdeError(
              "isolation",
              `Database file ${file} must be a regular non-symlink file without hard links.`,
            );
          }
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
            throw e;
          }
        }
      }
    }

    if (path !== ":memory:" && (await exists(path))) {
      const source = new BetterSqlite3(path, {
        readonly: true,
        fileMustExist: true,
      });

      try {
        const objects = source.prepare("SELECT name FROM sqlite_schema").pluck().all();
        const userVersion = source.pragma("user_version", { simple: true });

        const versions = objects.includes("schema_migrations")
          ? source.prepare("SELECT version FROM schema_migrations ORDER BY version").pluck().all()
          : [];

        initialize = objects.length === 0;

        // The previous schema also started at 0, before introducing private memory runs.
        if (
          userVersion !== schemaVersion ||
          (!initialize &&
            (versions.length !== 1 ||
              versions[0] !== schemaVersion ||
              !objects.includes("viber_memory_private_runs")))
        ) {
          throw new AdeError(
            "migration",
            `Database ${path} is incompatible with schema ${schemaVersion} (recorded versions: ${versions.join(", ") || "none"}, SQLite user_version: ${userVersion}). Preserve the database and choose a fresh data root.`,
          );
        }

        if (!initialize) {
          hasSealedSnapshots = Boolean(
            source
              .prepare(
                "SELECT 1 FROM viber_messages WHERE json_type(configuration,'$.sealed') IS NOT NULL LIMIT 1",
              )
              .get(),
          );
        }
      } finally {
        source.close();
      }
    }

    const key =
      path === ":memory:"
        ? undefined
        : await loadViberSnapshotKey(viberSnapshotKeyPath(path), !hasSealedSnapshots);

    return new Database(path, initialize, key);
  };

  private upgradeOptionalSchema = () => {
    this.connection.exec(sharedComputerSchema + viberSchedulesSchema);
    if (!this.all("SELECT name FROM sqlite_schema WHERE type='table' AND name='viber_pr_watches'").length) {
      return;
    }

    this.connection.exec(`
      INSERT INTO viber_schedules(id,profile_id,name,instructions,task,cadence,next_run_at,status,cursor)
      SELECT watch.id,session.profile_id,lower(watch.owner || '/' || watch.repo) || ' #' || watch.pull_number,
        'Watch ' || watch.url,json_object('kind','github','pull',lower(watch.url)),
        '{"kind":"interval","minutes":5}',
        CASE WHEN watch.status='active' AND retired.profile_id IS NULL THEN
          max(unixepoch('now') * 1000,coalesce(unixepoch(watch.last_checked_at) * 1000 + 300000,0))
        END,
        CASE WHEN retired.profile_id IS NOT NULL THEN 'cancelled'
          WHEN watch.status='active' THEN 'pending'
          WHEN watch.status='failed' THEN 'paused'
          ELSE watch.status
        END,
        CASE WHEN json_valid(watch.cursor) THEN json_object('pull',json(watch.cursor)) END
      FROM viber_pr_watches watch
      JOIN viber_sessions session ON session.id=watch.session_id
      LEFT JOIN retired_viber_profiles retired ON retired.profile_id=session.profile_id;

      DROP TABLE viber_pr_watches;
    `);
  };

  private constructor(path: string, initialize: boolean, key?: Buffer) {
    this.viberSnapshots = new ViberSnapshots(path === ":memory:" ? randomBytes(32) : key);
    this.connection = new BetterSqlite3(path);
    try {
      this.connection.pragma("journal_mode = WAL");
      this.connection.pragma("foreign_keys = ON");
      this.connection.pragma("busy_timeout = 5000");

      if (initialize) {
        this.transaction(() => {
          this.connection.exec(baselineSchema);
          this.run("INSERT INTO schema_migrations VALUES(?,?)", schemaVersion, now());
        });
      } else {
        // Early schema-0 data roots predate these features.
        this.transaction(this.upgradeOptionalSchema);
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
