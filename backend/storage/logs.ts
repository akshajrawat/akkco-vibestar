import { open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { AdeError } from "../domain";
import { inside, safeFile } from "../workspace/paths";
export const readLogTail = async (
  root: string,
  taskId: string,
  runId: string | null,
  stream: "stdout" | "stderr",
) => {
  try {
    const dir = await realpath(join(root, "logs", taskId));
    if (!inside(join(root, "logs"), dir))
      throw new AdeError("isolation", "Log directory is outside managed logs");
    const path = await safeFile(
      dir,
      runId
        ? `${runId}${stream === "stdout" ? ".jsonl" : ".stderr.log"}`
        : "preparation.jsonl",
    );
    const handle = await open(path, "r");
    try {
      const size = (await handle.stat()).size;
      const start = Math.max(0, size - 1024 * 1024);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return { text: buffer.toString("utf8"), truncated: start > 0 };
    } finally {
      await handle.close();
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { text: "", truncated: false };
    throw e;
  }
};
