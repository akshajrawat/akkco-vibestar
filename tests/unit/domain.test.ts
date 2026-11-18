import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseIssue,
  branchName,
  remoteIdentity,
  defaultSettings,
  SettingsSchema,
} from "../../apps/core/domain";
import { safeFile, worktreePath } from "../../apps/core/workspace/paths";
import { Database } from "../../apps/core/storage/database";
import { migrations } from "../../apps/core/storage/migrations";

describe("domain and persistence", () => {
  it("parses GitHub issue URLs and rejects unrelated input", () => {
    expect(parseIssue("https://github.com/vibestar/vibestar/issues/26831").number).toBe(26831);
    for (const url of [
      "http://github.com/a/b/issues/1",
      "https://evil.com/a/b/issues/1",
      "https://github.com/a/b/pull/1",
      "https://github.com/a/b/issues/0",
      "https://user@github.com/a/b/issues/1",
      "https://github.com/a/b/issues/9007199254740993",
    ]) {
      expect(() => parseIssue(url)).toThrow();
    }
  });

  it("generates valid branches and deterministic collisions", () => {
    expect(branchName(26831, "check-improvements-tab.spec.ts")).toBe(
      "akkco/26831-check-improvements-tab",
    );

    expect(branchName(1, "../a ;$(x)~..lock", 2)).toBe("akkco/1-a-x-lock-2");
    expect(branchName(1, "💥")).toBe("akkco/1-scope");

    expect(worktreePath("/tmp", "repository", 1, "scope", 2)).toBe(
      "/tmp/worktrees/repository/1-scope-2",
    );

    expect(() => worktreePath("/tmp", "../bad", 1, "a")).toThrow();
  });

  it("validates remotes and provider-specific effort", () => {
    expect(remoteIdentity("git@github.com:vibestar/vibestar.git")).toEqual({
      owner: "vibestar",
      name: "vibestar",
    });

    expect(() => remoteIdentity("https://example.com/owner/repo")).toThrow();

    expect(() =>
      SettingsSchema.parse({
        ...defaultSettings,
        codex_plan: { ...defaultSettings.codex_plan, effort: "max" },
      }),
    ).not.toThrow();

    expect(
      SettingsSchema.parse({
        ...defaultSettings,
        antigravity: { ...defaultSettings.antigravity, effort: "max" },
      }).antigravity.effort,
    ).toBe("max");
  });

  it("rejects traversal and symlink escape", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-path-"));
    try {
      await mkdir(join(dir, "task"));
      await writeFile(join(dir, "secret"), "outside");
      await symlink(join(dir, "secret"), join(dir, "task", "link"));
      await expect(safeFile(join(dir, "task"), "../secret")).rejects.toThrow();
      await expect(safeFile(join(dir, "task"), "link")).rejects.toThrow();
      await expect(safeFile(join(dir, "task"), ".git/config")).rejects.toThrow();
      expect(await safeFile(join(dir, "task"), "new.ts")).toBe(join(dir, "task", "new.ts"));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("migrates and persists SQLite settings across reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-db-"));
    try {
      const path = join(dir, "test.sqlite");
      const db = new Database(path);
      db.saveSettings({ ...defaultSettings, concurrency: 3 });

      expect(db.all("SELECT MAX(version) AS version FROM schema_migrations")).toEqual([
        { version: migrations.at(-1)!.version },
      ]);

      expect(db.all("PRAGMA foreign_key_check")).toEqual([]);

      db.close();
      const reopened = new Database(path);
      expect(reopened.settings().concurrency).toBe(3);
      expect(() => reopened.saveSettings({ ...defaultSettings, concurrency: 5 })).toThrow();
      reopened.close();
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
