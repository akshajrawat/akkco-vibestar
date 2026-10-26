import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { AdeError } from "../domain";
import { managedPath, workspaceEntry } from "../workspace/paths";

export const inspectSelectedFile = async (cwd: string, path: string, untracked = false) => {
  const entry = await workspaceEntry(cwd, path);
  await managedPath(cwd, path);
  if (
    /(?:^|\/)(?:\.codex|\.gemini|\.ssh|\.aws|\.azure|\.kube)(?:\/|$)/i.test(path) ||
    /(?:^|\/)\.config\/gh(?:\/|$)/i.test(path) ||
    /(?:^|\/)\.git-credentials$/i.test(path) ||
    /(?:^|\/)(?:\.env(?:\..*)?|\.codex|\.gemini|\.ssh|credentials(?:\..*)?|id_(?:rsa|ed25519)|[^/]*\.(?:pem|key|p12|pfx))$/i.test(
      path,
    ) ||
    (untracked &&
      (/(?:^|\/)(?:node_modules|dist|build|coverage|\.cache|debug|playwright-report|test-results)(?:\/|$)/i.test(
        path,
      ) ||
        /(?:^|\/)(?:debug[^/]*\.(?:txt|log)|[^/]*\.(?:log|tmp|bak))$/i.test(path)))
  )
    throw new AdeError(
      "unsafe_file",
      "Credential, private-key or unreviewed generated paths cannot be selected.",
    );
  if (!entry.metadata) return { bytes: null, mode: 0o644, size: 0 };
  if (!entry.metadata.isFile() || entry.metadata.isSymbolicLink())
    throw new AdeError(
      "unsafe_file",
      "Only regular files and deletions can be selected; links and submodules require separate review.",
    );
  const file = await open(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > 4 * 1024 * 1024)
      throw new AdeError(
        "unsafe_file",
        "Selected file exceeds the 4 MiB content inspection limit.",
      );
    const bytes = await file.readFile();
    if (bytes.includes(0) && (untracked || bytes.length > 1024 * 1024))
      throw new AdeError(
        "unsafe_file",
        "Unexpected new or large binary content requires separate review.",
      );
    const text = bytes.toString("utf8");
    if (
      /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/.test(text) ||
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{20,})\b/.test(
        text,
      ) ||
      /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|oauth[_-]?token|_authToken|npmAuthToken|aws_secret_access_key|password|client[_-]?secret)\s*[=:]\s*["']?[A-Za-z0-9_+/-]{24,}/i.test(
        text,
      )
    )
      throw new AdeError(
        "unsafe_file",
        "Selected content appears to contain a credential or private key. Remove it before review.",
      );
    return {
      bytes,
      mode: metadata.mode & 0o111 ? 0o755 : 0o644,
      size: bytes.length,
    };
  } finally {
    await file.close();
  }
};
