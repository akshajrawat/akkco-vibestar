import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  branchName,
  remoteIdentity,
  defaultSettings,
  SettingsSchema,
} from "../../apps/core/domain";
import { safeFile, worktreePath } from "../../apps/core/workspace/paths";
import { Database } from "../../apps/core/storage/database";

describe("domain and persistence", () => {
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

  it("preserves each provider’s independent memory consent", () => {
    const settings = SettingsSchema.parse({
      ...defaultSettings,
      viber_memory: {
        ...defaultSettings.viber_memory,
        recall: true,
        share_with: { codex: false, antigravity: true },
      },
    });

    expect(settings.viber_memory).toEqual({
      ...defaultSettings.viber_memory,
      recall: true,
      share_with: { codex: false, antigravity: true },
    });
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

  it("initializes and persists SQLite settings across reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-db-"));
    try {
      const path = join(dir, "test.sqlite");
      const db = await Database.open(path);

      db.saveSettings({
        ...defaultSettings,
        concurrency: 3,
        viber_workspace_permission: "full-permission",
        allow_viber_communication: true,
      });

      expect(db.all("SELECT version FROM schema_migrations")).toEqual([{ version: 0 }]);

      expect(db.all("PRAGMA foreign_key_check")).toEqual([]);

      db.close();
      const reopened = await Database.open(path);
      expect(reopened.settings().concurrency).toBe(3);
      expect(reopened.settings().viber_workspace_permission).toBe("full-permission");
      expect(reopened.settings().allow_viber_communication).toBe(true);
      expect(() => reopened.saveSettings({ ...defaultSettings, concurrency: 5 })).toThrow();
      reopened.close();
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
