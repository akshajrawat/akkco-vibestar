import {
  cp,
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  rm,
  realpath,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import BetterSqlite3 from "better-sqlite3";
import lockfile from "proper-lockfile";
import { Database } from "./database";
import { AdeError } from "../domain";
import { createLayout, exists, inside } from "../workspace/paths";
import { checked } from "../execution/process";
import { RepairStore } from "../review/repair/store";

const promotedDirectories = [
  "state",
  "repos",
  "worktrees",
  "logs",
  "artifacts",
  "telemetry",
];
const journalPath = (target: string) =>
  join(target, "runtime", "migration-pending.json");
const recoverMigration = async (source: string, target: string) => {
  if (!(await exists(journalPath(target)))) return;
  const journal = JSON.parse(await readFile(journalPath(target), "utf8"));
  if (
    journal.source !== source ||
    journal.target !== target ||
    typeof journal.staging !== "string" ||
    !/^migration-[a-f0-9-]+$/.test(journal.staging.split("/").at(-1) || "") ||
    !inside(join(target, "cache"), await realpath(journal.staging))
  )
    throw new AdeError(
      "migration",
      "Interrupted migration metadata could not be verified. Original data was preserved.",
    );
  for (const dir of promotedDirectories) {
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
  if (source === target || inside(source, target) || inside(target, source))
    throw new AdeError(
      "migration",
      "Migration roots must be separate directories. Original data was preserved.",
    );
  const lock = join(source, "state", "core.lock");
  await writeFile(lock, "", { flag: "a", mode: 0o600 });
  const release = await lockfile.lock(lock, { stale: 10000, retries: 0 });
  try {
    await recoverMigration(source, target);
  } catch (error) {
    await release();
    throw error;
  }
  if (await exists(join(target, "state", "vibestar.sqlite"))) {
    await release();
    throw new AdeError(
      "migration",
      "The destination already contains a database. Existing data was preserved.",
    );
  }
  const staging = join(target, "cache", `migration-${randomUUID()}`);
  const promoted: string[] = [];
  let db: Database | undefined;
  try {
    await createLayout(staging);
    const original = new BetterSqlite3(
      join(source, "state", "vibestar.sqlite"),
      { readonly: true, fileMustExist: true },
    );
    try {
      await original.backup(join(staging, "state", "vibestar.sqlite"));
    } finally {
      original.close();
    }
    for (const dir of [
      "repos",
      "worktrees",
      "logs",
      "artifacts",
      "cache",
      "telemetry",
    ]) {
      if (await exists(join(source, dir)))
        await cp(join(source, dir), join(staging, dir), {
          recursive: true,
          dereference: false,
        });
    }
    const runtime = (await exists(join(source, "runtime")))
      ? join(source, "runtime")
      : join(source, "state", "runtime");
    if (await exists(runtime))
      await cp(runtime, join(staging, "runtime"), {
        recursive: true,
        dereference: false,
      });
    db = new Database(join(staging, "state", "vibestar.sqlite"));
    const translated = (path: string) =>
      inside(source, path) ? join(target, relative(source, path)) : path;
    const repairs = new RepairStore(db);
    for (const repo of db.repositories()) {
      if (repo.source === "imported") {
        if (
          db.tasks().some((t) => t.repo_id === repo.id && t.worktree_path) ||
          repairs
            .list()
            .some(
              (session) =>
                session.repo_id === repo.id &&
                session.workspace.preparation !== "removed",
            )
        )
          throw new AdeError(
            "migration",
            "Imported task worktrees require keeping the old location. Choose Use old location to preserve them safely.",
          );
        continue;
      }
      if (!inside(join(source, "repos"), repo.path))
        throw new AdeError(
          "migration",
          "Repository path is outside the old managed root",
        );
      db.saveRepository({ ...repo, path: translated(repo.path) });
    }
    for (const task of db.tasks()) {
      if (!task.worktree_path) continue;
      if (!inside(join(source, "worktrees"), task.worktree_path))
        throw new AdeError(
          "migration",
          "Task path is outside the old managed root",
        );
      const copy = join(staging, relative(source, task.worktree_path));
      const gitfile = await readFile(join(copy, ".git"), "utf8");
      const oldGitdir = gitfile.trim().replace(/^gitdir: /, "");
      if (
        !gitfile.startsWith("gitdir: ") ||
        !inside(join(source, "repos"), oldGitdir)
      )
        throw new AdeError(
          "migration",
          "Unsafe worktree metadata. Original data was preserved.",
        );
      const newGitdir = translated(oldGitdir);
      await writeFile(join(copy, ".git"), `gitdir: ${newGitdir}\n`);
      await writeFile(
        join(staging, relative(source, oldGitdir), "gitdir"),
        `${translated(task.worktree_path)}/.git\n`,
      );
      db.saveTask({ ...task, worktree_path: translated(task.worktree_path) });
    }
    for (const session of repairs.list()) {
      const workspace = session.workspace;
      if (
        workspace.preparation !== "removed" &&
        (await exists(join(staging, relative(source, workspace.worktree_path))))
      ) {
        if (
          !inside(join(source, "worktrees"), workspace.worktree_path) ||
          !inside(join(source, "repos"), workspace.git_common_dir)
        )
          throw new AdeError(
            "migration",
            "Repair worktree metadata is outside the old managed root. Use the old location to preserve it.",
          );
        const copy = join(staging, relative(source, workspace.worktree_path));
        const gitfile = await readFile(join(copy, ".git"), "utf8");
        const gitdir = gitfile.trim().replace(/^gitdir: /, "");
        if (
          !gitfile.startsWith("gitdir: ") ||
          !inside(workspace.git_common_dir, gitdir)
        )
          throw new AdeError(
            "migration",
            "Repair Git metadata is unsafe. Original data was preserved.",
          );
        await writeFile(join(copy, ".git"), `gitdir: ${translated(gitdir)}\n`);
        await writeFile(
          join(staging, relative(source, gitdir), "gitdir"),
          `${translated(workspace.worktree_path)}/.git\n`,
        );
      }
      workspace.worktree_path = translated(workspace.worktree_path);
      workspace.git_common_dir = translated(workspace.git_common_dir);
      repairs.save(session);
    }
    // Rewrite every copied worktree registration, including those not linked to current tasks.
    for (const repo of db
      .repositories()
      .filter((r) => r.source !== "imported")) {
      const admin = join(
        staging,
        relative(target, repo.path),
        ".git",
        "worktrees",
      );
      if (!(await exists(admin))) continue;
      for (const name of await readdir(admin)) {
        const file = join(admin, name, "gitdir");
        const path = (await readFile(file, "utf8")).trim();
        if (
          !inside(join(source, "worktrees"), path) &&
          !inside(join(target, "worktrees"), path)
        )
          throw new AdeError(
            "migration",
            "A managed clone contains an external worktree. Use the old location to preserve its metadata.",
          );
        const newPath = translated(path);
        await writeFile(file, newPath + "\n");
        const worktreeGitfile = join(staging, relative(target, newPath));
        if (await exists(worktreeGitfile))
          await writeFile(
            worktreeGitfile,
            `gitdir: ${join(repo.path, ".git", "worktrees", name)}\n`,
          );
      }
    }
    db.close();
    db = undefined;
    for (const dir of promotedDirectories)
      if ((await readdir(join(target, dir))).length)
        throw new AdeError(
          "migration",
          `Destination ${dir} is not empty. Original data was preserved.`,
        );
    await writeFile(
      journalPath(target),
      JSON.stringify({ source, target, staging }),
      { mode: 0o600 },
    );
    for (const dir of promotedDirectories) {
      await rename(join(staging, dir), join(target, dir));
      promoted.push(dir);
    }
    const verify = new Database(join(target, "state", "vibestar.sqlite"));
    try {
      const repairAssignments = new RepairStore(verify)
        .list()
        .filter((session) => session.workspace.preparation !== "removed")
        .map((session) => ({
          repo_id: session.repo_id,
          worktree_path: session.workspace.worktree_path,
        }));
      for (const task of [...verify.tasks(), ...repairAssignments].filter(
        (t) => t.worktree_path,
      )) {
        if (!(await exists(task.worktree_path))) continue;
        const common = await checked(
          "git",
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          task.worktree_path,
        );
        if (!inside(join(target, "repos"), common))
          throw new AdeError(
            "migration",
            "Migrated Git metadata did not resolve inside the new root",
          );
        await checked(
          "git",
          ["worktree", "repair", "--", task.worktree_path],
          verify.repository(task.repo_id).path,
        );
      }
    } finally {
      verify.close();
    }
    await cp(join(staging, "cache"), join(target, "cache"), {
      recursive: true,
      dereference: false,
    });
    for (const name of await readdir(join(staging, "runtime"))) {
      const destination = join(target, "runtime", name);
      if (name !== "migration-pending.json" && !(await exists(destination)))
        await cp(join(staging, "runtime", name), destination, {
          recursive: true,
          dereference: false,
        });
    }
    await rm(journalPath(target));
    await rm(staging, { recursive: true, force: true });
    return target;
  } catch (error) {
    db?.close();
    for (const dir of promoted.reverse()) {
      await rename(join(target, dir), join(staging, dir));
      await mkdir(join(target, dir), { recursive: true, mode: 0o700 });
    }
    await rm(journalPath(target), { force: true });
    await rm(staging, { recursive: true, force: true });
    throw error;
  } finally {
    await release();
  }
};
