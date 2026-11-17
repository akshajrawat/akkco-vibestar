import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

import { AdeError } from "../domain";

type OwnerFile = "vibestar-task-owner" | "vibestar-repair-owner" | "vibestar-finalization-owner";

export const readWorktreeOwner = async (directory: string, name: OwnerFile) => {
  const handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw new AdeError("ownership", "Worktree ownership marker could not be read safely.");
    },
  );

  if (!handle) return "";
  try {
    if (!(await handle.stat()).isFile())
      throw new AdeError("ownership", "Worktree ownership marker is not a regular file.");
    const buffer = Buffer.alloc(129);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 128)
      throw new AdeError("ownership", "Worktree ownership marker exceeds its limit.");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
};

export const writeWorktreeOwner = async (directory: string, name: OwnerFile, owner: string) => {
  const existing = await readWorktreeOwner(directory, name);
  if (existing) {
    if (existing !== owner)
      throw new AdeError(
        "ownership",
        "Worktree metadata belongs to another owner; it was preserved.",
      );
    return;
  }

  // Exclusive creation never follows or truncates a replaced marker.
  const handle = await open(
    join(directory, name),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );

  try {
    await handle.writeFile(owner);
  } finally {
    await handle.close();
  }
};
