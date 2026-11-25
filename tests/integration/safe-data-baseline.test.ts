import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, expect, it } from "vitest";

import { Engine } from "../../apps/core/execution/engine";
import { dataRootChoice } from "../../apps/core/storage/bootstrap";
import { VIBESTAR_DB_NAME } from "../../apps/core/storage/contracts";
import { viberSnapshotKeyPath } from "../../apps/core/storage/viber-snapshots";
import { exists } from "../../apps/core/workspace/paths";

let testDirs: string[] = [];

const createTempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-test-baseline-"));
  testDirs.push(dir);
  return dir;
};

afterEach(async () => {
  for (const dir of testDirs) {
    await rm(dir, { recursive: true, force: true });
  }

  testDirs = [];
});

it("fresh startup initializes schema 0 in the active database", async () => {
  const root = await createTempDir();
  const engine = await Engine.create(root);

  try {
    expect(await exists(join(root, "state", VIBESTAR_DB_NAME))).toBe(true);
    expect(engine.db.all("SELECT version FROM schema_migrations")).toEqual([{ version: 0 }]);
    expect(engine.db.all("PRAGMA user_version")).toEqual([{ user_version: 0 }]);
    expect(engine.db.all("PRAGMA foreign_key_check")).toEqual([]);
  } finally {
    await engine.close();
  }
});

it("restart preserves data and the original schema 0 record", async () => {
  const root = await createTempDir();
  let engine = await Engine.create(root);
  let baseline: { version: number; applied_at: string }[];

  try {
    baseline = engine.db.all("SELECT version, applied_at FROM schema_migrations");

    engine.db.saveSettings({
      ...engine.db.displaySettings(),
      default_editor: "code",
    });
  } finally {
    await engine.close();
  }

  // Reopen engine on the exact same root
  engine = await Engine.create(root);

  try {
    const settings = engine.db.displaySettings();
    expect(settings.default_editor).toBe("code");
    expect(engine.db.all("SELECT version, applied_at FROM schema_migrations")).toEqual(baseline);

    expect(await exists(join(root, "state", VIBESTAR_DB_NAME))).toBe(true);
  } finally {
    await engine.close();
  }
});

it.each([
  { versions: [0], userVersion: 0, label: "an older schema 0" },
  { versions: [0, 45, 46, 47, 48], userVersion: 0, label: "the previous versioned schema" },
  { versions: [], userVersion: 48, label: "an empty database with a nonzero SQLite version" },
])("rejects $label without modifying the database", async ({ versions, userVersion }) => {
  const root = await createTempDir();
  const stateDir = join(root, "state");
  await mkdir(stateDir);
  const path = join(stateDir, VIBESTAR_DB_NAME);
  const sqlite = new BetterSqlite3(path);

  try {
    sqlite.pragma(`user_version = ${userVersion}`);
    if (versions.length) {
      sqlite.exec(`
        CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO settings VALUES('example', 'keep this data');
      `);

      for (const version of versions) {
        sqlite.prepare("INSERT INTO schema_migrations VALUES(?, CURRENT_TIMESTAMP)").run(version);
      }
    }
  } finally {
    sqlite.close();
  }

  const original = await readFile(path);

  await expect(Engine.create(root)).rejects.toMatchObject({
    kind: "migration",
    message: expect.stringContaining(
      `recorded versions: ${versions.join(", ") || "none"}, SQLite user_version: ${userVersion}`,
    ),
  });

  expect(await readFile(path)).toEqual(original);
  expect(await exists(viberSnapshotKeyPath(path))).toBe(false);
});

it("rejects invalid database paths such as symlinks, hard links, and directories", async () => {
  const root = await createTempDir();
  const stateDir = join(root, "state");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  const realTarget = join(root, "target.sqlite");
  await writeFile(realTarget, "");

  // Test symlink rejection
  const symlinkDb = join(stateDir, VIBESTAR_DB_NAME);
  await symlink(realTarget, symlinkDb);

  await expect(Engine.create(root)).rejects.toThrow(
    /must be a regular non-symlink file without hard links/,
  );

  // Clean symlink
  await rm(symlinkDb);

  // Test directory rejection
  await mkdir(symlinkDb, { mode: 0o700 });

  await expect(Engine.create(root)).rejects.toThrow(
    /must be a regular non-symlink file without hard links/,
  );

  await rm(symlinkDb, { recursive: true });

  // Test hard link rejection
  const sourceFile = join(root, "source.sqlite");
  await writeFile(sourceFile, "dummy");
  await link(sourceFile, symlinkDb);

  await expect(Engine.create(root)).rejects.toThrow(
    /must be a regular non-symlink file without hard links/,
  );
});

it("pauses startup and throws clear error if interrupted migration journal is detected", async () => {
  const root = await createTempDir();
  const runtimeDir = join(root, "runtime");
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });

  await writeFile(
    join(runtimeDir, "migration-pending.json"),
    JSON.stringify({ source: "/old", target: root }),
    "utf8",
  );

  await expect(dataRootChoice(root, root)).rejects.toThrow(
    /An interrupted migration needs recovery/,
  );
});
