import { realpath, unlink } from "node:fs/promises";
import { join } from "node:path";

import { AdeError, now, type Repository, type Task } from "../domain";
import { gitCapture, gitChecked } from "./git-command";
import { exists } from "./paths";
import { readWorktreeOwner, writeWorktreeOwner } from "./ownership";

/** Admit only a clean base checkout; an owned or dirty checkout always gets a separate worktree. */
export const sourceCheckout = async (repo: Repository, base: string, reusableOwners: string[]) => {
  if ((await realpath(repo.path)) !== repo.path) return null;
  const cwd = repo.path;
  const branch = await gitCapture(["symbolic-ref", "--short", "HEAD"], cwd);
  if (branch.code !== 0 || branch.stdout.trim() !== repo.base_branch) return null;
  if ((await gitChecked(["rev-parse", "HEAD"], cwd)) !== base) return null;
  if (await gitChecked(["status", "--porcelain=v1", "--untracked-files=all"], cwd)) return null;
  const gitdir = await realpath(await gitChecked(["rev-parse", "--absolute-git-dir"], cwd));

  const common = await realpath(
    await gitChecked(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd),
  );

  if (gitdir !== common || common !== join(cwd, ".git")) return null;
  for (const name of [
    "index.lock",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
  ])
    if (await exists(join(gitdir, name))) return null;
  const owner = await readWorktreeOwner(gitdir, "vibestar-task-owner");
  if (owner && !reusableOwners.includes(owner)) return null;
  return { cwd, gitdir, previousOwner: owner };
};

export const prepareSourceCheckout = async (
  source: NonNullable<Awaited<ReturnType<typeof sourceCheckout>>>,
  task: Task,
  branch: string,
  base: string,
  command: (argv: string[]) => Promise<unknown>,
  checkpoint?: (task: Task) => void,
) => {
  task.workspace_mode = "source";
  task.worktree_path = source.cwd;
  task.branch_name = branch;
  task.base_commit_sha = base;
  task.branch_owned = false;
  task.workspace_checkpoint!.state = "creating";
  task.workspace_checkpoint!.started_at = now();
  checkpoint?.(task);
  if ((await readWorktreeOwner(source.gitdir, "vibestar-task-owner")) !== source.previousOwner)
    throw new AdeError("ownership", "Source checkout ownership changed during preparation.");
  if (source.previousOwner) await unlink(join(source.gitdir, "vibestar-task-owner"));
  await writeWorktreeOwner(source.gitdir, "vibestar-task-owner", task.id);
  await command(["checkout", "--no-track", "-b", branch, base]);
  await command(["config", "--local", `branch.${branch}.vibestarTask`, task.id]);
  if (await gitChecked(["status", "--porcelain=v1", "--untracked-files=all"], source.cwd))
    throw new AdeError(
      "ownership",
      "Source files changed during preparation. Inspect the retained branch before retrying.",
    );
  task.branch_owned = true;
  task.workspace_checkpoint!.state = "ready";
  checkpoint?.(task);
};
