import { gitChecked } from "../../workspace/git-command";
import { homedir } from "node:os";
import { dirname, join, isAbsolute, resolve } from "node:path";
import { realpath, lstat, readlink } from "node:fs/promises";
import { AdeError, type WorkspaceAssignment } from "../../domain";
import { exists, taskRoot, inside, managedPath } from "../../workspace/paths";
import type { Database } from "../../storage/database";
import { checked, cleanEnvironment } from "./process";
import { taskRuntime } from "../../workspace/runtime";
import type { VerificationEnvironment } from "../verification/browser/contracts";
export const sandboxInvocation = async (
  root: string,
  db: Database,
  task: WorkspaceAssignment | null,
  invocation: {
    program: string;
    args: string[];
    input?: string;
    verificationEnvironment?: VerificationEnvironment;
  },
  readOnly: boolean,
  schemaPath?: string,
  provider?: string,
  analysisWorkspace?: string,
  contextPaths: string[] = [],
) => {
  if (process.platform !== "linux")
    throw new AdeError("sandbox", "The execution core must run inside Linux/WSL.");
  const home = await realpath(homedir());
  if (!task) await managedPath(root, analysisWorkspace || "");
  const cwd = task ? await taskRoot(root, task) : await realpath(analysisWorkspace || "");
  if (!task && !inside(join(root, "cache", "utility"), cwd))
    throw new AdeError("isolation", "PR analysis workspace is outside the managed root");
  const repository = task ? db.repository(task.repo_id) : null;
  const repo = repository ? await realpath(repository.path) : null;
  if (repo && repository?.source !== "imported" && !inside(join(root, "repos"), repo))
    throw new AdeError("isolation", "Managed clone is outside the repository root");
  const args = [
    "--die-with-parent",
    "--unsetenv",
    "SSH_AUTH_SOCK",
    "--unsetenv",
    "DBUS_SESSION_BUS_ADDRESS",
    "--unsetenv",
    "XDG_RUNTIME_DIR",
    "--unsetenv",
    "DISPLAY",
    "--unsetenv",
    "WAYLAND_DISPLAY",
    "--unsetenv",
    "WSL_INTEROP",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    home,
    "--dir",
    join(home, ".cache"),
    "--setenv",
    "HOME",
    home,
    "--setenv",
    "TMPDIR",
    "/tmp",
  ];
  if (invocation.verificationEnvironment === "installed_browsers") {
    if (provider)
      throw new AdeError(
        "sandbox",
        "Installed browser mounts are limited to explicit manual verification.",
      );
    const cacheParent = join(home, ".cache");
    const cache = join(cacheParent, "ms-playwright");
    const parent = await lstat(cacheParent).catch(() => null);
    const entry = await lstat(cache).catch(() => null);
    if (parent?.isSymbolicLink() || entry?.isSymbolicLink())
      throw new AdeError(
        "sandbox",
        "The installed browser cache must be a physical directory, not a symlink.",
      );
    if (entry?.isDirectory()) args.push("--ro-bind", cache, cache);
    const chrome = "/opt/google/chrome";
    const installation = await lstat(chrome).catch(() => null);
    if (installation?.isDirectory() && (await realpath(chrome)) === chrome)
      args.push("--ro-bind", chrome, chrome);
  }
  // Bubblewrap starts with an empty root. Only reviewed system installations
  // and individual runtime configuration files are visible, never the host /.
  for (const path of ["/usr", "/bin", "/sbin", "/lib", "/lib64"]) {
    if (!(await exists(path))) continue;
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) args.push("--symlink", await readlink(path), path);
    else args.push("--ro-bind", path, path);
  }
  for (const path of [
    "/etc/passwd",
    "/etc/group",
    "/etc/nsswitch.conf",
    "/etc/hosts",
    "/etc/host.conf",
    "/etc/gai.conf",
    "/etc/localtime",
    "/etc/ld.so.cache",
    "/etc/alternatives",
    "/etc/ssl/certs",
    "/etc/pki/tls/certs",
  ]) {
    if (await exists(path)) args.push("--ro-bind", await realpath(path), path);
  }
  // These provider-owned directories are mounted without inspecting any credential contents.
  // CLI authentication and conversation storage remain entirely provider-owned.
  const resolver = await realpath("/etc/resolv.conf");
  args.push("--ro-bind", resolver, "/etc/resolv.conf");
  const mountExecutable = async (program: string) => {
    const resolved = isAbsolute(program)
      ? program
      : resolve(cwd, program.includes("/") ? program : await checked("which", [program], cwd));
    if (inside(cwd, resolved)) return;
    const executable = await realpath(resolved);
    if (
      inside("/usr", executable) ||
      ["/bin", "/sbin", "/lib", "/lib64"].some((path) => inside(path, executable))
    )
      return;
    let installation = executable;
    // Package entrypoints need their own modules/native package siblings. Node
    // version-manager installations include the interpreter and npm toolchain.
    const npm = executable.indexOf("/node_modules/");
    if (npm >= 0) {
      const suffix = executable.slice(npm + "/node_modules/".length).split("/");
      installation = join(
        executable.slice(0, npm),
        "node_modules",
        suffix[0],
        ...(suffix[0].startsWith("@") ? [suffix[1]] : []),
      );
      if (suffix[0] === "@openai") installation = dirname(installation);
    } else if (/\/\.nvm\/versions\/node\/[^/]+\/bin\//.test(executable)) {
      installation = dirname(dirname(executable));
    }
    args.push("--ro-bind", installation, installation);
    if (resolved !== executable) args.push("--ro-bind", executable, resolved);
  };
  await mountExecutable(invocation.program);
  // Node/npm may live in a version-manager prefix outside system directories.
  // These are interpreter installations, not the user's home or runtime state.
  for (const program of ["node", "npm"]) {
    const detected = await checked("which", [program], root).catch(() => "");
    if (detected) await mountExecutable(detected);
  }
  if (provider) {
    const state = join(home, provider === "antigravity" ? ".gemini" : ".codex");
    if (await exists(state)) args.push("--bind", await realpath(state), state);
  }
  // Native tools installed in the user's bin directory remain available read-only.
  const localBin = join(home, ".local", "bin");
  if (await exists(localBin)) args.push("--ro-bind", localBin, localBin);
  if (repo) {
    const common = await realpath(
      await gitChecked(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd),
    );
    const gitdir = await realpath(await gitChecked(["rev-parse", "--absolute-git-dir"], cwd));
    if (!inside(join(common, "worktrees"), gitdir))
      throw new AdeError("isolation", "Task has invalid Git worktree metadata");
    args.push(
      "--ro-bind",
      common,
      common,
      "--tmpfs",
      join(common, "worktrees"),
      readOnly ? "--ro-bind" : "--bind",
      gitdir,
      gitdir,
    );
  }
  args.push(readOnly ? "--ro-bind" : "--bind", cwd, cwd);
  if (repo) {
    const runtime = await taskRuntime(repo, cwd, true);
    for (const mount of runtime.mounts) args.push("--ro-bind", mount.source, mount.target);
    if (runtime.python && runtime.pythonPrefix)
      args.push(
        "--setenv",
        "PATH",
        `${join(runtime.pythonPrefix, "bin")}:${cleanEnvironment().PATH}`,
        "--setenv",
        "VIRTUAL_ENV",
        runtime.pythonPrefix,
        "--setenv",
        "PYTHONDONTWRITEBYTECODE",
        "1",
      );
  }
  if (schemaPath) {
    await managedPath(root, schemaPath);
    const schema = await realpath(schemaPath);
    if (!inside(join(root, "artifacts"), schema))
      throw new AdeError("isolation", "Schema is outside managed artifacts");
    args.push("--ro-bind", schema, schema);
  }
  for (const path of contextPaths) {
    await managedPath(root, path);
    const context = await realpath(path);
    if (!inside(join(root, "artifacts"), context))
      throw new AdeError("isolation", "Repair context is outside managed artifacts");
    args.push("--ro-bind", context, context);
  }
  args.push("--chdir", cwd, "--", invocation.program, ...invocation.args);
  return { program: "bwrap", args, input: invocation.input };
};
