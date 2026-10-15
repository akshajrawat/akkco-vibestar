import { homedir } from "node:os";
import { realpath, stat, mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, dirname, sep, resolve } from "node:path";
import { AdeError, slug, type WorkspaceAssignment } from "../domain";
export const inside = (root: string, path: string) => {
  const r = relative(root, path);
  return r !== "" && !r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r);
};
export const worktreePath = (
  root: string,
  repoId: string,
  number: number,
  scope: string,
  suffix = 0,
) => {
  if (!/^[a-zA-Z0-9-]+$/.test(repoId))
    throw new AdeError("isolation", "Invalid repository ID");
  return join(
    root,
    "worktrees",
    repoId,
    `${number}-${slug(scope)}${suffix ? `-${suffix}` : ""}`,
  );
};
export const safeFile = async (root: string, path: string) => {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.split("/").some((p) => !p || p === "." || p === ".." || p === ".git")
  )
    throw new AdeError("isolation", "Invalid relative file path");
  const canonicalRoot = await realpath(root);
  const file = join(canonicalRoot, path);
  let parent = file;
  while (true) {
    try {
      const actual = await realpath(parent);
      if (actual !== canonicalRoot && !inside(canonicalRoot, actual))
        throw new AdeError("isolation", "Symlink escapes assigned worktree");
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const next = dirname(parent);
      if (next === parent) throw e;
      parent = next;
    }
  }
  return file;
};
export const taskRoot = async (root: string, task: WorkspaceAssignment) => {
  const path = await realpath(task.worktree_path);
  const allowed = await realpath(join(root, "worktrees", task.repo_id));
  if (!inside(allowed, path))
    throw new AdeError(
      "isolation",
      "Task worktree is outside its managed repository boundary",
    );
  return path;
};
export const createLayout = async (root: string) => {
  const protectedRoot = (candidate: string) =>
    candidate === homedir() ||
    inside(candidate, homedir()) ||
    [
      "/bin",
      "/dev",
      "/etc",
      "/opt",
      "/proc",
      "/run",
      "/sbin",
      "/srv",
      "/sys",
      "/tmp",
      "/usr",
      "/var",
      "/mnt",
    ].includes(candidate) ||
    [".codex", ".gemini"].some(
      (name) =>
        candidate === join(homedir(), name) ||
        inside(join(homedir(), name), candidate),
    );
  if (!isAbsolute(root) || protectedRoot(resolve(root)))
    throw new AdeError(
      "invalid_input",
      "Choose a dedicated absolute data directory, not a home, system or provider state directory",
    );
  await mkdir(root, { recursive: true, mode: 0o700 });
  root = await realpath(root);
  if (protectedRoot(root))
    throw new AdeError(
      "invalid_input",
      "Data directory resolves to a protected root",
    );
  for (const d of [
    "repos",
    "worktrees",
    "logs",
    "artifacts",
    "state",
    "cache",
    "runtime",
    "telemetry",
  ])
    await mkdir(join(root, d), { recursive: true, mode: 0o700 });
  return root;
};
export const exists = async (path: string) =>
  stat(path).then(
    () => true,
    (e) => {
      if (e.code === "ENOENT") return false;
      throw e;
    },
  );
