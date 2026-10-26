import { chmod, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AdeError, type Task } from "../domain";
import type { Engine } from "../execution/engine";
import { gitChecked } from "../workspace/git-command";
import { inside, managedPath } from "../workspace/paths";
import { readWorktreeOwner, writeWorktreeOwner } from "../workspace/ownership";
import { inspectSelectedFile } from "./files";
import type { Finalization } from "./contracts";

export class FinalizationWorkspaces {
  constructor(
    private readonly engine: Engine,
    private readonly git: (
      record: Finalization,
      cwd: string,
      args: string[],
      signal: AbortSignal,
    ) => Promise<string>,
  ) {}
  source = async (task: Task) => {
    const cwd = await this.engine.git.assertTask(task);
    const repo = this.engine.db.repository(task.repo_id);
    const common = await this.engine.git.commonDirectory(repo.path);
    const metadata = await realpath(await gitChecked(["rev-parse", "--absolute-git-dir"], cwd));
    if (
      !task.branch_owned ||
      (await this.engine.git.commonDirectory(cwd)) !== common ||
      !inside(join(common, "worktrees"), metadata) ||
      (await readWorktreeOwner(metadata, "vibestar-task-owner")) !== task.id ||
      (await gitChecked(
        ["config", "--local", "--get", `branch.${task.branch_name}.vibestarTask`],
        cwd,
      )) !== task.id
    )
      throw new AdeError(
        "ownership",
        "Finalization requires the original positively owned task workspace.",
      );
    return cwd;
  };
  assignment = (record: Finalization, task: Task) => ({
    ...task,
    stage: 5,
    branch_name: record.preview_branch,
    worktree_path: record.preview_path,
  });
  assert = async (record: Finalization, task: Task) => {
    const assignment = this.assignment(record, task);
    const cwd = await this.engine.git.assertTask(assignment);
    const common = await this.engine.git.commonDirectory(
      this.engine.db.repository(task.repo_id).path,
    );
    const metadata = await realpath(await gitChecked(["rev-parse", "--absolute-git-dir"], cwd));
    if (
      !inside(join(common, "worktrees"), metadata) ||
      (await this.engine.git.commonDirectory(cwd)) !== common ||
      (await readWorktreeOwner(metadata, "vibestar-finalization-owner")) !== record.id ||
      (await gitChecked(
        ["config", "--local", "--get", `branch.${record.preview_branch}.vibestarFinalization`],
        cwd,
      )) !== record.id
    )
      throw new AdeError("ownership", "The selected-file review workspace changed ownership.");
    return cwd;
  };
  create = async (
    record: Finalization,
    task: Task,
    untracked: Set<string>,
    signal: AbortSignal,
  ) => {
    const source = await this.source(task);
    await managedPath(this.engine.root, record.preview_path);
    await this.git(
      record,
      source,
      ["worktree", "add", "-b", record.preview_branch, "--", record.preview_path, record.parent],
      signal,
    );
    const metadata = await realpath(
      await gitChecked(["rev-parse", "--absolute-git-dir"], record.preview_path),
    );
    await writeWorktreeOwner(metadata, "vibestar-finalization-owner", record.id);
    await this.git(
      record,
      source,
      ["config", "--local", `branch.${record.preview_branch}.vibestarFinalization`, record.id],
      signal,
    );
    const cwd = await this.assert(record, task);
    for (const path of record.paths) {
      const content = await inspectSelectedFile(source, path, untracked.has(path));
      const destination = await managedPath(cwd, path);
      if (content.bytes) {
        await mkdir(dirname(destination), { recursive: true });
        await managedPath(cwd, path);
        await writeFile(destination, content.bytes, { mode: content.mode });
        await chmod(destination, content.mode);
      } else await rm(destination, { force: true });
    }
    if (record.paths.length)
      await this.git(
        record,
        cwd,
        ["add", "--all", "--", ...record.paths.map((path) => `:(literal)${path}`)],
        signal,
      );
    record.tree = (await this.git(record, cwd, ["write-tree"], signal)).trim();
    record.projected_index = await this.git(
      record,
      cwd,
      ["ls-files", "--stage", "-v", "-z"],
      signal,
    );
    // Scan the cumulative patch, including commits produced before finalization.
    const changed = await this.git(
      record,
      cwd,
      ["diff", "--cached", "--name-only", "-z", task.base_commit_sha, "--"],
      signal,
    );
    for (const path of changed.split("\0").filter(Boolean))
      await inspectSelectedFile(cwd, path, untracked.has(path));
    return cwd;
  };
  unchanged = async (record: Finalization, task: Task, signal: AbortSignal) => {
    const cwd = await this.assert(record, task);
    if (
      !record.tree ||
      (await this.git(record, cwd, ["write-tree"], signal)).trim() !== record.tree ||
      (await this.git(record, cwd, ["diff", "--name-only", "--"], signal)).trim() ||
      (await this.git(record, cwd, ["ls-files", "--others", "--exclude-standard", "-z"], signal))
    )
      throw new AdeError(
        "review_changed",
        "The isolated staged selection changed. Prepare and review a new selection.",
      );
    return cwd;
  };
}
