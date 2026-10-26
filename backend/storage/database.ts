import { migrations } from "./migrations";
import {
  CommandExecutions,
  CommandEvidenceSchema,
} from "../execution/verification/command-executions";
import type { NormalizedEvent } from "../domain";
import BetterSqlite3 from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import { exists } from "../workspace/paths";
import { PersistedRecords } from "./records";
import { TaskRecordSchema, RepositoryRecordSchema } from "./contracts";
import {
  defaultSettings,
  AdeError,
  SettingsSchema,
  now,
  type Repository,
  type Task,
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
          ? (
              source.prepare("SELECT max(version) version FROM schema_migrations").get() as {
                version: number | null;
              }
            ).version || 0
          : 0;
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
          if (rebuild) this.connection.pragma("foreign_keys = OFF");
          try {
            this.connection.transaction(() => {
              this.connection.exec(migration.sql);
              this.run(
                "INSERT OR IGNORE INTO schema_migrations VALUES(?,?)",
                migration.version,
                now(),
              );
              if (migration.version === 16) {
                const commands = new CommandExecutions(this);
                for (const event of this.all<{
                  task_id: string;
                  run_id: string;
                  kind: NormalizedEvent["kind"];
                  data: string;
                  id: number;
                  timestamp: string;
                }>(
                  "SELECT id,task_id,run_id,kind,data,timestamp FROM agent_events WHERE kind LIKE 'command.%' ORDER BY id",
                )) {
                  const data = this.records.tryDecode(
                    {
                      table: "agent_events",
                      id: event.id,
                      column: "data",
                      source: event.data,
                    },
                    CommandEvidenceSchema.parse,
                  );
                  if (!data) continue;
                  commands.observe(
                    event.task_id,
                    event.run_id,
                    {
                      kind: event.kind,
                      data,
                    },
                    event.timestamp,
                  );
                }
                for (const run of this.all<{ id: string; ended_at: string }>(
                  "SELECT id,ended_at FROM agent_runs WHERE status!='running'",
                ))
                  commands.finish(run.id, run.ended_at || now());
              }
              if (this.all("PRAGMA foreign_key_check").length)
                throw new Error("Repository migration failed foreign key verification");
            })();
          } finally {
            if (rebuild) this.connection.pragma("foreign_keys = ON");
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
  repository = (id: string) => {
    const row = this.all<{ data: string }>("SELECT data FROM repositories WHERE id=?", id)[0];
    if (!row) throw new Error("Repository is not registered");
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
  tasks = () =>
    this.records.list<Task>(
      "tasks",
      this.all<{ id: string; data: string }>("SELECT id,data FROM tasks ORDER BY created_at DESC"),
      TaskRecordSchema.parse,
      "id",
    );
  task = (id: string) => {
    const row = this.all<{ data: string }>("SELECT data FROM tasks WHERE id=?", id)[0];
    if (!row) throw new Error("Task not found");
    return this.records.decode<Task>(
      {
        table: "tasks",
        id,
        column: "data",
        source: row.data,
        identity: "id",
      },
      TaskRecordSchema.parse,
    );
  };
  assertOwnershipRecords = () => {
    if (
      this.tasks().length !== this.all("SELECT id FROM tasks").length ||
      this.repositories().length !== this.all("SELECT id FROM repositories").length
    )
      throw new AdeError(
        "corrupt_record",
        "Saved workspace ownership records are corrupt. Preserve the data root and inspect persistence diagnostics before cleanup or migration.",
      );
  };
  saveTask = (t: Task) =>
    this.run(
      "INSERT INTO tasks(id,repo_id,status,stage,data,created_at,scope_mode) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,stage=excluded.stage,data=excluded.data,scope_mode=excluded.scope_mode",
      t.id,
      t.repo_id,
      t.status,
      t.stage,
      JSON.stringify(t),
      t.created_at,
      t.scope_mode || "partial",
    );
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
      if (error instanceof AdeError && error.kind === "corrupt_record")
        return structuredClone(defaultSettings);
      throw error;
    }
  };
  saveSettings = (s: Settings) =>
    this.run(
      "INSERT INTO settings VALUES('pipeline',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      JSON.stringify(SettingsSchema.parse(s)),
    );
  artifact = (taskId: string, stage: number) => {
    const row = this.all<{ id: string; content: string }>(
      "SELECT id,content FROM task_artifacts WHERE task_id=? AND stage=? AND kind='plan' ORDER BY created_at DESC,rowid DESC LIMIT 1",
      taskId,
      stage,
    )[0];
    if (!row) throw new Error(`No successful saved result for stage ${stage}`);
    return this.records.decode({
      table: "task_artifacts",
      id: row.id,
      column: "content",
      source: row.content,
    });
  };
  recover = () => {
    this.connection.transaction(() => {
      this.run(
        "UPDATE pr_analyses SET status='interrupted',ended_at=?,data=CASE WHEN json_valid(data) THEN json_set(data,'$.phase','Analysis interrupted — explicit retry required','$.error','The core restarted during PR analysis. Previous reports are preserved; Analyze Again explicitly.') ELSE data END WHERE status='running'",
        now(),
      );
      this.run(
        "UPDATE agent_runs SET status='interrupted',ended_at=?,error='Execution core stopped; explicit retry required' WHERE status='running'",
        now(),
      );
      this.run(
        "UPDATE scheduled_agent_runs SET status='interrupted',ended_at=?,error='Execution core stopped; explicit retry required' WHERE status='running'",
        now(),
      );
      this.run(
        "UPDATE utility_runs SET status='interrupted',ended_at=? WHERE status='running'",
        now(),
      );
      this.run(
        "UPDATE code_questions SET status='interrupted',error='Execution interrupted. Ask again to retry.' WHERE status='running'",
      );
      this.run(
        "UPDATE task_messages SET status='chat_interrupted' WHERE purpose='chat' AND status='chat_pending'",
      );
      this.run(
        "UPDATE ai_usage SET status='interrupted',ended_at=?,duration_ms=CAST((julianday(?) - julianday(started_at))*86400000 AS INTEGER) WHERE status='running'",
        now(),
        now(),
      );
      this.run(
        "UPDATE test_runs SET status='interrupted',ended_at=? WHERE status='running'",
        now(),
      );
      this.run(
        "UPDATE terminal_sessions SET status='interrupted',ended_at=? WHERE status='running'",
        now(),
      );
      for (const t of this.tasks()) {
        if (
          [
            "preparing",
            "planning_antigravity",
            "planning_codex",
            "implementing",
            "validating",
            "reviewing_antigravity",
          ].includes(t.status)
        ) {
          this.saveTask({
            ...t,
            status: "interrupted",
            updated_at: now(),
            error: "Execution stopped. Resume retries the interrupted stage using saved context.",
          });
        }
      }
    })();
  };
  detail = (id: string) => ({
    task: this.task(id),
    runs: this.all("SELECT * FROM agent_runs WHERE task_id=? ORDER BY started_at", id),
    events: this.all(
      "SELECT * FROM (SELECT * FROM agent_events WHERE task_id=? ORDER BY id DESC LIMIT 2000) ORDER BY id",
      id,
    ),
    messages: this.all("SELECT * FROM task_messages WHERE task_id=? ORDER BY created_at", id),
    artifacts: this.all("SELECT * FROM task_artifacts WHERE task_id=? ORDER BY created_at", id),
    activity: this.all("SELECT * FROM task_activity WHERE task_id=? ORDER BY id", id),
    usage: this.all("SELECT * FROM ai_usage WHERE task_id=? ORDER BY started_at", id),
    tests: this.all("SELECT * FROM test_runs WHERE task_id=? ORDER BY started_at,rowid", id),
  });
  close = () => {
    if (this.connection.open) this.connection.close();
  };
}
