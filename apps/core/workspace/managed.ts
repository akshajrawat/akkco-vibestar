import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";

import { AdeError, type Task, type WorkspaceAssignment } from "../domain";
import { managedPath } from "./paths";
import { readWorktreeOwner, writeWorktreeOwner } from "./ownership";

const location = async (root: string, task: WorkspaceAssignment) => {
  if (
    task.repo_id !== null ||
    task.workspace_kind !== "managed" ||
    !/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(task.id) ||
    task.branch_name ||
    task.workspace_mode
  )
    throw new AdeError("ownership", "This task is not an owned repository-free workspace.");
  const owner = await managedPath(root, join("workspaces", task.id));
  const files = join(owner, "files");
  if (task.worktree_path && task.worktree_path !== files)
    throw new AdeError("ownership", "The managed task workspace identity changed.");
  return { owner, files };
};

/** The owner marker stays outside the directory mounted writable for the agent. */
export const prepareManagedWorkspace = async (root: string, task: Task) => {
  const { owner, files } = await location(root, task);
  await managedPath(root, "workspaces");
  await mkdir(join(root, "workspaces"), { recursive: true, mode: 0o700 });
  let created = false;
  try {
    await mkdir(owner, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  await managedPath(root, owner);
  if (created) await writeWorktreeOwner(owner, "vibestar-task-owner", task.id);
  if ((await readWorktreeOwner(owner, "vibestar-task-owner")) !== task.id)
    throw new AdeError(
      "ownership",
      "Unknown managed workspace contents were preserved. Inspect their owner before retrying.",
    );
  await managedPath(root, files);

  await mkdir(files, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });

  const prepared = { ...task, worktree_path: files };
  await assertManagedWorkspace(root, prepared);
  return prepared;
};

export const assertManagedWorkspace = async (root: string, task: WorkspaceAssignment) => {
  const { owner, files } = await location(root, task);
  if (
    task.worktree_path !== files ||
    (await readWorktreeOwner(owner, "vibestar-task-owner")) !== task.id
  )
    throw new AdeError("ownership", "Managed workspace ownership could not be proved.");
  await managedPath(root, files);
  if (!(await lstat(files)).isDirectory() || (await realpath(files)) !== files)
    throw new AdeError("ownership", "Managed workspace is not its canonical directory.");
  return files;
};

/** Bounded source integrity for workspaces without Git; links and unsupported files fail closed. */
export const managedWorkspaceFingerprint = async (root: string, task: WorkspaceAssignment) => {
  const cwd = await assertManagedWorkspace(root, task);
  const hash = createHash("sha256").update(task.id);
  let entries = 0;
  let bytes = 0;

  const visit = async (directory: string) => {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      entries++;
      if (entries > 10000)
        throw new AdeError(
          "fingerprint",
          "Managed workspace exceeds the 10,000-entry integrity limit.",
        );
      const path = await managedPath(root, join(directory, name));
      const metadata = await lstat(path, { bigint: true });
      hash.update(JSON.stringify([relative(cwd, path), String(metadata.mode)]));
      if (metadata.isDirectory()) {
        await visit(path);
        continue;
      }

      if (!metadata.isFile() || metadata.nlink !== 1n)
        throw new AdeError(
          "ownership",
          "Managed workspace integrity cannot follow links or special files.",
        );
      bytes += Number(metadata.size);
      if (bytes > 64 * 1024 * 1024)
        throw new AdeError(
          "fingerprint",
          "Managed workspace exceeds the 64 MiB integrity limit. Reduce its contents before running an agent.",
        );
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const fileHash = createHash("sha256");
      try {
        const before = await handle.stat({ bigint: true });
        if (
          !before.isFile() ||
          before.nlink !== 1n ||
          before.ino !== metadata.ino ||
          before.dev !== metadata.dev
        )
          throw new AdeError("ownership", "A workspace file changed identity during inspection.");
        const buffer = Buffer.alloc(65536);
        let count = 0;
        while (true) {
          const read = await handle.read(buffer, 0, buffer.length, null);
          if (!read.bytesRead) break;
          count += read.bytesRead;
          if (count > Number(metadata.size))
            throw new AdeError("fingerprint", "A workspace file changed during inspection.");
          fileHash.update(buffer.subarray(0, read.bytesRead));
        }

        const after = await handle.stat({ bigint: true });
        if (
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs ||
          count !== Number(metadata.size)
        )
          throw new AdeError("fingerprint", "A workspace file changed during inspection.");
        hash.update(fileHash.digest("hex"));
      } finally {
        await handle.close();
      }
    }

    if (JSON.stringify(names) !== JSON.stringify((await readdir(directory)).sort()))
      throw new AdeError("fingerprint", "Workspace entries changed during inspection.");
  };

  await visit(cwd);
  await assertManagedWorkspace(root, task);
  return `managed-v1:${hash.digest("hex")}`;
};
