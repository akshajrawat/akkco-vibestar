import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultSettings, now, SettingsSchema } from "../../backend/domain";
import { Rpc } from "../../backend/rpc";
import { randomUUID } from "node:crypto";
import { checked } from "../../backend/execution/runtime/process";
import { createFixtureEngine } from "../helpers/fixtures";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const repository = async (path: string) => {
  await mkdir(path, { recursive: true });
  await checked("git", ["init", "-b", "main"], path);
  await checked("git", ["config", "user.name", "Fixture"], path);
  await checked("git", ["config", "user.email", "fixture@example.invalid"], path);
  await writeFile(join(path, "source.txt"), "fixture\n");
  await checked("git", ["add", "."], path);
  await checked("git", ["commit", "-m", "fixture"], path);
  await checked("git", ["remote", "add", "origin", "https://github.com/fixture/project.git"], path);
  return path;
};

it("leaves broad home discovery off for new and legacy settings without discovery configuration", () => {
  expect(defaultSettings.repository_discovery.scan_home).toBe(false);
  const legacy: Partial<typeof defaultSettings> = { ...defaultSettings };
  delete legacy.repository_discovery;
  expect(SettingsSchema.parse(legacy).repository_discovery.scan_home).toBe(false);
});

it("skips transient and generated trees, deduplicates aliases, and honors an explicit unusual location", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-discovery-"));
  directories.push(dir);
  const engine = await createFixtureEngine(join(dir, "data"));
  try {
    const locations = join(dir, "projects");
    const source = await repository(join(locations, "project"));
    const unusual = await repository(join(locations, "tmp", "legitimate-project"));
    await repository(join(locations, "tmp", "vibestar-chat-workspace-fixture", "upstream"));
    await repository(join(locations, "node_modules", "generated"));
    await repository(join(locations, "test-results", "checkout"));
    await symlink(source, join(locations, "alias"));

    engine.db.saveSettings({
      ...defaultSettings,
      repository_discovery: { roots: [locations, source], max_depth: 5, scan_home: false },
    });

    expect((await engine.repositoryIndex.scan()).repositories.map((r) => r.path)).toEqual([source]);

    expect(
      (await engine.repositoryIndex.verifyLocal({ environment: "wsl", path: unusual })).path,
    ).toBe(unusual);

    engine.db.saveSettings({
      ...defaultSettings,
      repository_discovery: { roots: [locations, unusual], max_depth: 5, scan_home: false },
    });

    expect((await engine.repositoryIndex.scan()).repositories.map((r) => r.path)).toEqual([
      source,
      unusual,
    ]);
  } finally {
    await engine.close();
  }
});

it("excludes managed clones and linked worktrees even when a linked worktree lives outside the data root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-discovery-owned-"));
  directories.push(dir);
  const engine = await createFixtureEngine(join(dir, "data"));
  try {
    const managed = await repository(join(engine.root, "repos", "fixture"));

    const registered = {
      id: randomUUID(),
      owner: "fixture",
      name: "project",
      path: managed,
      upstream_url: "https://github.com/fixture/project.git",
      origin_url: null,
      base_branch: "main",
      source: "managed" as const,
      connected: true,
      created_at: now(),
      last_fetched: null,
    };

    engine.db.saveRepository(registered);
    const alias = join(dir, "managed-alias");
    await symlink(managed, alias);
    const rpc = new Rpc(engine);

    expect(
      await rpc.call("repository.locateLocal", { environment: "wsl", path: alias }),
    ).toMatchObject({ id: registered.id, path: managed, source: "managed" });

    await expect(
      rpc.call("repository.locateLocal", { environment: "wsl", path: alias, allowManaged: true }),
    ).rejects.toThrow();

    const linked = join(dir, "projects", "ordinary-name");
    await mkdir(join(dir, "projects"));
    await checked("git", ["worktree", "add", "-b", "task", linked], managed);

    engine.db.saveSettings({
      ...defaultSettings,
      repository_discovery: { roots: [dir, managed], max_depth: 5, scan_home: false },
    });

    expect((await engine.repositoryIndex.scan()).repositories).toEqual([]);

    await expect(
      engine.repositoryIndex.verifyLocal({ environment: "wsl", path: managed }),
    ).rejects.toThrow("managed");

    expect(engine.db.repositories()).toHaveLength(1);
    await rpc.close();

    await expect(
      engine.repositoryIndex.verifyLocal({ environment: "wsl", path: linked }),
    ).rejects.toThrow("managed");
  } finally {
    await engine.close();
  }
});
