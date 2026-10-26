import { afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checked } from "../../backend/execution/runtime/process";
import { GitWorkspace } from "../../backend/workspace/git";
import { createLayout } from "../../backend/workspace/paths";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
export const securityWorkspace = async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-host-git-"));
  directories.push(dir);
  const root = await createLayout(join(dir, "data"));
  const source = join(dir, "source");
  await mkdir(source);
  await checked("git", ["init", "-b", "main"], source);
  await checked("git", ["config", "user.name", "Fixture"], source);
  await checked("git", ["config", "user.email", "fixture@example.invalid"], source);
  await writeFile(join(source, "file.txt"), "base\n");
  await checked("git", ["add", "."], source);
  await checked("git", ["commit", "-m", "base"], source);
  const task = {
    id: "fixture-task",
    repo_id: "fixture",
    branch_name: "fixture-task",
    worktree_path: join(root, "worktrees", "fixture", "task"),
    base_commit_sha: await checked("git", ["rev-parse", "HEAD"], source),
  };
  await checked("git", ["worktree", "add", "-b", task.branch_name, task.worktree_path], source);
  const marker = join(dir, "executed");
  const program = join(dir, "marker");
  await writeFile(program, `#!/bin/sh\nprintf executed > '${marker}'\n`, {
    mode: 0o700,
  });
  return {
    dir,
    root,
    source,
    task,
    marker,
    program,
    git: new GitWorkspace(root),
  };
};
