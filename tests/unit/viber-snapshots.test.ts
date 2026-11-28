import { randomUUID } from "node:crypto";
import {
  link,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  loadViberSnapshotKey,
  viberSnapshotKeyPath,
} from "../../apps/core/storage/viber-snapshots";

const filesystem = vi.hoisted(() => ({
  stage: vi.fn<(file: FileHandle) => void>(),
  publish: vi.fn<() => void>(),
}));

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    link: async (...args: Parameters<typeof fs.link>) => {
      filesystem.publish();
      return fs.link(...args);
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args);
      if (args[1] === "wx") {
        filesystem.stage(file);
      }

      return file;
    },
  };
});

let dir: string;
let keyPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibestar-snapshot-key-"));
  keyPath = viberSnapshotKeyPath(join(dir, "test.sqlite"));
});

afterEach(async () => {
  filesystem.stage.mockReset();
  filesystem.publish.mockReset();
  await rm(dir, { recursive: true, force: true });
});

it.each(["writeFile", "sync"] as const)("can retry after an interrupted key %s", async (method) => {
  filesystem.stage.mockImplementationOnce((file) => {
    vi.spyOn(file, method).mockImplementationOnce(async () => {
      if (method === "writeFile") {
        await file.write(Buffer.alloc(8));
      }

      throw new Error("interrupted key creation");
    });
  });

  await expect(loadViberSnapshotKey(keyPath, true)).rejects.toThrow("interrupted key creation");
  expect(await readdir(dir)).toEqual([]);

  const key = await loadViberSnapshotKey(keyPath, true);
  expect(key).toHaveLength(32);
  expect(await readFile(keyPath)).toEqual(key);
});

it("removes the staged key if publication fails", async () => {
  const error = Object.assign(new Error("cannot publish key"), { code: "ENOSPC" });

  filesystem.publish.mockImplementationOnce(() => {
    throw error;
  });

  await expect(loadViberSnapshotKey(keyPath, true)).rejects.toBe(error);
  expect(await readdir(dir)).toEqual([]);
});

it("publishes one synced key for concurrent creators", async () => {
  let markBothWriting = () => {};

  const bothWriting = new Promise<void>((resolve) => {
    markBothWriting = resolve;
  });

  let allowSync = () => {};

  const syncAllowed = new Promise<void>((resolve) => {
    allowSync = resolve;
  });

  let waiting = 0;

  filesystem.stage.mockImplementation((file) => {
    const sync = file.sync.bind(file);

    vi.spyOn(file, "sync").mockImplementation(async () => {
      waiting += 1;
      if (waiting === 2) {
        markBothWriting();
      }

      await syncAllowed;
      await sync();
    });
  });

  const creators = [loadViberSnapshotKey(keyPath, true), loadViberSnapshotKey(keyPath, true)];

  try {
    await Promise.race([bothWriting, ...creators]);
    expect(waiting).toBe(2);
    await expect(stat(keyPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(loadViberSnapshotKey(keyPath, false)).resolves.toBeUndefined();
  } finally {
    allowSync();
    await Promise.allSettled(creators);
  }

  const [first, second] = await Promise.all(creators);
  expect(first).toHaveLength(32);
  expect(second).toEqual(first);
  expect(await readFile(keyPath)).toEqual(first);
  expect(await readdir(dir)).toEqual(["test.sqlite.viber-key"]);
  const info = await stat(keyPath);
  expect(info.mode & 0o777).toBe(0o600);
  expect(info.nlink).toBe(1);
});

it("finishes a published key if the creator stops before removing its staging link", async () => {
  const staged = `${keyPath}.tmp-${randomUUID()}`;
  const key = Buffer.alloc(32, 42);
  await writeFile(staged, key, { mode: 0o600 });
  await link(staged, keyPath);

  await expect(loadViberSnapshotKey(keyPath, false)).resolves.toEqual(key);
  expect(await readdir(dir)).toEqual(["test.sqlite.viber-key"]);
  expect((await stat(keyPath)).nlink).toBe(1);
});

it("preserves a preexisting private key and rejects additional hard links", async () => {
  const key = Buffer.alloc(32, 42);
  await writeFile(keyPath, key, { mode: 0o600 });

  await expect(loadViberSnapshotKey(keyPath, true)).resolves.toEqual(key);

  const alias = `${keyPath}.tmp-backup`;
  await link(keyPath, alias);
  const otherStage = `${keyPath}.tmp-${randomUUID()}`;
  const otherKey = Buffer.alloc(32, 43);
  await writeFile(otherStage, otherKey, { mode: 0o600 });

  await expect(loadViberSnapshotKey(keyPath, true)).resolves.toBeUndefined();
  expect(await readFile(keyPath)).toEqual(key);
  expect(await readFile(alias)).toEqual(key);
  expect(await readFile(otherStage)).toEqual(otherKey);
});

it.each([0, 16])("preserves an existing incomplete key of %i bytes", async (size) => {
  const key = Buffer.alloc(size, 42);
  await writeFile(keyPath, key, { mode: 0o600 });

  await expect(loadViberSnapshotKey(keyPath, true)).resolves.toBeUndefined();
  expect(await readFile(keyPath)).toEqual(key);
});

it.each([0o644, 0o400])("rejects and preserves an existing key with mode %i", async (mode) => {
  const key = Buffer.alloc(32, 42);
  await writeFile(keyPath, key, { mode });

  await expect(loadViberSnapshotKey(keyPath, true)).resolves.toBeUndefined();
  expect(await readFile(keyPath)).toEqual(key);
  expect((await stat(keyPath)).mode & 0o777).toBe(mode);
});

it("rejects a symbolic link without replacing it", async () => {
  const key = Buffer.alloc(32, 42);
  const target = join(dir, "key-target");
  await writeFile(target, key, { mode: 0o600 });
  await symlink(target, keyPath);

  await expect(loadViberSnapshotKey(keyPath, true)).resolves.toBeUndefined();
  expect(await readFile(keyPath)).toEqual(key);
});
