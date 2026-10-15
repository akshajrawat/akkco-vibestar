import { createHash } from "node:crypto";

export const fileHash = (original: string, modified: string) =>
  createHash("sha256")
    .update(original)
    .update("\0")
    .update(modified)
    .digest("hex");
