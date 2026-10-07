import { homedir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { AdeError, type Task } from "../domain";
import { exists, taskRoot, inside } from "../workspace/paths";
import type { Database } from "../storage/database";
import { checked } from "./process";
export const sandboxInvocation = async (
  root: string,
  db: Database,
  task: Task | null,
  invocation: { program: string; args: string[]; input?: string },
  readOnly: boolean,
  schemaPath?: string,
  provider?: string,
  analysisWorkspace?: string,
) => {
  if (process.platform !== "linux")
    throw new AdeError(
      "sandbox",
      "The execution core must run inside Linux/WSL.",
    );
  const home = await realpath(homedir());
  const cwd = task
    ? await taskRoot(root, task)
    : await realpath(analysisWorkspace || "");
  if (!task && !inside(join(root, "cache", "utility"), cwd))
    throw new AdeError(
      "isolation",
      "PR analysis workspace is outside the managed root",
    );
  const repository = task ? db.repository(task.repo_id) : null;
  const repo = repository ? await realpath(repository.path) : null;
  if (
    repo &&
    repository?.source !== "imported" &&
    !inside(join(root, "repos"), repo)
  )
    throw new AdeError(
      "isolation",
      "Managed clone is outside the repository root",
    );
  const args = [
    "--die-with-parent",
    "--unsetenv",
    "SSH_AUTH_SOCK",
    "--unsetenv",
    "DBUS_SESSION_BUS_ADDRESS",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--ro-bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/home",
    "--tmpfs",
    "/mnt",
    "--tmpfs",
    root,
    "--dir",
    home,
    "--dir",
    join(home, ".cache"),
  ];
  // These provider-owned directories are mounted without inspecting any credential contents.
  // CLI authentication and conversation storage remain entirely provider-owned.
  const resolver = await realpath("/etc/resolv.conf");
  args.push("--ro-bind", resolver, resolver);
  if (provider) {
    const state = join(home, provider === "antigravity" ? ".gemini" : ".codex");
    if (await exists(state)) args.push("--bind", state, state);
    const resolved = await checked("which", [invocation.program], root);
    const executable = await realpath(resolved);
    if (inside(home, executable) && !executable.startsWith(`${state}/`)) {
      args.push("--ro-bind", executable, executable);
    }
    if (
      resolved !== executable &&
      inside(home, resolved) &&
      !resolved.startsWith(`${state}/`)
    )
      args.push("--ro-bind", executable, resolved);
  }
  // Native tools installed in the user's bin directory remain available read-only.
  const localBin = join(home, ".local", "bin");
  if (await exists(localBin)) args.push("--ro-bind", localBin, localBin);
  if (repo) {
    const common = await realpath(
      await checked(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd,
      ),
    );
    const gitdir = await realpath(
      await checked("git", ["rev-parse", "--absolute-git-dir"], cwd),
    );
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
  if (schemaPath) {
    const schema = await realpath(schemaPath);
    if (!inside(join(root, "artifacts"), schema))
      throw new AdeError("isolation", "Schema is outside managed artifacts");
    args.push("--ro-bind", schema, schema);
  }
  args.push("--chdir", cwd, "--", invocation.program, ...invocation.args);
  return { program: "bwrap", args, input: invocation.input };
};
