import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";

import { AdeError, type Task } from "../domain";
import { assertManagedWorkspace, managedWorkspaceFingerprint } from "../workspace/managed";
import { managedPath } from "../workspace/paths";

/** Managed files have no Git baseline. Inspect bounded owned files without fabricating a diff. */
export const managedFiles = async (root: string, task: Task, path?: string) => {
  if (task.workspace_kind === "managed" && !task.worktree_path && path === undefined)
    return { files: [] as string[], path: null, text: null, fingerprint: null };
  const cwd = await assertManagedWorkspace(root, task);
  const fingerprint = await managedWorkspaceFingerprint(root, task);
  const files: string[] = [];
  let entries = 0;

  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > 10000)
        throw new AdeError("file_limit", "The file listing exceeds 10,000 entries.");
      const name = await managedPath(root, join(directory, entry.name));
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) files.push(relative(cwd, name));
      else
        throw new AdeError(
          "ownership",
          "Managed file inspection cannot follow links or special files.",
        );
    }
  };

  await visit(cwd);
  files.sort();
  let text: string | null = null;
  if (path !== undefined) {
    if (!files.includes(path))
      throw new AdeError("isolation", "Select a file from this managed workspace.");
    const absolute = await managedPath(root, join(cwd, path));

    const handle = await open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );

    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size > 1048576 ||
        (await realpath(`/proc/self/fd/${handle.fd}`)) !== absolute
      )
        throw new AdeError("file_limit", "Inspect a regular owned text file no larger than 1 MiB.");
      const buffer = Buffer.alloc(before.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const after = await handle.stat();
      if (
        bytesRead !== before.size ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new AdeError("stale_file", "This file changed during inspection. Open it again.");
      const value = buffer.subarray(0, bytesRead);
      if (value.includes(0))
        throw new AdeError("binary_file", "Open this binary file in your editor.");
      text = value.toString("utf8");
    } finally {
      await handle.close();
    }
  }

  if (fingerprint !== (await managedWorkspaceFingerprint(root, task)))
    throw new AdeError("stale_file", "The workspace changed during inspection. Refresh its files.");
  return { files, path: path ?? null, text, fingerprint };
};
