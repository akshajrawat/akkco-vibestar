import { gitCapture, gitExecute } from "./git-command";
import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { inside } from "./paths";
import { AdeError } from "../domain";

// Reuse installed, ignored dependencies without exposing the source checkout.
export const taskRuntime = async (source: string, worktree: string, connect = false) => {
  source = await realpath(source);
  worktree = await realpath(worktree);
  const mounts: { source: string; target: string }[] = [];
  const dependencies: string[] = [];
  const warnings: string[] = [];
  const dependencyNames = ["node_modules", "third_party", ".venv", "venv"];
  const candidates = new Set(dependencyNames);

  const ignoredDirectories = await gitExecute({
    program: "git",
    args: ["ls-files", "--others", "--ignored", "--directory", "--exclude-standard", "-z"],
    cwd: source,
    rawStdoutForIntegrity: true,
  });

  if (ignoredDirectories.code !== 0)
    throw new AdeError("runtime", "Cannot inspect existing repository dependencies.");

  for (const path of ignoredDirectories.stdout.split("\0")) {
    if (!path.endsWith("/")) continue;
    const name = path.slice(0, -1);
    if (dependencyNames.includes(basename(name))) candidates.add(name);
  }

  for (const name of candidates) {
    const path = join(source, name);
    const target = join(worktree, name);
    const installed = await realpath(path).catch(() => null);
    if (
      installed !== path ||
      !inside(source, installed) ||
      !inside(worktree, target) ||
      !(await lstat(installed)).isDirectory() ||
      (await realpath(dirname(target)).catch(() => null)) !== dirname(target)
    )
      continue;
    const tracked = await gitCapture(["ls-files", "--", name], worktree);
    const sourceTracked = await gitCapture(["ls-files", "--", name], source);

    const ignored = await gitCapture(
      ["check-ignore", "--", `${name}/.vibestar-runtime-probe`],
      worktree,
    );

    if (
      tracked.code !== 0 ||
      sourceTracked.code !== 0 ||
      tracked.stdout.trim() ||
      sourceTracked.stdout.trim() ||
      ignored.code !== 0
    )
      continue;
    if (source === worktree) {
      mounts.push({ source: installed, target });
      dependencies.push(name);
      continue;
    }

    const entry = await lstat(target).catch(() => null);
    if (!entry && connect) await mkdir(target);
    if ((!entry && connect) || (entry?.isDirectory() && (await readdir(target)).length === 0)) {
      mounts.push({ source: installed, target: path }, { source: installed, target });
      dependencies.push(name);
    }
  }

  // Some projects install their toolchain beside the checkout (e.g. oppia_tools).
  // Preserve that explicit project naming convention inside the sandbox only.
  const toolchainName = `${basename(source)}_tools`;
  const toolchain = join(dirname(source), toolchainName);
  const installedToolchain = await realpath(toolchain).catch(() => null);
  if (installedToolchain === toolchain && (await lstat(toolchain)).isDirectory()) {
    mounts.push({
      source: toolchain,
      target: join(dirname(worktree), toolchainName),
    });

    dependencies.push(`../${toolchainName}`);
  }

  let python: string | null = null;
  let pythonPrefix: string | null = null;

  const versionFile =
    (await readFile(join(worktree, ".python-version"), "utf8").catch(() => null)) ??
    (await readFile(join(source, ".python-version"), "utf8").catch(() => null));

  const version = versionFile?.trim();
  if (
    version &&
    (version.length > 200 || !/^[\w.-]+$/.test(version) || [".", ".."].includes(version))
  )
    warnings.push(
      "Invalid .python-version selection was ignored; no arbitrary environment path was mounted.",
    );
  const pythonCandidates = [join(worktree, ".venv"), join(worktree, "venv")];
  for (const name of [".venv", "venv"])
    if (dependencies.includes(name)) pythonCandidates.push(join(source, name));
  if (
    version &&
    version.length <= 200 &&
    /^[\w.-]+$/.test(version) &&
    ![".", ".."].includes(version)
  )
    pythonCandidates.unshift(join(homedir(), ".pyenv", "versions", version));
  const versions = await realpath(join(homedir(), ".pyenv", "versions")).catch(() => null);
  for (const candidate of pythonCandidates) {
    const prefix = await realpath(candidate).catch(() => null);
    if (
      !prefix ||
      !(
        inside(source, prefix) ||
        inside(worktree, prefix) ||
        (versions && inside(versions, prefix))
      )
    )
      continue;
    const binary = await realpath(join(prefix, "bin", "python3")).catch(() => null);
    if (!binary) continue;
    const base = dirname(dirname(binary));
    if (!(
      binary.startsWith("/usr/") ||
      (versions && inside(versions, binary)) ||
      inside(prefix, binary)
    ))
      continue;
    if (versions && inside(versions, base)) mounts.push({ source: base, target: base });
    if (!inside(worktree, prefix))
      mounts.push({ source: prefix, target: prefix }, { source: prefix, target: candidate });
    python = join(candidate, "bin", "python3");
    pythonPrefix = candidate;
    break;
  }

  if (version && !python)
    warnings.push(
      `Selected Python environment ${version} is unavailable; system Python will be used. No dependencies were installed automatically.`,
    );
  return { python, pythonPrefix, dependencies, mounts, warnings };
};
