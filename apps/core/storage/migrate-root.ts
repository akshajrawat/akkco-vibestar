import { cp, mkdir, readFile, writeFile, rename, readdir, rm, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import BetterSqlite3 from "better-sqlite3";
import lockfile from "proper-lockfile";
import { Database } from "./database";
import { VIBESTAR_DB_NAME } from "./contracts";
import { AdeError } from "../domain";
import { createLayout, exists, inside, managedPath } from "../workspace/paths";

const legacyPromotedDirectories = ["state", "repos", "worktrees", "logs", "artifacts", "telemetry"];
const promotedDirectories = [...legacyPromotedDirectories, "workspaces"];
const journalPath = (target: string) => join(target, "runtime", "migration-pending.json");

const recoverMigration = async (source: string, target: string) => {
  await managedPath(target, journalPath(target));
  if (!(await exists(journalPath(target)))) {
    return;
  }

  const journal = JSON.parse(await readFile(journalPath(target), "utf8"));
  if (
    journal.source !== source ||
    journal.target !== target ||
    typeof journal.staging !== "string" ||
    !/^migration-[a-f0-9-]+$/.test(journal.staging.split("/").at(-1) || "") ||
    !inside(join(target, "cache"), await realpath(journal.staging))
  ) {
    throw new AdeError(
      "migration",
      "Interrupted migration metadata could not be verified. Original data was preserved.",
    );
  }

  await managedPath(target, journal.staging);
  const directories = journal.directories ?? legacyPromotedDirectories;
  if (
    JSON.stringify(directories) !== JSON.stringify(legacyPromotedDirectories) &&
    JSON.stringify(directories) !== JSON.stringify(promotedDirectories)
  ) {
    throw new AdeError(
      "migration",
      "The migration directory journal could not be verified. Existing data was preserved.",
    );
  }

  for (const dir of directories) {
    if (!(await exists(join(journal.staging, dir)))) {
      await rename(join(target, dir), join(journal.staging, dir));
      await mkdir(join(target, dir), { recursive: true, mode: 0o700 });
    }
  }

  await rm(journalPath(target));
  await rm(journal.staging, { recursive: true, force: true });
};

export const migrateDataRoot = async (source: string, target: string) => {
  source = await realpath(source);
  target = await createLayout(target);
  if (source === target || inside(source, target) || inside(target, source)) {
    throw new AdeError(
      "migration",
      "The target data directory must be outside the current location.",
    );
  }

  for (const directory of [...promotedDirectories, "cache", "runtime"]) {
    await managedPath(source, directory);
  }

  await managedPath(source, join("state", VIBESTAR_DB_NAME));

  await recoverMigration(source, target);
  for (const dir of promotedDirectories) {
    await managedPath(target, dir);
    if ((await exists(join(target, dir))) && (await readdir(join(target, dir))).length) {
      throw new AdeError(
        "migration",
        `Target directory ${dir} exists and is not empty. Clean it before migration.`,
      );
    }
  }

  const sourceLock = join(source, "state", "core.lock");
  const targetLock = join(target, "state", "core.lock");
  await mkdir(join(source, "state"), { recursive: true, mode: 0o700 });
  await mkdir(join(target, "state"), { recursive: true, mode: 0o700 });
  await writeFile(sourceLock, "", { flag: "a", mode: 0o600 });
  await writeFile(targetLock, "", { flag: "a", mode: 0o600 });

  let releaseSource: (() => Promise<void>) | undefined;
  let releaseTarget: (() => Promise<void>) | undefined;
  const staging = join(target, "cache", `migration-${randomUUID()}`);
  await mkdir(staging, { recursive: true, mode: 0o700 });

  const promoted: string[] = [];
  try {
    releaseSource = await lockfile.lock(sourceLock, {
      stale: 10000,
      update: 5000,
      retries: 0,
    });

    releaseTarget = await lockfile.lock(targetLock, {
      stale: 10000,
      update: 5000,
      retries: 0,
    });

    for (const dir of promotedDirectories) {
      const src = join(source, dir);
      if (!(await exists(src))) {
        await mkdir(join(staging, dir), { recursive: true, mode: 0o700 });
        continue;
      }

      await cp(src, join(staging, dir), {
        recursive: true,
        verbatimSymlinks: true,
      });
    }

    const stagedDbPath = join(staging, "state", VIBESTAR_DB_NAME);
    if (!(await exists(stagedDbPath))) {
      throw new AdeError(
        "migration",
        "Source database not found. Choose Use old location to start afresh at the current path.",
      );
    }

    let db: Database | undefined = await Database.open(stagedDbPath);
    if (
      db.all(
        "SELECT id FROM viber_sessions WHERE workspace IS NOT NULL AND json_extract(workspace,'$.worktree_path')<>''",
      ).length
    ) {
      throw new AdeError(
        "migration",
        "Owned Viber workspaces require keeping the old location. Choose Use old location to preserve native threads and files safely.",
      );
    }

    const translated = (path: string) =>
      inside(source, path) ? join(target, relative(source, path)) : path;

    for (const repo of db.repositories()) {
      if (repo.source === "imported") {
        continue;
      }

      if (!inside(join(source, "repos"), repo.path)) {
        throw new AdeError("migration", "Repository path is outside the old managed root");
      }

      db.saveRepository({ ...repo, path: translated(repo.path) });
    }

    const viberSessions = db.all<{ id: string; workspace: string }>(
      "SELECT id, workspace FROM viber_sessions WHERE workspace IS NOT NULL",
    );

    for (const session of viberSessions) {
      try {
        const ws = JSON.parse(session.workspace);
        if (ws.worktree_path) {
          ws.worktree_path = translated(ws.worktree_path);
        }

        if (ws.workspace_checkpoint?.git_common_dir) {
          ws.workspace_checkpoint.git_common_dir = translated(
            ws.workspace_checkpoint.git_common_dir,
          );
        }

        db.run("UPDATE viber_sessions SET workspace=? WHERE id=?", JSON.stringify(ws), session.id);
      } catch {
        // ignore malformed session workspace JSON
      }
    }

    // Rewrite every copied worktree registration
    for (const repo of db.repositories().filter((r) => r.source !== "imported")) {
      const admin = join(staging, relative(target, repo.path), ".git", "worktrees");
      await managedPath(staging, admin);
      if (!(await exists(admin))) {
        continue;
      }

      for (const name of await readdir(admin)) {
        const file = await managedPath(staging, join(admin, name, "gitdir"));
        const path = (await readFile(file, "utf8")).trim();
        if (!inside(join(source, "worktrees"), path) && !inside(join(target, "worktrees"), path)) {
          throw new AdeError(
            "migration",
            "A managed clone contains an external worktree. Use the old location to preserve its metadata.",
          );
        }

        const newPath = translated(path);
        await writeFile(file, newPath + "\n");
        const worktreeGitfile = await managedPath(staging, relative(target, newPath));
        if (await exists(worktreeGitfile)) {
          await writeFile(
            worktreeGitfile,
            `gitdir: ${join(repo.path, ".git", "worktrees", name)}\n`,
          );
        }
      }
    }

    db.close();
    db = undefined;
    for (const dir of promotedDirectories) {
      if ((await readdir(join(target, dir))).length) {
        throw new AdeError(
          "migration",
          `Destination ${dir} is not empty. Original data was preserved.`,
        );
      }
    }

    await writeFile(
      journalPath(target),
      JSON.stringify({ source, target, staging, directories: promotedDirectories }),
      {
        mode: 0o600,
      },
    );

    for (const dir of promotedDirectories) {
      await managedPath(staging, dir);
      await managedPath(target, dir);
      await rename(join(staging, dir), join(target, dir));
      promoted.push(dir);
    }

    const verify = await Database.open(join(target, "state", VIBESTAR_DB_NAME));
    try {
      const sqlite = new BetterSqlite3(join(source, "state", VIBESTAR_DB_NAME));
      try {
        sqlite
          .prepare(
            "INSERT INTO settings VALUES('migrated_to',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(target);
      } finally {
        sqlite.close();
      }

      await rm(journalPath(target));
      await rm(staging, { recursive: true, force: true });
    } finally {
      verify.close();
    }
  } catch (error) {
    for (const dir of promoted) {
      await rm(join(target, dir), { recursive: true, force: true }).catch(() => {});
    }

    await rm(staging, { recursive: true, force: true }).catch(() => {});
    await rm(journalPath(target)).catch(() => {});
    throw error;
  } finally {
    await releaseTarget?.().catch(() => {});
    await releaseSource?.().catch(() => {});
  }
};
