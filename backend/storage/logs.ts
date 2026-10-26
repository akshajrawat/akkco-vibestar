import { open, realpath } from "node:fs/promises";
import { join } from "node:path";

import { AdeError } from "../domain";
import { inside, managedPath, safeFile } from "../workspace/paths";

export const readLogTail = async (
  root: string,
  taskId: string,
  runId: string | null,
  stream: "stdout" | "stderr",
  options?: { before?: number; after?: number; search?: string },
) => {
  try {
    const dir = await realpath(await managedPath(root, join("logs", taskId)));
    if (!inside(join(root, "logs"), dir))
      throw new AdeError("isolation", "Log directory is outside managed logs");

    const path = await safeFile(
      dir,
      runId ? `${runId}${stream === "stdout" ? ".jsonl" : ".stderr.log"}` : "preparation.jsonl",
    );

    const handle = await open(path, "r");
    try {
      const size = (await handle.stat()).size;
      const limit = options ? 256 * 1024 : 1024 * 1024;
      if (options?.search) {
        const matches: string[] = [];
        const query = options.search.toLowerCase();
        let position = Math.min(options.after || 0, size);
        let pending = Buffer.alloc(0);
        let cursor = position;
        let matchedBytes = 0;
        while (position < size && matches.length < 200 && matchedBytes < limit) {
          const buffer = Buffer.alloc(Math.min(limit, size - position));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          if (!bytesRead) break;
          position += bytesRead;
          pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
          let newline;
          while (
            (newline = pending.indexOf(10)) >= 0 &&
            matches.length < 200 &&
            matchedBytes < limit
          ) {
            const line = pending.subarray(0, newline + 1).toString("utf8");
            cursor += newline + 1;
            pending = pending.subarray(newline + 1);
            if (line.toLowerCase().includes(query)) {
              matches.push(line);
              matchedBytes += Buffer.byteLength(line);
            }
          }
        }

        if (matches.length < 200 && matchedBytes < limit && position === size) {
          if (pending.toString("utf8").toLowerCase().includes(query))
            matches.push(pending.toString("utf8"));
          cursor = size;
        }

        return {
          text: matches.join(""),
          truncated: cursor < size,
          start: options.after || 0,
          end: cursor,
          size,
        };
      }

      const end =
        options?.after !== undefined
          ? Math.min(size, options.after + limit)
          : Math.min(size, options?.before ?? size);

      let start =
        options?.after !== undefined ? Math.min(options.after, size) : Math.max(0, end - limit);

      const buffer = Buffer.alloc(
        Math.min(size - start, end - start + (options?.after !== undefined ? 4 : 0)),
      );

      const position = start;
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      let from = 0;
      let to = Math.min(bytesRead, end - start);
      if (options?.after === undefined && start > 0) {
        const newline = buffer.indexOf(10);
        if (newline >= 0 && newline < to - 1) from = newline + 1;
        else while (from < to && (buffer[from] & 0xc0) === 0x80) from++;
      } else if (end < size) {
        const newline = buffer.lastIndexOf(10, to - 1);
        if (newline >= 0) to = newline + 1;
        else while (to > 0 && (buffer[to] & 0xc0) === 0x80) to--;
      }

      start += from;
      return {
        text: buffer.subarray(from, to).toString("utf8"),
        truncated: start > 0,
        start,
        end: position + to,
        size,
      };
    } finally {
      await handle.close();
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { text: "", truncated: false, start: 0, end: 0, size: 0 };
    throw e;
  }
};
