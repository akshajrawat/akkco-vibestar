import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, relative } from "node:path";

import { AdeError, type WorkspaceAssignment } from "../domain";
import { managedPath } from "./paths";
import { readWorktreeOwner, writeWorktreeOwner } from "./ownership";

const location = async (root: string, task: WorkspaceAssignment) => {
  if (
    task.repo_id !== null ||
    task.workspace_kind !== "managed" ||
    !/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(task.id) ||
    task.branch_name ||
    task.workspace_mode
  ) {
    throw new AdeError("ownership", "This task is not an owned repository-free workspace.");
  }

  const owner = join(await managedPath(root, "workspaces"), task.id);
  const files = join(owner, "files");
  if (task.worktree_path && task.worktree_path !== files) {
    throw new AdeError("ownership", "The managed task workspace identity changed.");
  }

  return { owner, files };
};

const assertUsable = (task: WorkspaceAssignment) => {
  if (task.managed_removal_identity !== undefined) {
    throw new AdeError("recovery", "Managed workspace removal is pending. Retry Viber deletion.");
  }
};

/** The owner marker stays outside the directory mounted writable for the agent. */
export const prepareManagedWorkspace = async <T extends WorkspaceAssignment>(
  root: string,
  task: T,
): Promise<T> => {
  assertUsable(task);
  const { owner, files } = await location(root, task);
  await managedPath(root, "workspaces");
  await mkdir(join(root, "workspaces"), { recursive: true, mode: 0o700 });
  let created = false;
  try {
    await mkdir(await managedPath(root, owner), { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }

  await managedPath(root, owner);
  if (created) {
    await writeWorktreeOwner(owner, "vibestar-task-owner", task.id);
  }

  if ((await readWorktreeOwner(owner, "vibestar-task-owner")) !== task.id) {
    throw new AdeError(
      "ownership",
      "Unknown managed workspace contents were preserved. Inspect their owner before retrying.",
    );
  }

  await managedPath(root, files);

  await mkdir(files, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") {
      throw error;
    }
  });

  const prepared = { ...task, worktree_path: files };
  await assertManagedWorkspace(root, prepared);
  return prepared;
};

export const assertManagedWorkspace = async (root: string, task: WorkspaceAssignment) => {
  assertUsable(task);
  const { owner, files } = await location(root, task);
  await managedPath(root, owner);
  if (
    task.worktree_path !== files ||
    (await readWorktreeOwner(owner, "vibestar-task-owner")) !== task.id
  ) {
    throw new AdeError("ownership", "Managed workspace ownership could not be proved.");
  }

  await managedPath(root, files);
  if (!(await lstat(files)).isDirectory() || (await realpath(files)) !== files) {
    throw new AdeError("ownership", "Managed workspace is not its canonical directory.");
  }

  return files;
};

const directoryIdentity = async (path: string, legacy = false) => {
  try {
    const entry = await lstat(path, { bigint: true });
    if (!entry.isDirectory()) {
      throw new AdeError("ownership", "Managed workspace removal requires its original directory.");
    }

    const identity = `${entry.dev}:${entry.ino}`;
    return legacy ? `${identity}:${entry.birthtimeNs}` : identity;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
};

export const removeManagedWorkspace = async (
  root: string,
  task: WorkspaceAssignment,
  save: () => void,
) => {
  const { owner, files } = await location(root, task);
  if (task.worktree_path !== files) {
    throw new AdeError("ownership", "The managed task workspace identity changed.");
  }

  const changed = () =>
    new AdeError("ownership", "Managed workspace directory changed during removal.");

  const pending = task.managed_removal_identity;

  const checkpoint =
    /^(moving|quarantined):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9]+:[0-9]+)$/.exec(
      pending ?? "",
    );

  let phase = checkpoint?.[1] ?? "moving";
  let token = checkpoint?.[2];
  let identity = checkpoint?.[3];

  const record = () => {
    task.managed_removal_identity = `${phase}:${token}:${identity}`;
    save();
  };

  if (!checkpoint) {
    const current = await directoryIdentity(await managedPath(root, owner));
    if (
      current === null ||
      (pending !== undefined &&
        pending !== (await directoryIdentity(await managedPath(root, owner), true)))
    ) {
      throw changed();
    }

    // An older checkpoint did not have a quarantine. Re-prove ownership; a
    // legacy partial removal which already lost its marker must fail closed.
    await assertManagedWorkspace(root, { ...task, managed_removal_identity: undefined });
    identity = current;
    token = randomUUID();
  }

  // The target is under the same filesystem by construction (rename never
  // falls back to copying), outside the
  // directory exposed writable to a provider. Never recurse at the live path.
  const pendingDirectory = await managedPath(root, join("workspaces", "pending-delete"));
  await mkdir(pendingDirectory, { recursive: true, mode: 0o700 });
  const quarantine = join(pendingDirectory, `${task.id}-${token}`);
  let quarantined = await directoryIdentity(await managedPath(root, quarantine));
  if (quarantined !== null && (!checkpoint || quarantined !== identity)) {
    throw changed();
  }

  if (!checkpoint) {
    record();
  }

  if (phase === "moving") {
    if (quarantined === null) {
      if ((await directoryIdentity(await managedPath(root, owner))) !== identity) {
        throw changed();
      }

      // Also require the marker and live files before retrying a move which
      // never happened. An old inode value alone does not prove ownership.
      await assertManagedWorkspace(root, { ...task, managed_removal_identity: undefined });
      if (
        (await directoryIdentity(await managedPath(root, quarantine))) !== null ||
        (await directoryIdentity(await managedPath(root, owner))) !== identity
      ) {
        throw changed();
      }

      await rename(owner, quarantine);
      quarantined = await directoryIdentity(await managedPath(root, quarantine));
      if (quarantined !== identity) {
        throw changed();
      }
    }

    // Persist the move before removing any contents. After this point a
    // recreated original path is irrelevant, even if cleanup already ended.
    phase = "quarantined";
    record();
  }

  if (quarantined !== null) {
    if ((await directoryIdentity(await managedPath(root, quarantine))) !== identity) {
      throw changed();
    }

    await rm(quarantine, { recursive: true, force: true });
  }

  task.worktree_path = "";
  task.managed_removal_identity = undefined;
  save();
};

const inspectManagedWorkspace = async (
  root: string,
  task: WorkspaceAssignment,
  hash?: ReturnType<typeof createHash>,
) => {
  const cwd = await assertManagedWorkspace(root, task);
  let entries = 0;
  let bytes = 0;

  const visit = async (directory: string) => {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      entries++;
      if (entries > 10000) {
        throw new AdeError(
          "fingerprint",
          "Managed workspace exceeds the 10,000-entry integrity limit.",
        );
      }

      const path = await managedPath(root, join(directory, name));
      const metadata = await lstat(path, { bigint: true });
      hash?.update(JSON.stringify([relative(cwd, path), String(metadata.mode)]));
      if (metadata.isDirectory()) {
        await visit(path);
        continue;
      }

      if (!metadata.isFile() || metadata.nlink !== 1n) {
        throw new AdeError(
          "ownership",
          "Managed workspace integrity cannot follow links or special files.",
        );
      }

      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat({ bigint: true });
        if (
          !before.isFile() ||
          before.nlink !== 1n ||
          before.ino !== metadata.ino ||
          before.dev !== metadata.dev
        ) {
          throw new AdeError("ownership", "A workspace file changed identity during inspection.");
        }

        if (!hash) {
          continue;
        }

        bytes += Number(metadata.size);
        if (bytes > 64 * 1024 * 1024) {
          throw new AdeError(
            "fingerprint",
            "Managed workspace exceeds the 64 MiB integrity limit. Reduce its contents before running an agent.",
          );
        }

        const fileHash = createHash("sha256");
        const buffer = Buffer.alloc(65536);
        let count = 0;
        while (true) {
          const read = await handle.read(buffer, 0, buffer.length, null);
          if (!read.bytesRead) {
            break;
          }

          count += read.bytesRead;
          if (count > Number(metadata.size)) {
            throw new AdeError("fingerprint", "A workspace file changed during inspection.");
          }

          fileHash.update(buffer.subarray(0, read.bytesRead));
        }

        const after = await handle.stat({ bigint: true });
        if (
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs ||
          count !== Number(metadata.size)
        ) {
          throw new AdeError("fingerprint", "A workspace file changed during inspection.");
        }

        hash.update(fileHash.digest("hex"));
      } finally {
        await handle.close();
      }
    }

    if (JSON.stringify(names) !== JSON.stringify((await readdir(directory)).sort())) {
      throw new AdeError("fingerprint", "Workspace entries changed during inspection.");
    }
  };

  await visit(cwd);
  await assertManagedWorkspace(root, task);
};

export const assertManagedWorkspaceEntries = (root: string, task: WorkspaceAssignment) =>
  inspectManagedWorkspace(root, task);

/** Bounded source integrity for workspaces without Git; links and unsupported files fail closed. */
export const managedWorkspaceFingerprint = async (root: string, task: WorkspaceAssignment) => {
  const hash = createHash("sha256").update(task.id);
  await inspectManagedWorkspace(root, task, hash);
  return `managed-v1:${hash.digest("hex")}`;
};
