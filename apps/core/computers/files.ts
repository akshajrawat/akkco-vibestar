import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";

import { AdeError } from "../domain";
import { redact } from "../execution/runtime/process";
import type { ComputerFiles } from "./contracts";

/** Walk through pinned directory descriptors. Workspace symlinks never grant host access. */
export const computerFiles = async (root: string, path: string): Promise<ComputerFiles> => {
  const parts = path ? path.split("/") : [];
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part === ".git" ||
        part.includes("\\") ||
        part.includes("\0"),
    )
  ) {
    throw new AdeError(
      "isolation",
      "Select a regular file or directory in this session's workspace.",
    );
  }

  let handle = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try {
    for (const [index, part] of parts.entries()) {
      const next = await open(
        `/proc/self/fd/${handle.fd}/${part}`,
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          (index < parts.length - 1 ? constants.O_DIRECTORY : 0),
      );

      await handle.close();
      handle = next;
    }

    const metadata = await handle.stat();
    if (metadata.isDirectory()) {
      const entries = await readdir(`/proc/self/fd/${handle.fd}`, { withFileTypes: true });
      if (entries.length > 5000) {
        throw new AdeError("file_limit", "This directory exceeds the 5,000-entry limit.");
      }

      return {
        path,
        text: null,
        entries: entries
          .filter((entry) => entry.name !== ".git" && (entry.isFile() || entry.isDirectory()))
          .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
          .sort(
            (a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name),
          ),
      };
    }

    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 1048576) {
      throw new AdeError("file_limit", "Preview regular text files up to 1 MiB.");
    }

    const buffer = Buffer.alloc(metadata.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (
      bytesRead !== metadata.size ||
      after.mtimeMs !== metadata.mtimeMs ||
      after.ctimeMs !== metadata.ctimeMs
    ) {
      throw new AdeError("stale_file", "The file changed during inspection. Open it again.");
    }

    const value = buffer.subarray(0, bytesRead);
    return {
      path,
      entries: [],
      text: value.includes(0) ? "Binary file" : redact(value.toString("utf8")),
    };
  } finally {
    await handle.close();
  }
};
