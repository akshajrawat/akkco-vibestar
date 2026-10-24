import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseIssue,
  branchName,
  remoteIdentity,
  retryTarget,
  defaultSettings,
  SettingsSchema,
  stageStatus,
  type Task,
} from "../backend/domain";
import { safeFile, worktreePath } from "../backend/workspace/paths";
import { Database } from "../backend/storage/database";
import BetterSqlite3 from "better-sqlite3";
import { migrations } from "../backend/storage/migrations";
describe("domain and persistence", () => {
  it("upgrades V1 tasks to partial scope while preserving conversations and pipeline settings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-migrate-"));
    const path = join(dir, "legacy.sqlite");
    const old = new BetterSqlite3(path);
    try {
      for (const migration of migrations.filter((m) => m.version <= 5)) {
        old.exec(migration.sql);
        old
          .prepare("INSERT OR IGNORE INTO schema_migrations VALUES(?,?)")
          .run(migration.version, "before");
      }
      const task = {
        id: "old-task",
        repo_id: "old-repo",
        claimed_scope: "specific.ts",
        status: "ready_for_review",
        stage: 5,
        created_at: "before",
      };
      old
        .prepare("INSERT INTO repositories VALUES(?,?,?,?)")
        .run("old-repo", "owner", "repo", JSON.stringify({ id: "old-repo" }));
      old
        .prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?)")
        .run(
          task.id,
          task.repo_id,
          task.status,
          task.stage,
          JSON.stringify(task),
          task.created_at,
        );
      old
        .prepare("INSERT INTO task_messages VALUES(?,?,?,?,?)")
        .run("message", task.id, "user", "Saved discussion", "before");
      old
        .prepare("INSERT INTO settings VALUES(?,?)")
        .run("pipeline", JSON.stringify(defaultSettings));
    } finally {
      old.close();
    }
    try {
      const current = new Database(path);
      expect(current.task("old-task")).toMatchObject({
        scope_mode: "partial",
        claimed_scope: "specific.ts",
        stage: 5,
        status: "awaiting_approval",
        approval_gate: "implementation",
      });
      expect(current.all("SELECT scope_mode FROM tasks")).toEqual([
        { scope_mode: "partial" },
      ]);
      expect(current.detail("old-task").messages).toHaveLength(1);
      expect(current.settings()).toEqual(defaultSettings);
      current.close();
    } finally {
      await rm(dir, { recursive: true });
    }
  });
  it("upgrades legacy PR decisions and recovers only the pre-inference slice crash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-pr-migrate-"));
    const path = join(dir, "legacy.sqlite");
    const crash = "Cannot read properties of undefined (reading 'slice')";
    const decision = {
      manualActionRequired: false,
      severity: "none",
      summary: "Waiting for review",
      reason: "No action required",
      newActivity: ["Saved activity"],
      recommendedNextAction: "",
      affectedFiles: [],
    };
    const snapshot = {
      title: "Saved PR",
      comments: [{ id: "request", body: "Can we simplify this?" }],
    };
    const db = new Database(path);
    try {
      db.run("DELETE FROM schema_migrations WHERE version=11");
      for (const [id, error, status, enabled, action] of [
        ["legacy-crash", crash, "error", true, decision],
        ["paused-crash", crash, "error", false, decision],
        ["provider-failure", "Provider unavailable", "error", true, decision],
        ["interrupted", "Analysis interrupted", "interrupted", true, decision],
        ["healthy", null, "idle", true, decision],
        [
          "modern-failure",
          crash,
          "error",
          true,
          {
            ...decision,
            conversationState: "waiting_for_reviewer",
            outstandingRequests: [],
            alreadyAddressed: ["Already addressed"],
          },
        ],
        ["no-decision", null, "idle", true, undefined],
      ] as const) {
        db.run(
          "INSERT INTO scheduled_jobs VALUES(?,?)",
          id,
          JSON.stringify({
            id,
            enabled,
            status,
            error,
            action,
            conversation_action: action,
            next_run_at: "2026-01-01T00:00:00Z",
            last_snapshot: snapshot,
            pending_snapshot: error ? snapshot : null,
          }),
        );
        if (error)
          db.run(
            "INSERT INTO scheduled_attention(id,job_id,created_at,summary,changes,error) VALUES(?,?,?,?,?,?)",
            id,
            id,
            "before",
            "Analysis unavailable",
            "[]",
            error,
          );
      }
    } finally {
      db.close();
    }
    try {
      const current = new Database(path);
      try {
        const jobs = current
          .all<{ data: string }>("SELECT data FROM scheduled_jobs")
          .map(({ data }) => JSON.parse(data));
        const job = (id: string) => jobs.find((j) => j.id === id);
        for (const id of ["legacy-crash", "paused-crash"]) {
          expect(job(id)).toMatchObject({
            status: "pending",
            error: null,
            last_snapshot: snapshot,
            pending_snapshot: snapshot,
            action: {
              ...decision,
              conversationState: "neutral",
              outstandingRequests: [],
              alreadyAddressed: [],
            },
          });
          expect(
            current.all(
              "SELECT dismissed FROM scheduled_attention WHERE id=?",
              id,
            ),
          ).toEqual([{ dismissed: 1 }]);
        }
        expect(job("paused-crash").enabled).toBe(false);
        expect(job("provider-failure")).toMatchObject({
          status: "error",
          error: "Provider unavailable",
        });
        expect(job("interrupted").status).toBe("interrupted");
        expect(job("modern-failure")).toMatchObject({
          status: "error",
          error: crash,
          action: {
            conversationState: "waiting_for_reviewer",
            alreadyAddressed: ["Already addressed"],
          },
        });
        expect(
          current.all(
            "SELECT job_id FROM scheduled_attention WHERE dismissed=0",
          ),
        ).toHaveLength(3);
        expect(job("healthy").status).toBe("idle");
        expect(job("no-decision").action).toBeUndefined();
        expect(job("legacy-crash").conversation_action).toEqual(
          job("legacy-crash").action,
        );
        expect(current.all("SELECT id FROM ai_usage")).toEqual([]);
        expect(current.all("SELECT id FROM scheduled_agent_runs")).toEqual([]);
      } finally {
        current.close();
      }
      const reopened = new Database(path);
      expect(
        reopened.all("SELECT version FROM schema_migrations WHERE version=11"),
      ).toEqual([{ version: 11 }]);
      reopened.close();
    } finally {
      await rm(dir, { recursive: true });
    }
  });
  it("parses GitHub issue URLs and rejects unrelated input", () => {
    expect(
      parseIssue("https://github.com/oppia/oppia/issues/26831").number,
    ).toBe(26831);
    for (const url of [
      "http://github.com/a/b/issues/1",
      "https://evil.com/a/b/issues/1",
      "https://github.com/a/b/pull/1",
      "https://github.com/a/b/issues/0",
      "https://user@github.com/a/b/issues/1",
      "https://github.com/a/b/issues/9007199254740993",
    ])
      expect(() => parseIssue(url)).toThrow();
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
    expect(remoteIdentity("git@github.com:oppia/oppia.git")).toEqual({
      owner: "oppia",
      name: "oppia",
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
  it("enforces sequential state and legal retry transitions", () => {
    expect(stageStatus(5)).toBe("reviewing_antigravity");
    expect(stageStatus(6)).toBe("ready_for_review");
    expect(() => stageStatus(7)).toThrow();
    const t = { stage: 3, worktree_path: "/tmp/worktree" } as Task;
    expect(retryTarget(t, 2, false)).toBe(2);
    expect(() => retryTarget(t, 4, false)).toThrow();
    expect(() => retryTarget(t, 1, true)).toThrow();
    expect(() => retryTarget(t, 0, false)).toThrow();
  });
  it("rejects traversal and symlink escape", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-path-"));
    try {
      await mkdir(join(dir, "task"));
      await writeFile(join(dir, "secret"), "outside");
      await symlink(join(dir, "secret"), join(dir, "task", "link"));
      await expect(safeFile(join(dir, "task"), "../secret")).rejects.toThrow();
      await expect(safeFile(join(dir, "task"), "link")).rejects.toThrow();
      await expect(
        safeFile(join(dir, "task"), ".git/config"),
      ).rejects.toThrow();
      expect(await safeFile(join(dir, "task"), "new.ts")).toBe(
        join(dir, "task", "new.ts"),
      );
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
      expect(db.all("SELECT version FROM schema_migrations")).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
        { version: 7 },
        { version: 8 },
        { version: 9 },
        { version: 10 },
        { version: 11 },
        { version: 12 },
        { version: 13 },
        { version: 14 },
        { version: 15 },
        { version: 16 },
        { version: 17 },
        { version: 18 },
        { version: 19 },
        { version: 20 },
        { version: 21 },
        { version: 22 },
        { version: 23 },
        { version: 24 },
      ]);
      db.close();
      const reopened = new Database(path);
      expect(reopened.settings().concurrency).toBe(3);
      expect(() =>
        reopened.saveSettings({ ...defaultSettings, concurrency: 5 }),
      ).toThrow();
      reopened.close();
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
