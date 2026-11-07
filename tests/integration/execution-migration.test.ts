import { expect, it } from "vitest";
import Sqlite from "better-sqlite3";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "../../backend/storage/database";
import { migrations } from "../../backend/storage/migrations";

it("adds invocation snapshots without fabricating historical authority and backs up existing bytes before upgrade", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-execution-migration-"));
  const path = join(dir, "state.sqlite");
  const old = new Sqlite(path);
  for (const migration of migrations.filter((entry) => entry.version <= 27)) {
    old.exec(migration.sql);

    old
      .prepare("INSERT OR IGNORE INTO schema_migrations VALUES(?,?)")
      .run(migration.version, "before");
  }

  const corrupt = "{preserve these exact source bytes";
  old.prepare("INSERT INTO repositories VALUES('repo','fixture','fixture','{}')").run();

  old
    .prepare(
      "INSERT INTO tasks(id,repo_id,status,stage,data,created_at) VALUES('task','repo','awaiting_approval',3,?,'before')",
    )
    .run(corrupt);

  old
    .prepare(
      "INSERT INTO agent_runs(id,task_id,stage,provider,model,effort,prompt,status,started_at) VALUES('agent','task',3,'codex','old-model','high','old prompt','interrupted','before')",
    )
    .run();

  old
    .prepare(
      "INSERT INTO utility_runs(id,stage,provider,model,effort,prompt,status,started_at,purpose) VALUES('utility',1,'codex','old-model','high','old prompt','completed','before','utility')",
    )
    .run();

  old.prepare("INSERT INTO scheduled_jobs VALUES('job','{}')").run();

  old
    .prepare(
      "INSERT INTO scheduled_agent_runs(id,job_id,stage,provider,model,effort,prompt,status,started_at) VALUES('scheduled','job',1,'codex','old-model','high','old prompt','failed','before')",
    )
    .run();

  old.close();

  try {
    for (let iteration = 0; iteration < 2; iteration++) {
      const db = await Database.open(path);
      try {
        expect(db.all("SELECT data,status,stage FROM tasks")).toEqual([
          { data: corrupt, status: "awaiting_approval", stage: 3 },
        ]);

        for (const table of ["agent_runs", "utility_runs", "scheduled_agent_runs"]) {
          expect(db.all(`SELECT execution,prompt,model FROM ${table}`)).toEqual([
            { execution: null, prompt: "old prompt", model: "old-model" },
          ]);

          expect(() => db.run(`UPDATE ${table} SET execution='not json'`)).toThrow();
        }

        expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
      } finally {
        db.close();
      }
    }

    const backups = (await readdir(dir)).filter((name) => name.includes("before-v27"));
    expect(backups).toHaveLength(1);
    const backup = new Sqlite(join(dir, backups[0]), { readonly: true });
    try {
      expect(backup.prepare("SELECT data FROM tasks").get()).toEqual({ data: corrupt });

      expect(backup.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual(
        { version: 27 },
      );
    } finally {
      backup.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
