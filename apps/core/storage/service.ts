import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { AdeError, now } from "../domain";
import type { Engine } from "../execution/engine";
import { exists, inside, managedPath } from "../workspace/paths";
import { gitChecked } from "../workspace/git-command";
import { inspectStorage } from "./inspection";

export class StorageService {
  constructor(private readonly engine: Engine) {}

  private remove = async (relative: string) => {
    const path = await managedPath(this.engine.root, relative);
    if (!inside(this.engine.root, path)) {
      throw new AdeError("isolation", "Cleanup path is outside Vibestar storage");
    }

    try {
      const entry = await lstat(path);
      if (!entry.isSymbolicLink() && !inside(this.engine.root, await realpath(path))) {
        throw new AdeError("isolation", "Cleanup path resolves outside Vibestar storage");
      }

      await rm(path, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  };

  info = async () => inspectStorage(this.engine);

  clear = (kind: "logs" | "cache") =>
    this.engine.withStorageMaintenance(() => this.clearData(kind));

  private clearData = async (kind: "logs" | "cache") => {
    await this.remove(kind);
    await mkdir(join(this.engine.root, kind), { recursive: true, mode: 0o700 });
    this.engine.changed();
  };

  removeRepository = (id: string) =>
    this.engine.withStorageMaintenance(() => this.removeRepositoryData(id));

  private removeRepositoryData = async (id: string) => {
    const e = this.engine;
    if (e.db.all("SELECT id FROM viber_sessions WHERE repository_id=?", id).length) {
      throw new AdeError(
        "viber_history",
        "This repository owns Viber sessions. Preserve their workspaces and history before removing its connection.",
      );
    }

    const repo = e.db.repository(id);

    await e.git.withLock(id, async () => {
      if (repo.source !== "imported") {
        const path = await realpath(repo.path).catch(() => repo.path);
        if (!inside(join(e.root, "repos"), path)) {
          throw new AdeError("isolation", "Invalid managed repository path");
        }

        if (await exists(join(path, ".git"))) {
          const worktrees = await gitChecked(["worktree", "list", "--porcelain"], path);
          if (
            worktrees
              .split("\n")
              .filter((line) => line.startsWith("worktree "))
              .some((line) => line.slice(9) !== path)
          ) {
            throw new AdeError(
              "busy",
              "This managed repository still has registered worktrees. External worktrees must remain intact.",
            );
          }
        }

        await this.remove(join("repos", id));
      }

      e.db.transaction(() => {
        e.db.run("DELETE FROM repositories WHERE id=?", id);
      });
    });

    e.changed();
  };

  cleanCompleted = () => this.engine.withStorageMaintenance(this.cleanCompletedData);

  private cleanCompletedData = async () => {
    let count = 0;

    // Clean completed utility run logs if older than 7 days
    const completedRuns = this.engine.db.all<{ id: string }>(
      "SELECT id FROM utility_runs WHERE status IN ('completed', 'failed', 'cancelled', 'interrupted')",
    );

    for (const run of completedRuns) {
      const logPath = join(this.engine.root, "logs", `${run.id}.log`);
      if (await exists(logPath)) {
        await rm(logPath, { force: true });
        count++;
      }
    }

    return count;
  };

  removeUnused = () => this.engine.withStorageMaintenance(this.removeUnusedData);

  private removeUnusedData = async () => {
    const repos = this.engine.db
      .repositories()
      .filter(
        (r) =>
          r.source !== "imported" &&
          !this.engine.db.all("SELECT id FROM viber_sessions WHERE repository_id=?", r.id).length,
      );

    for (const repo of repos) {
      await this.removeRepositoryData(repo.id);
    }

    return repos.length;
  };

  previewReset = async () => {
    const e = this.engine;
    e.db.assertOwnershipRecords();

    const sessions = e.db.all<{ id: string; profile_id: string; title: string }>(
      "SELECT id, profile_id, title FROM viber_sessions",
    );

    const retained = [];
    for (const category of [
      "logs",
      "artifacts",
      "cache",
      "runtime",
      "telemetry",
      "worktrees",
      "workspaces",
      "repos",
    ]) {
      const path = await managedPath(e.root, category);
      for (const name of await readdir(path).catch(() => [])) {
        retained.push(join(path, name));
      }
    }

    const preview = {
      root: e.root,
      sessions,
      retained,
      blockers: e.cleanupBlockers().filter((blocker) => blocker.id !== "storage-maintenance"),
      preserved: [
        "All registered source repositories and managed clones",
        "User-owned branches",
        "Provider and GitHub authentication",
        "Settings and repository connections",
        "Viber identities and profiles",
      ],
    };

    const token = createHash("sha256").update(JSON.stringify(preview)).digest("hex");
    return { ...preview, token };
  };

  reset = (token?: string) => this.engine.withStorageMaintenance(() => this.resetData(token));

  private resetData = async (token?: string) => {
    const e = this.engine;
    const preview = await this.previewReset();
    if (preview.token !== token) {
      throw new AdeError(
        "stale_preview",
        "Workspace data changed. Inspect a new reset preview before confirming.",
      );
    }

    const backup = await managedPath(e.root, join("backups", "viber-reset-" + randomUUID()));
    await mkdir(backup, { recursive: true, mode: 0o700 });
    const database = join(backup, "vibestar.sqlite");
    await e.db.backup(database);
    await chmod(database, 0o600);

    const connection = new BetterSqlite3(database, {
      readonly: true,
      fileMustExist: true,
    });

    try {
      if (connection.pragma("quick_check", { simple: true }) !== "ok") {
        throw new AdeError("backup", "SQLite backup validation failed; no data was removed.");
      }
    } finally {
      connection.close();
    }

    await writeFile(
      join(backup, "manifest.json"),
      JSON.stringify({ created_at: now(), preview }, null, 2),
      { mode: 0o600 },
    );

    for (const category of ["logs", "cache"]) {
      await this.remove(category);
      await mkdir(join(e.root, category), { recursive: true, mode: 0o700 });
    }

    const result = {
      backup,
      retained: preview.retained,
      restart_required: false,
    };

    await writeFile(join(backup, "result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
    e.changed();
    return result;
  };
}
