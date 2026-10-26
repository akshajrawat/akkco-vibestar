import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import BetterSqlite3 from "better-sqlite3";
import { StorageService } from "../../backend/storage/service";
import { createFixtureEngine, fixtureRepository, prepareFixtureTask } from "../helpers/fixtures";
import { checked } from "../../backend/execution/runtime/process";
import { exists } from "../../backend/workspace/paths";
import { defaultSettings } from "../../backend/domain";
import { finalizationFixture } from "../finalization/fixtures";

it("previews exact removals, backs up valid SQLite and metadata, preserves imported sources/settings/auth and reopens without stale tasks or inference", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-reset-owned-"));
  const root = join(dir, "data");
  let engine = await createFixtureEngine(root);
  try {
    const fixture = await fixtureRepository(engine, dir);
    const source = join(dir, "imported-source");
    await rename(fixture.repo.path, source);
    const repo = { ...fixture.repo, path: source, source: "imported" as const };
    engine.db.saveRepository(repo);
    const task = await prepareFixtureTask(engine, repo, "reset-owned");
    engine.db.saveTask({ ...task, archived: true });
    await mkdir(join(root, "logs", task.id));
    await writeFile(join(root, "logs", task.id, "raw.log"), "Fixture retained evidence");
    await writeFile(join(root, "runtime", "auth-sentinel"), "Provider session remains");
    await checked("git", ["branch", "personal"], source);
    const index = await readFile(join(source, ".git", "index"));
    const content = await readFile(join(source, "source.txt"));
    engine.db.saveSettings({ ...defaultSettings, default_editor: "code" });
    const service = new StorageService(engine);
    const preview = await service.previewReset();
    expect(preview.tasks).toMatchObject([{ id: task.id, eligible: true, archived: true }]);
    expect(await exists(task.worktree_path)).toBe(true);
    await expect(service.reset()).rejects.toThrow("preview");
    const result = await service.reset(preview.token);
    expect(result.removed).toEqual([task.id]);
    expect(result.preserved).toEqual([]);
    expect(await exists(task.worktree_path)).toBe(false);
    expect(engine.db.tasks()).toEqual([]);
    expect(engine.db.repository(repo.id).path).toBe(source);
    expect(engine.db.settings().default_editor).toBe("code");
    expect(await readFile(join(source, ".git", "index"))).toEqual(index);
    expect(await readFile(join(source, "source.txt"))).toEqual(content);
    expect(await checked("git", ["rev-parse", "personal"], source)).toBe(task.base_commit_sha);

    expect(await readFile(join(root, "runtime", "auth-sentinel"), "utf8")).toBe(
      "Provider session remains",
    );

    expect(await readFile(join(result.backup, "logs", task.id, "raw.log"), "utf8")).toBe(
      "Fixture retained evidence",
    );

    const backup = new BetterSqlite3(join(result.backup, "vibestar.sqlite"), {
      readonly: true,
    });

    try {
      expect(backup.pragma("quick_check", { simple: true })).toBe("ok");
      expect(backup.prepare("SELECT id FROM tasks").all()).toEqual([{ id: task.id }]);
    } finally {
      backup.close();
    }

    await engine.close();
    engine = await createFixtureEngine(root);
    expect(engine.db.tasks()).toEqual([]);
    expect(engine.db.all("SELECT id FROM agent_runs")).toEqual([]);
    expect(engine.db.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(engine.cleanupBlockers()).toEqual([]);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(["dirty", "unpushed", "unknown"])(
  "preserves a %s task while resetting eligible fixtures and leaves unowned cache intact",
  async (kind) => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-reset-protected-"));
    const engine = await createFixtureEngine(join(dir, "data"));
    try {
      const { repo } = await fixtureRepository(engine, dir);
      const protectedTask = await prepareFixtureTask(engine, repo, "protected");
      const clean = await prepareFixtureTask(engine, repo, "clean");
      if (kind === "unknown") {
        await checked(
          "git",
          [
            "config",
            "--local",
            `branch.${protectedTask.branch_name}.vibestarTask`,
            "different-owner",
          ],
          repo.path,
        );
      } else {
        await writeFile(join(protectedTask.worktree_path, "source.txt"), "Work to preserve\n");
        if (kind === "unpushed")
          await checked(
            "git",
            [
              "-c",
              "user.name=Fixture",
              "-c",
              "user.email=test@example.invalid",
              "commit",
              "-am",
              "Unpushed work",
            ],
            protectedTask.worktree_path,
          );
      }

      await writeFile(join(engine.root, "cache", "unknown-data"), "Unknown owner");
      const storage = new StorageService(engine);
      const preview = await storage.previewReset();
      expect(preview.tasks.find((task) => task.id === protectedTask.id)?.eligible).toBe(false);
      const result = await storage.reset(preview.token);
      expect(result.removed).toEqual([clean.id]);
      expect(result.preserved).toMatchObject([{ id: protectedTask.id }]);
      expect(await exists(protectedTask.worktree_path)).toBe(true);
      expect(engine.db.tasks().map((task) => task.id)).toEqual([protectedTask.id]);

      expect(await readFile(join(engine.root, "cache", "unknown-data"), "utf8")).toBe(
        "Unknown owner",
      );

      if (kind === "unpushed") expect(result.preserved[0].reason).toContain("Unpushed");
    } finally {
      await engine.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it("refuses active processes and stale reset previews before any backup or deletion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-reset-busy-"));
  const engine = await createFixtureEngine(join(dir, "data"));
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const task = await prepareFixtureTask(engine, repo, "busy");
    const storage = new StorageService(engine);
    const preview = await storage.previewReset();
    const release = engine.acquireTerminal(task.id);

    await expect(storage.reset(preview.token)).rejects.toMatchObject({
      kind: "busy",
    });

    release();
    await writeFile(join(task.worktree_path, "new.txt"), "Changed after preview");
    await expect(storage.reset(preview.token)).rejects.toThrow("changed");
    expect(await exists(join(engine.root, "backups"))).toBe(false);
    expect(await exists(task.worktree_path)).toBe(true);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("refuses an uncertain Git publication and preserves its worktree and journal", async () => {
  const fixture = await finalizationFixture();
  try {
    const record = await fixture.preview();

    fixture.engine.db.run(
      "UPDATE git_finalizations SET status='uncertain',data=json_set(data,'$.status','uncertain') WHERE id=?",
      record.id,
    );

    const storage = new StorageService(fixture.engine);
    const preview = await storage.previewReset();
    expect(preview.sensitive).toMatchObject([{ id: record.id, status: "uncertain" }]);
    expect(preview.tasks[0].eligible).toBe(false);
    await expect(storage.reset(preview.token)).rejects.toThrow("sensitive Git");
    expect(await exists(fixture.task.worktree_path)).toBe(true);
    expect(fixture.engine.db.all("SELECT id FROM git_finalizations")).toEqual([{ id: record.id }]);
    expect(await exists(join(fixture.root, "backups"))).toBe(false);
  } finally {
    await fixture.close();
  }
});
