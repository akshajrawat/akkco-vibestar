import { afterEach, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, readdir, readFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import Sqlite from "better-sqlite3";
import { Database } from "../../backend/storage/database";
import { migrations } from "../../backend/storage/migrations";
import { StorageService } from "../../backend/storage/service";
import { migrateDataRoot } from "../../backend/storage/migrate-root";
import { createLayout, exists } from "../../backend/workspace/paths";
import { Rpc } from "../../backend/rpc";
import {
  createFixtureEngine,
  fixtureRepository,
  prepareFixtureTask,
} from "../fixtures";
import { repairFixture } from "../pr-repair/fixtures";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const directory = async () => {
  const path = await mkdtemp(join(tmpdir(), "vibestar-record-recovery-"));
  directories.push(path);
  return path;
};
const legacyDatabase = (path: string, version: number) => {
  const db = new Sqlite(path);
  for (const migration of migrations.filter(
    (migration) => migration.version <= version,
  )) {
    db.exec(migration.sql);
    db.prepare("INSERT OR IGNORE INTO schema_migrations VALUES(?,?)").run(
      migration.version,
      "fixture",
    );
  }
  return db;
};

it("keeps healthy task/PR history accessible after restart, diagnoses corrupt records and blocks unsafe owners without replacing source bytes", async () => {
  const dir = await directory();
  const root = join(dir, "data");
  const forbiddenProvider = () => {
    throw new Error("Persistence recovery must not invoke providers");
  };
  let engine = await createFixtureEngine(root, forbiddenProvider);
  let rpc: Rpc | undefined;
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const good = await prepareFixtureTask(engine, repo, "healthy");
    const bad = await prepareFixtureTask(engine, repo, "corrupt");
    const raw = "{fake-source-bytes sk-fixturecredential123456";
    engine.db.run("UPDATE tasks SET data=? WHERE id=?", raw, bad.id);
    const badRepo = randomUUID();
    engine.db.run(
      "INSERT INTO repositories VALUES(?,?,?,?)",
      badRepo,
      "fixture",
      "broken",
      "null",
    );
    const badJob = randomUUID();
    engine.db.run(
      "INSERT INTO scheduled_jobs VALUES(?,?)",
      badJob,
      JSON.stringify({ id: badJob, action: {} }),
    );
    engine.db.run(
      "INSERT INTO local_repositories VALUES('/fixture/bad','[]','fixture')",
    );
    engine.db.run(
      "INSERT INTO github_repositories VALUES(1,'fixture/bad','{broken','fixture')",
    );
    const repair = await repairFixture(engine, dir);
    engine.db.run(
      "INSERT INTO settings VALUES('pipeline',?)",
      "{invalid settings",
    );
    const corruptRepair = randomUUID();
    engine.db.run(
      "INSERT INTO pr_repairs VALUES(?,?,?,?,?,?,?,?)",
      corruptRepair,
      repair.session.job_id,
      repair.repo.id,
      repair.session.analysis_id,
      "preparing",
      "{corrupt repair",
      "fixture",
      "fixture",
    );
    const publication = randomUUID();
    engine.db.run(
      "INSERT INTO repair_publications VALUES(?,?,'pushing',?,'fixture','fixture')",
      publication,
      repair.session.id,
      "{corrupt publication",
    );
    await engine.close();
    engine = await createFixtureEngine(root, forbiddenProvider);
    rpc = new Rpc(engine);
    await rpc.repairs.detail(repair.session.id);
    const snapshot = (await rpc.call("snapshot", {})) as {
      tasks: { id: string }[];
      repairs: { id: string }[];
      warning: string;
    };
    expect(snapshot.tasks.map((task) => task.id)).toContain(good.id);
    expect(snapshot.tasks.map((task) => task.id)).not.toContain(bad.id);
    expect(snapshot.repairs.map((session) => session.id)).toContain(
      repair.session.id,
    );
    expect(snapshot.repairs.map((session) => session.id)).not.toContain(
      corruptRepair,
    );
    expect(snapshot.warning).toContain("Original data is preserved");
    const diagnostics = engine.db.records.diagnostics();
    expect(new Set(diagnostics.map((record) => record.table_name))).toEqual(
      new Set([
        "tasks",
        "repositories",
        "scheduled_jobs",
        "settings",
        "local_repositories",
        "github_repositories",
        "pr_repairs",
        "repair_publications",
      ]),
    );
    expect(
      diagnostics.find((record) => record.record_id === bad.id)?.source_hash,
    ).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(JSON.stringify(diagnostics)).not.toContain("fixturecredential");
    expect(
      engine.db.all<{ data: string }>(
        "SELECT data FROM tasks WHERE id=?",
        bad.id,
      )[0].data,
    ).toBe(raw);
    expect(() => engine.db.task(bad.id)).toThrow("could not be decoded safely");
    expect(() => engine.db.settings()).toThrow("could not be decoded safely");
    await engine.drain();
    expect(engine.db.all("SELECT * FROM ai_usage")).toEqual([]);
    const storage = new StorageService(engine);
    await expect(
      storage.cleanupTask(bad.id, {
        worktree: true,
        logs: true,
        artifacts: true,
        history: true,
      }),
    ).rejects.toThrow("could not be decoded safely");
    await expect(storage.removeRepository(repo.id)).rejects.toThrow(
      "could not be decoded safely",
    );
    await expect(storage.reset()).rejects.toThrow(
      "ownership records are corrupt",
    );
    expect(await readFile(join(bad.worktree_path, "source.txt"), "utf8")).toBe(
      "base\n",
    );
    await rpc.close();
    rpc = undefined;
    await engine.close();
    await expect(migrateDataRoot(root, join(dir, "new"))).rejects.toThrow(
      "ownership records are corrupt",
    );
    expect(await readFile(join(bad.worktree_path, "source.txt"), "utf8")).toBe(
      "base\n",
    );
    expect(await exists(join(root, "state", "vibestar.sqlite"))).toBe(true);
  } finally {
    await rpc?.close();
    await engine.close();
  }
}, 30000);

it("backs up an old database, skips only malformed command evidence and preserves good backfill with foreign keys", async () => {
  const dir = await directory();
  const path = join(dir, "legacy.sqlite");
  const old = legacyDatabase(path, 15);
  old.exec(
    "INSERT INTO repositories VALUES('repo','fixture','fixture','{}');INSERT INTO tasks(id,repo_id,status,stage,data,created_at) VALUES('task','repo','completed',6,'{\"id\":\"task\"}','fixture');INSERT INTO agent_runs(id,task_id,stage,provider,model,effort,prompt,status,started_at) VALUES('run','task',3,'fixture','','high','','completed','fixture');",
  );
  const insert = old.prepare(
    "INSERT INTO agent_events(run_id,task_id,timestamp,kind,data,raw,stream) VALUES('run','task','fixture',?,?,'','stdout')",
  );
  insert.run("command.started", "{invalid evidence");
  insert.run(
    "command.started",
    JSON.stringify({ call_id: { toString: null }, command: "poisoned" }),
  );
  insert.run(
    "command.finished",
    JSON.stringify({
      call_id: "poisoned-status",
      command: "poisoned",
      status: { toString: null },
    }),
  );
  insert.run(
    "command.started",
    JSON.stringify({ call_id: "healthy", command: "fixture test" }),
  );
  insert.run(
    "command.finished",
    JSON.stringify({ call_id: "healthy", exit_code: 0, stdout: "passed" }),
  );
  old.close();
  const db = await Database.open(path);
  try {
    expect(db.detail("task").tests).toMatchObject([
      { status: "passed", stdout: "passed" },
    ]);
    expect(
      db.all<{ data: string }>("SELECT data FROM agent_events WHERE id=1")[0]
        .data,
    ).toBe("{invalid evidence");
    expect(db.records.diagnostics().map((record) => record.record_id)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    const backup = (await readdir(dirname(path))).find((name) =>
      name.startsWith("legacy.sqlite.before-v15-"),
    )!;
    expect((await stat(join(dir, backup))).mode & 0o777).toBe(0o600);
    const before = new Sqlite(join(dir, backup), { readonly: true });
    try {
      expect(
        before
          .prepare("SELECT max(version) version FROM schema_migrations")
          .get(),
      ).toEqual({ version: 15 });
      expect(
        before.prepare("SELECT data FROM agent_events WHERE id=1").get(),
      ).toEqual({ data: "{invalid evidence" });
    } finally {
      before.close();
    }
  } finally {
    db.close();
  }
});

it("upgrades malformed legacy task, repository, settings and schedule JSON without rewriting the bad values", async () => {
  const dir = await directory();
  const path = join(dir, "old.sqlite");
  const old = legacyDatabase(path, 5);
  old.exec(
    "INSERT INTO repositories VALUES('repo','fixture','fixture','{bad repository');INSERT INTO tasks VALUES('task','repo','completed',5,'{bad task','fixture');INSERT INTO scheduled_jobs VALUES('job','{bad job');INSERT INTO settings VALUES('github_watch','{bad watch');",
  );
  old.close();
  const db = await Database.open(path);
  try {
    expect(db.repositories()).toEqual([]);
    expect(db.tasks()).toEqual([]);
    expect(db.all("SELECT data FROM repositories")).toEqual([
      { data: "{bad repository" },
    ]);
    expect(db.all("SELECT data FROM tasks")).toEqual([{ data: "{bad task" }]);
    expect(db.all("SELECT data FROM scheduled_jobs")).toEqual([
      { data: "{bad job" },
    ]);
    expect(
      db.all("SELECT value FROM settings WHERE key='github_watch'"),
    ).toEqual([{ value: "{bad watch" }]);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  } finally {
    db.close();
  }
});

it("rolls back an invalid foreign-key rebuild, preserves its backup and releases the core lock after startup failure", async () => {
  const dir = await directory();
  const root = await createLayout(join(dir, "data"));
  const path = join(root, "state", "vibestar.sqlite");
  const old = legacyDatabase(path, 19);
  old.pragma("foreign_keys = OFF");
  old.exec(
    "INSERT INTO agent_runs(id,task_id,stage,provider,model,effort,prompt,status,started_at) VALUES('dangling','missing',3,'fixture','','high','','completed','fixture');",
  );
  old.close();
  for (let attempt = 0; attempt < 2; attempt++)
    await expect(createFixtureEngine(root)).rejects.toThrow(
      "foreign key verification",
    );
  const unchanged = new Sqlite(path, { readonly: true });
  try {
    expect(
      unchanged
        .prepare("SELECT max(version) version FROM schema_migrations")
        .get(),
    ).toEqual({ version: 19 });
    expect(
      unchanged
        .prepare("SELECT task_id FROM agent_runs WHERE id='dangling'")
        .get(),
    ).toEqual({ task_id: "missing" });
    expect(
      unchanged
        .prepare("PRAGMA table_info(agent_runs)")
        .all()
        .some((column) => (column as { name: string }).name === "repair_id"),
    ).toBe(false);
    expect(
      (await readdir(dirname(path))).filter((name) =>
        name.includes("before-v19-"),
      ).length,
    ).toBe(2);
  } finally {
    unchanged.close();
  }
});
