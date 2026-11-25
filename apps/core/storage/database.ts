import { baselineSchema, schemaVersion } from "./schema";
import BetterSqlite3 from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { lstat, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { exists } from "../workspace/paths";
import { PersistedRecords } from "./records";
import { RepositoryRecordSchema, LEGACY_VIBESTAR_DB_NAME, VIBESTAR_DB_NAME } from "./contracts";
import { ViberSnapshots, loadViberSnapshotKey, viberSnapshotKeyPath } from "./viber-snapshots";
import {
  defaultSettings,
  AdeError,
  SettingsSchema,
  now,
  type Repository,
  type Settings,
} from "../domain";

export { VIBESTAR_DB_NAME, LEGACY_VIBESTAR_DB_NAME } from "./contracts";

const resolveDatabasePath = async (file: string): Promise<string | null> => {
  const followed = new Set<string>();
  for (;;) {
    const parent = await realpath(dirname(file));
    const path = join(parent, basename(file));
    if (followed.has(path)) {
      return null;
    }

    let target: string;
    try {
      target = await readlink(path);
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (code === "ENOENT" || code === "EINVAL") {
        return path;
      }

      throw error;
    }

    followed.add(path);
    // Resolve the parent on the next hop so relative targets keep filesystem .. semantics.
    file = isAbsolute(target) ? target : `${parent}${sep}${target}`;
  }
};

export class Database {
  private readonly connection: BetterSqlite3.Database;

  readonly records = new PersistedRecords(this);

  readonly viberSnapshots: ViberSnapshots;

  static open = async (path: string) => {
    let initialize = true;
    let hasSealedSnapshots = false;
    if (path !== ":memory:") {
      const activeFiles = [path, `${path}-wal`, `${path}-shm`, `${path}-journal`];
      const activeEntries = new Map<string, { dev: number; ino: number }>();

      for (const file of activeFiles) {
        try {
          const entry = await lstat(file);
          if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink > 1) {
            throw new AdeError(
              "isolation",
              `Database file ${file} must be a regular non-symlink file without hard links.`,
            );
          }

          activeEntries.set(file, { dev: entry.dev, ino: entry.ino });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
            throw e;
          }
        }
      }

      if (basename(path) === VIBESTAR_DB_NAME) {
        const activeParent = await realpath(dirname(path));
        const activePaths = new Set(activeFiles.map((file) => join(activeParent, basename(file))));
        const legacyDirs = [dirname(path)];
        try {
          const defaultOldDir = join(homedir(), ".akkco-ade", "state");
          if (defaultOldDir !== dirname(path)) {
            legacyDirs.push(defaultOldDir);
          }
        } catch {
          // Ignore homedir resolution failures
        }

        for (const dir of legacyDirs) {
          const legacyBase = join(dir, LEGACY_VIBESTAR_DB_NAME);

          const legacyFiles = [
            legacyBase,
            `${legacyBase}-wal`,
            `${legacyBase}-shm`,
            `${legacyBase}-journal`,
          ];

          for (const legacyFile of legacyFiles) {
            try {
              const legacyLstat = await lstat(legacyFile);
              if (legacyLstat.isSymbolicLink()) {
                const target = await resolveDatabasePath(legacyFile);
                if (target && activePaths.has(target)) {
                  throw new AdeError(
                    "isolation",
                    `Legacy database file ${legacyFile} must not be a symlink to the active database.`,
                  );
                }
              }

              for (const [activeFile, activeStat] of activeEntries) {
                if (
                  resolve(legacyFile) !== resolve(activeFile) &&
                  legacyLstat.dev === activeStat.dev &&
                  legacyLstat.ino === activeStat.ino
                ) {
                  throw new AdeError(
                    "isolation",
                    `Legacy database file ${legacyFile} shares an inode with active file ${activeFile}.`,
                  );
                }
              }
            } catch (e) {
              if (
                (e as NodeJS.ErrnoException).code !== "ENOENT" &&
                (e as NodeJS.ErrnoException).code !== "ENOTDIR"
              ) {
                throw e;
              }
            }
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
