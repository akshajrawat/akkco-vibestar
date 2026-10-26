import { isAbsolute } from "node:path";

import { AdeError, remoteIdentity } from "../domain";
import { execute, type ProcessRequest } from "../execution/runtime/process";

// Host operations invoke built-ins only. Provider-issued tools have their own sandbox.
const commands = new Set([
  "add",
  "branch",
  "cat-file",
  "check-ignore",
  "check-ref-format",
  "checkout",
  "clone",
  "commit",
  "config",
  "diff",
  "fetch",
  "for-each-ref",
  "log",
  "ls-files",
  "ls-remote",
  "merge",
  "merge-base",
  "push",
  "reflog",
  "remote",
  "restore",
  "rev-list",
  "rev-parse",
  "rm",
  "show",
  "show-ref",
  "status",
  "write-tree",
  "hash-object",
  "symbolic-ref",
  "update-ref",
  "worktree",
]);

const overrides = {
  "core.hooksPath": "/dev/null",
  "core.fsmonitor": "false",
  "core.editor": "false",
  "core.pager": "cat",
  "core.sshCommand": "false",
  "core.askPass": "false",
  "core.alternateRefsCommand": "false",
  "core.attributesFile": "/dev/null",
  "credential.helper": "",
  "credential.https://github.com.helper": "!gh auth git-credential",
  "credential.useHttpPath": "true",
  "credential.interactive": "false",
  "protocol.allow": "never",
  "protocol.https.allow": "always",
  "http.followRedirects": "false",
  "http.sslVerify": "true",
  "commit.gpgSign": "false",
  "tag.gpgSign": "false",
  "merge.verifySignatures": "false",
  "log.showSignature": "false",
  "maintenance.auto": "false",
  "gc.auto": "0",
  "gc.autoDetach": "false",
  "fetch.recurseSubmodules": "false",
  "push.recurseSubmodules": "no",
  "push.followTags": "false",
  "submodule.recurse": "false",
};

const overridden = new Set(Object.keys(overrides).map((key) => key.toLowerCase()));

const safeKey = (key: string) =>
  overridden.has(key) ||
  /^(?:core\.(?:repositoryformatversion|bare|worktree|logallrefupdates|filemode|ignorecase|symlinks|precomposeunicode|protecthfs|protectntfs|quotepath|autocrlf|eol|safecrlf|checkstat|trustctime|untrackedcache|ignorestat|abbrev|bigfilethreshold|compression|loosecompression|packedgitlimit|packedgitwindowsize|deltabasecachelimit)|extensions\.(?:objectformat|worktreeconfig|refstorage|partialclone)|user\.(?:name|email)|init\.defaultbranch)$/.test(
    key,
  ) ||
  /^branch\..+\.(?:remote|merge|rebase|description|vibestartask|vibestarrepair|vibestarfinalization)$/.test(
    key,
  ) ||
  /^remote\..+\.(?:url|pushurl|fetch|push|tagopt|promisor|partialclonefilter)$/.test(key) ||
  /^(?:submodule\.active|submodule\..+\.(?:url|active|ignore|branch|fetchrecursesubmodules))$/.test(
    key,
  ) ||
  /^(?:color|advice)\.[a-z.]+$/.test(key);

const refusal = (key: string) =>
  new AdeError(
    "git_policy",
    `Unsupported Git configuration key ${key}. The checkout was not changed. Use a clean managed checkout or remove this setting yourself; Vibestar does not edit source or global configuration.`,
  );

export const githubTransport = (url: string) => {
  const identity = remoteIdentity(url);
  return `https://github.com/${identity.owner}/${identity.name}.git`;
};

interface GitRequest extends ProcessRequest {
  allowLocalTransport?: boolean;
  // Host publishers supply private per-publication defense-in-depth hooks only.
  hooksPath?: string;
}

const inspectConfiguration = async (request: GitRequest) => {
  let worktreeConfig = false;
  let partialClone = false;
  for (const scope of ["--local", "--worktree"]) {
    if (scope === "--worktree" && !worktreeConfig) break;

    const result = await execute({
      program: "git",
      args: ["config", scope, "--no-includes", "--null", "--list"],
      cwd: request.cwd,
      signal: request.signal,
      rawStdoutForIntegrity: true,
      gitEnvironment: true,
    });

    if (result.code !== 0) {
      if (result.code === 128 && /only be used inside a git repository/.test(result.stderr)) return;
      throw new AdeError("git_policy", "Cannot safely inspect local Git configuration.");
    }

    for (const entry of result.stdout.split("\0").filter(Boolean)) {
      const key = entry.split("\n", 1)[0].toLowerCase();
      if (!safeKey(key)) throw refusal(key);

      partialClone ||=
        key === "extensions.partialclone" ||
        /^remote\..+\.(?:promisor|partialclonefilter)$/.test(key);

      if (scope === "--local" && key === "extensions.worktreeconfig") {
        // Git accepts nonzero integers as true, in addition to named booleans.
        // Use Git's own syntax before deciding which configuration files it reads.
        const enabled = await execute({
          program: "git",
          args: [
            "config",
            "--local",
            "--no-includes",
            "--type=bool",
            "--get",
            "extensions.worktreeConfig",
          ],
          cwd: request.cwd,
          signal: request.signal,
          gitEnvironment: true,
        });

        if (enabled.code !== 0) throw refusal(key);
        worktreeConfig = enabled.stdout.trim() === "true";
      }
    }
  }

  if (partialClone) {
    const version = await execute({
      program: "git",
      args: ["--version"],
      cwd: request.cwd,
      signal: request.signal,
      gitEnvironment: true,
    });

    const parsed = /^git version (\d+)\.(\d+)\./.exec(version.stdout);
    if (
      version.code !== 0 ||
      !parsed ||
      Number(parsed[1]) < 2 ||
      (Number(parsed[1]) === 2 && Number(parsed[2]) < 45)
    )
      throw new AdeError(
        "git_policy",
        "Partial clones require Git 2.45 or newer to disable implicit network fetches. Upgrade Git or use a clean full managed clone; the source checkout was preserved.",
      );
  }
};

export const gitExecute = async (request: GitRequest, executor = execute) => {
  if (request.program !== "git") throw new AdeError("git_policy", "Expected Git executable");
  const args = [...request.args];
  let index = 0;
  while (index < args.length && args[index].startsWith("-")) {
    if (args[index] === "--no-optional-locks") {
      index++;
      continue;
    }

    if (args[index] !== "-c" || !args[index + 1])
      throw new AdeError("git_policy", "Unsupported Git global option");
    const setting = args[index + 1];
    const separator = setting.indexOf("=");
    const key = setting.slice(0, separator).toLowerCase();
    const allowed = Object.entries(overrides).find(([name]) => name.toLowerCase() === key);
    if (
      separator < 1 ||
      !(
        ["user.name", "user.email"].includes(key) ||
        (allowed && setting.slice(separator + 1) === allowed[1])
      )
    )
      throw refusal(key);
    index += 2;
  }

  const command = args[index];
  if (!commands.has(command)) throw new AdeError("git_policy", "Unsupported host Git command");
  await inspectConfiguration(request);
  if (["clone", "fetch", "ls-remote", "push"].includes(command)) {
    // Host transports are always explicit, never mutable remote aliases.
    const separator = args.indexOf("--", index + 1);
    if (separator < 0 || !args[separator + 1])
      throw new AdeError("git_policy", "Git transport must be explicit");
    const destination = args[separator + 1];
    if (!(request.allowLocalTransport && isAbsolute(destination)))
      args[separator + 1] = githubTransport(destination);
    if (
      args
        .slice(index + 1, separator)
        .some((arg) => /^(?:--(?:upload-pack|receive-pack|exec|config)(?:=|$)|-c$)/.test(arg))
    )
      throw new AdeError("git_policy", "Unsupported Git transport option");
  }

  const policy = Object.entries(overrides).flatMap(([key, value]) => ["-c", `${key}=${value}`]);
  if (request.allowLocalTransport) policy.push("-c", "protocol.file.allow=always");
  if (request.hooksPath) {
    if (command !== "push" || !isAbsolute(request.hooksPath))
      throw new AdeError("git_policy", "Invalid publication hook capability");
    policy.push("-c", `core.hooksPath=${request.hooksPath}`);
  }

  return executor({
    ...request,
    args: [...args.slice(0, index), ...policy, ...args.slice(index)],
    gitEnvironment: true,
  });
};

export const gitCapture = (args: string[], cwd: string, signal?: AbortSignal) =>
  gitExecute({ program: "git", args, cwd, signal });

export const gitChecked = async (args: string[], cwd: string, signal?: AbortSignal) => {
  // Checked metadata is used for paths, refs and ownership decisions. Display
  // redaction must never reinterpret or merge those identifiers.
  const output = await gitExecute({
    program: "git",
    args,
    cwd,
    signal,
    rawStdoutForIntegrity: true,
  });

  if (output.code !== 0)
    throw new AdeError(
      "command_failed",
      `git exited ${output.code}: ${output.stderr.slice(-6000)}`,
      { program: "git", code: output.code },
    );
  return output.stdout.trim();
};
