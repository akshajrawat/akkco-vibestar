import { migrations } from "./migrations";
import BetterSqlite3 from "better-sqlite3";
import {
  defaultSettings,
  SettingsSchema,
  now,
  type Repository,
  type Task,
  type Settings,
} from "../domain";

export class Database {
  private readonly connection: BetterSqlite3.Database;
  constructor(path: string) {
    this.connection = new BetterSqlite3(path);
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
        this.connection.transaction(() => {
          this.connection.exec(migration.sql);
          this.run(
            "INSERT OR IGNORE INTO schema_migrations VALUES(?,?)",
            migration.version,
            now(),
          );
        })();
      }
    }
  }
  run = (sql: string, ...params: unknown[]) =>
    this.connection.prepare(sql).run(...params);
  all = <T extends object = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ) => this.connection.prepare(sql).all(...params) as T[];
  repositories = () =>
    this.all<{ data: string }>(
      "SELECT data FROM repositories ORDER BY owner,name",
    ).map((r) => JSON.parse(r.data) as Repository);
  repository = (id: string) => {
    const r = this.repositories().find((r) => r.id === id);
    if (!r) throw new Error("Repository is not registered");
    return r;
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
    this.all<{ data: string }>(
      "SELECT data FROM tasks ORDER BY created_at DESC",
    ).map((r) => JSON.parse(r.data) as Task);
  task = (id: string) => {
    const t = this.tasks().find((t) => t.id === id);
    if (!t) throw new Error("Task not found");
    return t;
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
    const row = this.all<{ value: string }>(
      "SELECT value FROM settings WHERE key='pipeline'",
    )[0];
    return row
      ? SettingsSchema.parse(JSON.parse(row.value))
      : structuredClone(defaultSettings);
  };
  saveSettings = (s: Settings) =>
    this.run(
      "INSERT INTO settings VALUES('pipeline',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      JSON.stringify(SettingsSchema.parse(s)),
    );
  artifact = (taskId: string, stage: number) => {
    const row = this.all<{ content: string }>(
      "SELECT content FROM task_artifacts WHERE task_id=? AND stage=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
      taskId,
      stage,
    )[0];
    if (!row) throw new Error(`No successful saved result for stage ${stage}`);
    return JSON.parse(row.content) as Record<string, unknown>;
  };
  recover = () => {
    this.connection.transaction(() => {
      this.run(
        "UPDATE agent_runs SET status='interrupted',ended_at=?,error='Execution core stopped; explicit retry required' WHERE status='running'",
        now(),
      );
      this.run(
        "UPDATE scheduled_agent_runs SET status='interrupted',ended_at=?,error='Execution core stopped; explicit retry required' WHERE status='running'",
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
          ].includes(t.status)
        ) {
          this.saveTask({
            ...t,
            status: "interrupted",
            updated_at: now(),
            error:
              "Execution stopped. Resume retries the interrupted stage using saved context.",
          });
        }
      }
    })();
  };
  detail = (id: string) => ({
    task: this.task(id),
    runs: this.all(
      "SELECT * FROM agent_runs WHERE task_id=? ORDER BY started_at",
      id,
    ),
    events: this.all(
      "SELECT * FROM (SELECT * FROM agent_events WHERE task_id=? ORDER BY id DESC LIMIT 2000) ORDER BY id",
      id,
    ),
    messages: this.all(
      "SELECT * FROM task_messages WHERE task_id=? ORDER BY created_at",
      id,
    ),
    artifacts: this.all(
      "SELECT * FROM task_artifacts WHERE task_id=? ORDER BY created_at",
      id,
    ),
    activity: this.all(
      "SELECT * FROM task_activity WHERE task_id=? ORDER BY id",
      id,
    ),
    tests: this.all(
      "SELECT * FROM test_runs WHERE task_id=? ORDER BY started_at",
      id,
    ),
  });
  close = () => this.connection.close();
}
