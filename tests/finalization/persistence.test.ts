import { expect, it } from "vitest";
import Sqlite from "better-sqlite3";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../backend/storage/database";
import { migrations } from "../../backend/storage/migrations";
import { defaultSettings } from "../../backend/domain";

it("backs up version 23 before adding Git history and preserves existing task, PR and usage data across reopening", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibestar-finalization-migration-"));
  const path = join(root, "state.sqlite");
  const legacyTask = JSON.stringify({
    id: "task",
    repo_id: "repo",
    stage: 6,
    status: "completed",
    issue_body: "Original task and exact retained context\n",
  });
  const old = new Sqlite(path);
  try {
    for (const migration of migrations.filter((item) => item.version <= 23)) {
      old.exec(migration.sql);
      old
        .prepare("INSERT OR IGNORE INTO schema_migrations VALUES(?,?)")
        .run(migration.version, "before");
    }
    old.prepare("INSERT INTO settings VALUES('pipeline',?)").run(JSON.stringify(defaultSettings));
    old.prepare("INSERT INTO repositories VALUES('repo','owner','project','{}')").run();
    old
      .prepare(
        "INSERT INTO tasks(id,repo_id,status,stage,data,created_at,scope_mode) VALUES('task','repo','completed',6,?,'before','whole_issue')",
      )
      .run(legacyTask);
    old
      .prepare("INSERT INTO task_artifacts VALUES('review','task',5,'plan',?,'before')")
      .run('{"summary":"Retained review"}');
    old
      .prepare("INSERT INTO scheduled_jobs VALUES('pr',?)")
      .run('{"id":"pr","enabled":false,"status":"idle"}');
    old
      .prepare(
        "INSERT INTO ai_usage(id,job_id,purpose,provider,model,effort,started_at,status,input_tokens) VALUES('usage','pr','PR Review Analysis','codex','saved-model','high','before','completed',123)",
      )
      .run();
  } finally {
    old.close();
  }
  try {
    for (let iteration = 0; iteration < 2; iteration++) {
      const db = await Database.open(path);
      try {
        expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
        expect(db.all("SELECT data,scope_mode FROM tasks")).toEqual([
          { data: legacyTask, scope_mode: "whole_issue" },
        ]);
        expect(db.all("SELECT content FROM task_artifacts")).toEqual([
          { content: '{"summary":"Retained review"}' },
        ]);
        expect(db.all("SELECT input_tokens FROM ai_usage")).toEqual([{ input_tokens: 123 }]);
        expect(db.all("SELECT data FROM scheduled_jobs")).toEqual([
          { data: '{"id":"pr","enabled":false,"status":"idle"}' },
        ]);
        expect(db.settings()).toEqual(defaultSettings);
        for (const table of ["git_finalizations", "git_operation_events", "task_git_presets"])
          expect(db.all(`SELECT * FROM ${table}`)).toEqual([]);
        expect(() => db.run("INSERT INTO task_git_presets VALUES('missing','{}')")).toThrow();
      } finally {
        db.close();
      }
    }
    const backups = (await readdir(root)).filter((name) => name.includes(".before-v23-"));
    expect(backups).toHaveLength(1);
    const backupPath = join(root, backups[0]);
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
    const backup = new Sqlite(backupPath, { readonly: true });
    try {
      expect(backup.prepare("SELECT max(version) version FROM schema_migrations").get()).toEqual({
        version: 23,
      });
      expect(backup.prepare("SELECT data FROM tasks").get()).toEqual({
        data: legacyTask,
      });
      expect(
        backup.prepare("SELECT name FROM sqlite_master WHERE name='git_finalizations'").get(),
      ).toBeUndefined();
    } finally {
      backup.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
