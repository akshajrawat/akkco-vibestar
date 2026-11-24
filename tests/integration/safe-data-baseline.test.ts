import { createHash, randomUUID } from "node:crypto";
import { lstat, link, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";

import { Engine } from "../../apps/core/execution/engine";
import { Rpc } from "../../apps/core/rpc";
import { dataRootChoice } from "../../apps/core/storage/bootstrap";
import { LEGACY_VIBESTAR_DB_NAME, VIBESTAR_DB_NAME } from "../../apps/core/storage/contracts";
import { exists } from "../../apps/core/workspace/paths";

const fixture = vi.hoisted(() => ({ home: "" }));

vi.mock("node:os", async (original) => {
  const module = await original<typeof import("node:os")>();
  return { ...module, homedir: () => fixture.home || module.homedir() };
});

let testDirs: string[] = [];

const createTempDir = async () => {
  const dir = join(process.cwd(), "out", "test-baseline-" + randomUUID());
  await mkdir(dir, { recursive: true, mode: 0o700 });
  testDirs.push(dir);
  return dir;
};

afterEach(async () => {
  for (const dir of testDirs) {
    await rm(dir, { recursive: true, force: true });
  }

  testDirs = [];
});

it("fresh startup initializes only versioned database without creating legacy file", async () => {
  const root = await createTempDir();
  const engine = await Engine.create(root);
  const rpc = new Rpc(engine);

  try {
    const v1Path = join(root, "state", VIBESTAR_DB_NAME);
    const legacyPath = join(root, "state", LEGACY_VIBESTAR_DB_NAME);

    expect(await exists(v1Path)).toBe(true);
    expect(await exists(legacyPath)).toBe(false);

    const snapshot = (await rpc.call("snapshot", {})) as {
      root: string;
      fresh_start?: { detected: boolean; legacy_paths: string[]; message: string };
    };

    expect(snapshot.root).toBe(root);
    expect(snapshot.fresh_start).toBeUndefined();
  } finally {
    await rpc.close();
    await engine.close();
  }
});

it("restart preserves data in versioned database across reopens", async () => {
  const root = await createTempDir();
  let engine = await Engine.create(root);
  let rpc = new Rpc(engine);

  try {
    engine.db.saveSettings({
      ...engine.db.displaySettings(),
      default_editor: "code",
    });
  } finally {
    await rpc.close();
    await engine.close();
  }

  // Reopen engine on the exact same root
  engine = await Engine.create(root);
  rpc = new Rpc(engine);

  try {
    const settings = engine.db.displaySettings();
    expect(settings.default_editor).toBe("code");

    const v1Path = join(root, "state", VIBESTAR_DB_NAME);
    const legacyPath = join(root, "state", LEGACY_VIBESTAR_DB_NAME);
    expect(await exists(v1Path)).toBe(true);
    expect(await exists(legacyPath)).toBe(false);
  } finally {
    await rpc.close();
    await engine.close();
  }
});

it("preserves legacy database and repository files byte-for-byte untouched and shows clear notice", async () => {
  const root = await createTempDir();
  const stateDir = join(root, "state");
  const reposDir = join(root, "repos");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(reposDir, { recursive: true, mode: 0o700 });

  // 1. Create synthetic legacy database with custom tables and records
  const legacyDbPath = join(stateDir, LEGACY_VIBESTAR_DB_NAME);
  const legacySqlite = new BetterSqlite3(legacyDbPath);

  legacySqlite.exec(
    "CREATE TABLE legacy_user_secrets (id TEXT PRIMARY KEY, secret_key TEXT NOT NULL);",
  );

  legacySqlite.exec(
    "INSERT INTO legacy_user_secrets (id, secret_key) VALUES ('user-1', 'super-confidential-secret-987');",
  );

  legacySqlite.close();

  // 2. Create synthetic dummy repo files
  const dummyRepoFile = join(reposDir, "dummy-repo.txt");
  await writeFile(dummyRepoFile, "original repo file content untouched", "utf8");

  // 3. Compute baseline metrics before engine launch
  const initialBytes = await readFile(legacyDbPath);
  const initialHash = createHash("sha256").update(initialBytes).digest("hex");
  const initialStat = await lstat(legacyDbPath);
  const initialRepoBytes = await readFile(dummyRepoFile);

  // 4. Start Engine on this root containing legacy data
  let engine = await Engine.create(root);
  let rpc = new Rpc(engine);

  try {
    const v1DbPath = join(stateDir, VIBESTAR_DB_NAME);
    expect(await exists(v1DbPath)).toBe(true);

    // 5. Verify snapshot exposes fresh_start notice pointing to the preserved legacy database
    const snapshot = (await rpc.call("snapshot", {})) as {
      fresh_start?: { detected: boolean; legacy_paths: string[]; message: string };
    };

    expect(snapshot.fresh_start).toBeDefined();
    expect(snapshot.fresh_start?.detected).toBe(true);
    expect(snapshot.fresh_start?.legacy_paths).toContain(legacyDbPath);

    expect(snapshot.fresh_start?.message).toContain(
      "Vibestar started with a fresh database baseline",
    );

    expect(snapshot.fresh_start?.message).toContain(legacyDbPath);

    // 6. Verify legacy database remains byte-for-byte identical after engine startup
    const afterStartBytes = await readFile(legacyDbPath);
    const afterStartHash = createHash("sha256").update(afterStartBytes).digest("hex");
    const afterStartStat = await lstat(legacyDbPath);

    expect(afterStartHash).toBe(initialHash);
    expect(afterStartStat.size).toBe(initialStat.size);
    expect(afterStartStat.mtimeMs).toBe(initialStat.mtimeMs);

    // 7. Verify dummy repository files are untouched
    expect(await readFile(dummyRepoFile)).toEqual(initialRepoBytes);

    // 8. Verify legacy DB contains ONLY its original tables, no engine schema added
    const readLegacy = new BetterSqlite3(legacyDbPath, { readonly: true });
    try {
      const tables = readLegacy
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[];

      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain("legacy_user_secrets");
      expect(tableNames).not.toContain("schema_migrations");
      expect(tableNames).not.toContain("agent_profiles");
      expect(tableNames).not.toContain("viber_sessions");
    } finally {
      readLegacy.close();
    }

    // 9. Perform writes to new active database
    engine.db.saveSettings({
      ...engine.db.displaySettings(),
      default_editor: "code",
    });

    // 10. Verify legacy database is still 100% untouched after active writes
    const afterWriteBytes = await readFile(legacyDbPath);
    expect(createHash("sha256").update(afterWriteBytes).digest("hex")).toBe(initialHash);
  } finally {
    await rpc.close();
    await engine.close();
  }

  // 11. Test restart with legacy data present
  engine = await Engine.create(root);
  rpc = new Rpc(engine);

  try {
    // Notice still returned on restart
    const restartSnapshot = (await rpc.call("snapshot", {})) as {
      fresh_start?: { detected: boolean; legacy_paths: string[]; message: string };
    };

    expect(restartSnapshot.fresh_start?.detected).toBe(true);

    // Legacy file still untouched
    const afterRestartBytes = await readFile(legacyDbPath);
    expect(createHash("sha256").update(afterRestartBytes).digest("hex")).toBe(initialHash);
  } finally {
    await rpc.close();
    await engine.close();
  }
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

it("rejects alias and symlinks from legacy database pointing to active database", async () => {
  const root = await createTempDir();
  const stateDir = join(root, "state");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  // Create legacy database as symlink pointing to active database path (which does not exist yet)
  const legacyDb = join(stateDir, LEGACY_VIBESTAR_DB_NAME);
  const activeDb = join(stateDir, VIBESTAR_DB_NAME);
  await symlink(activeDb, legacyDb);

  await expect(Engine.create(root)).rejects.toThrow(
    /Legacy database file .* must not be a symlink to the active database/,
  );
});

it("rejects reverse symlink from active database pointing to legacy database", async () => {
  const root = await createTempDir();
  const stateDir = join(root, "state");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  // Create legacy file
  const legacyDb = join(stateDir, LEGACY_VIBESTAR_DB_NAME);
  await writeFile(legacyDb, "dummy legacy data");

  // Create active DB as symlink pointing to legacy DB
  const activeDb = join(stateDir, VIBESTAR_DB_NAME);
  await symlink(legacyDb, activeDb);

  await expect(Engine.create(root)).rejects.toThrow(
    /Database file .* must be a regular non-symlink file without hard links/,
  );
});

it("handles malformed legacy location ~/.akkco-ade as regular file without breaking snapshot", async () => {
  const root = await createTempDir();
  const fakeHome = await createTempDir();
  await writeFile(join(fakeHome, ".akkco-ade"), "synthetic regular file instead of dir");
  fixture.home = fakeHome;

  try {
    const engine = await Engine.create(root);
    const rpc = new Rpc(engine);

    try {
      const snapshot = (await rpc.call("snapshot", {})) as {
        root: string;
        fresh_start?: { detected: boolean; legacy_paths: string[]; message: string };
      };

      expect(snapshot.root).toBe(root);
      expect(snapshot.fresh_start).toBeUndefined();
    } finally {
      await rpc.close();
      await engine.close();
    }
  } finally {
    fixture.home = "";
  }
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
