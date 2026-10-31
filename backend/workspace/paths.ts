import { homedir } from "node:os";
import { realpath, stat, mkdir, lstat } from "node:fs/promises";
import { isAbsolute, join, relative, dirname, sep, resolve } from "node:path";

import { AdeError, slug, type WorkspaceAssignment, type Repository } from "../domain";
import { gitChecked } from "./git-command";
import { readWorktreeOwner } from "./ownership";

export const inside = (root: string, path: string) => {
  const r = relative(root, path);
  return r !== "" && !r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r);
};

// root is the canonical identity retained by createLayout, not a fresh trust boundary.
export const managedPath = async (root: string, path: string) => {
  const candidate = resolve(root, path);
  if (!inside(root, candidate) || (await realpath(root)) !== root)
    throw new AdeError(
      "isolation",
      "Managed storage root or path changed. Restore the original dedicated directory before retrying.",
    );
  let parent = root;
  for (const part of relative(root, candidate).split(sep)) {
    parent = join(parent, part);
    try {
      const entry = await lstat(parent);
      if (entry.isSymbolicLink())
        throw new AdeError(
          "isolation",
          `Managed storage path ${parent} is a symlink. Restore dedicated directories; Vibestar will not relocate or remove its target.`,
        );
      if (parent !== candidate && !entry.isDirectory())
        throw new AdeError("isolation", "A managed storage parent is not a directory.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }

  return candidate;
};

export const worktreePath = (
  root: string,
  repoId: string,
  number: number,
  scope: string,
  suffix = 0,
) => {
  if (!/^[a-zA-Z0-9-]+$/.test(repoId)) throw new AdeError("isolation", "Invalid repository ID");
  return join(root, "worktrees", repoId, `${number}-${slug(scope)}${suffix ? `-${suffix}` : ""}`);
};

const validateFilePath = (path: string) => {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.split("/").some((p) => !p || p === "." || p === ".." || p === ".git")
  )
    throw new AdeError("isolation", "Invalid relative file path");
};

export const workspaceEntry = async (root: string, path: string) => {
  validateFilePath(path);
  const canonicalRoot = await realpath(root);
  const destination = join(canonicalRoot, path);
  let current = canonicalRoot;
  const parts = path.split("/");
  for (const [index, part] of parts.entries()) {
    current = join(current, part);

    const metadata = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (["ENOENT", "ENOTDIR"].includes(error.code || "")) return null;
      throw error;
    });

    if (index === parts.length - 1) return { path: destination, metadata };
    // Git can retain a deleted descendant after its parent becomes a file/link.
    // It is absent from the working tree; never follow that parent into a target.
    if (!metadata?.isDirectory()) return { path: destination, metadata: null };
  }

  throw new AdeError("isolation", "Invalid workspace entry");
};

export const safeFile = async (root: string, path: string) => {
  validateFilePath(path);
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

export const taskRoot = async (
  root: string,
  task: WorkspaceAssignment,
  repository?: Repository,
) => {
  if (!/^[a-zA-Z0-9-]+$/.test(task.repo_id))
    throw new AdeError("isolation", "Invalid repository ID");
  if (task.workspace_mode === "source") {
    if (
      !repository ||
      repository.id !== task.repo_id ||
      repository.path !== task.worktree_path ||
      (await realpath(repository.path)) !== repository.path
    )
      throw new AdeError("ownership", "Source task no longer matches its registered checkout.");
    const cwd = repository.path;

    const common = await realpath(
      await gitChecked(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd),
    );

    const gitdir = await realpath(await gitChecked(["rev-parse", "--absolute-git-dir"], cwd));
    if (
      task.workspace_checkpoint?.git_common_dir !== common ||
      gitdir !== common ||
      common !== join(cwd, ".git") ||
      (await realpath(await gitChecked(["rev-parse", "--show-toplevel"], cwd))) !== cwd ||
      (await readWorktreeOwner(gitdir, "vibestar-task-owner")) !== task.id ||
      (await gitChecked(["symbolic-ref", "--short", "HEAD"], cwd)) !== task.branch_name ||
      (await gitChecked(
        ["config", "--local", "--get", `branch.${task.branch_name}.vibestarTask`],
        cwd,
      )) !== task.id
    )
      throw new AdeError(
        "ownership",
        "Source task branch or ownership changed; its files were preserved.",
      );
    return cwd;
  }

  const allowed = await managedPath(root, join("worktrees", task.repo_id));
  const path = await realpath(await managedPath(root, task.worktree_path));
  if (!inside(allowed, path))
    throw new AdeError("isolation", "Task worktree is outside its managed repository boundary");
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
      (name) => candidate === join(homedir(), name) || inside(join(homedir(), name), candidate),
    );

  if (!isAbsolute(root) || protectedRoot(resolve(root)))
    throw new AdeError(
      "invalid_input",
      "Choose a dedicated absolute data directory, not a home, system or provider state directory",
    );
  await mkdir(root, { recursive: true, mode: 0o700 });
  root = await realpath(root);
  if (protectedRoot(root))
    throw new AdeError("invalid_input", "Data directory resolves to a protected root");
  for (const d of [
    "repos",
    "worktrees",
    "logs",
    "artifacts",
    "state",
    "cache",
    "runtime",
    "telemetry",
  ]) {
    const directory = await managedPath(root, d);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await managedPath(root, d);
  }

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
