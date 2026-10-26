import { lstat, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { AdeError } from "../domain";
import type { Engine } from "../execution/engine";
import { OutputBudget } from "../execution/output/bounded-output";
import { execute, redact } from "../execution/runtime/process";
import { sandboxInvocation } from "../execution/runtime/sandbox";
import { gitExecute } from "../workspace/git-command";
import { inside, managedPath } from "../workspace/paths";
import { type Finalization } from "./contracts";
import type { FinalizationStore } from "./store";
import type { FinalizationWorkspaces } from "./workspaces";

/** Runs optional repository hooks under the existing sandbox policy; host publication guards remain separate. */
export class OptionalHooks {
  constructor(
    private readonly engine: Pick<Engine, "db" | "root" | "git" | "changed">,
    private readonly workspaces: FinalizationWorkspaces,
    private readonly store: FinalizationStore,
  ) {}

  hookConfiguration = async (cwd: string, signal?: AbortSignal) => {
    const extension = await gitExecute({
      program: "git",
      cwd,
      signal,
      rawStdoutForIntegrity: true,
      args: [
        "config",
        "--local",
        "--no-includes",
        "--type=bool",
        "--get",
        "extensions.worktreeConfig",
      ],
    });

    if (![0, 1].includes(extension.code))
      throw new AdeError(
        "hook_policy",
        `Cannot read worktree configuration (${extension.code}): ${redact(extension.stderr)}`,
      );

    const scopes =
      extension.code === 0 && extension.stdout.trim() === "true"
        ? ["--worktree", "--local"]
        : ["--local"];

    for (const scope of scopes) {
      const value = await gitExecute({
        program: "git",
        cwd,
        signal,
        rawStdoutForIntegrity: true,
        args: ["config", scope, "--no-includes", "--get", "core.hooksPath"],
      });

      if (value.code === 0) {
        const path = value.stdout.endsWith("\n") ? value.stdout.slice(0, -1) : value.stdout;
        if (Buffer.byteLength(path) > 4096)
          throw new AdeError(
            "hook_policy",
            "Optional hook path exceeds the supported filesystem path limit.",
          );
        return path;
      }

      if (value.code !== 1)
        throw new AdeError(
          "hook_policy",
          `Cannot read optional hook configuration (${value.code}): ${redact(value.stderr)}`,
        );
    }

    return null;
  };

  hooks = async (
    record: Finalization,
    names: string[],
    signal: AbortSignal,
    messageFile?: string,
  ) => {
    const task = this.engine.db.task(record.task_id);
    const cwd = await this.workspaces.assert(record, task);
    const common = await this.engine.git.commonDirectory(cwd);
    const source = await this.workspaces.source(task);
    const configured = await this.hookConfiguration(source, signal);
    if (configured !== record.hook_configuration)
      throw new AdeError(
        "hook_policy",
        "Optional hook configuration changed after the selected preview. Prepare a fresh preview or explicitly skip optional hooks.",
      );
    if (configured === "/dev/null") {
      this.store.event(
        record,
        "Optional hook policy",
        "Repository/worktree configuration explicitly disables optional hooks.",
      );

      return;
    }

    if (
      configured !== null &&
      (!configured || configured.startsWith("~") || configured.includes("\\"))
    )
      throw new AdeError(
        "hook_policy",
        "Optional hook configuration must identify an authorized worktree or shared Git hook directory.",
      );

    const sourceDirectory =
      configured === null ? join(common, "hooks") : resolve(source, configured);

    const directory =
      sourceDirectory === source || inside(source, sourceDirectory)
        ? resolve(cwd, relative(source, sourceDirectory))
        : sourceDirectory;

    const sharedHooks = join(common, "hooks");
    if (directory === cwd || inside(cwd, directory)) {
      if (directory !== cwd) await managedPath(cwd, directory);
    } else if (directory === sharedHooks || inside(sharedHooks, directory))
      await managedPath(common, directory);
    else
      throw new AdeError(
        "hook_policy",
        "Optional hooks outside the authorized worktree or shared Git hooks directory cannot run. Configure a supported local directory or explicitly skip optional hooks.",
      );

    const metadata = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });

    if (
      metadata &&
      (!metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        (await realpath(directory)) !== directory)
    )
      throw new AdeError(
        "hook_policy",
        "Optional hooks must be regular executables in the physical Git hooks directory.",
      );
    for (const name of names) {
      const path = join(directory, name);

      const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });

      if (!entry || !(entry.mode & 0o111)) {
        if (sourceDirectory !== directory) {
          const original = await lstat(join(sourceDirectory, name)).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null;
              throw error;
            },
          );

          if (original && original.mode & 0o111)
            throw new AdeError(
              "hook_policy",
              "A configured optional hook is missing from the selected review workspace. Include its files in a fresh review or explicitly skip optional hooks.",
            );
        }

        continue;
      }

      if (!entry.isFile() || entry.isSymbolicLink())
        throw new AdeError("hook_policy", "Optional hook aliases are not supported.");

      const args =
        name === "pre-push"
          ? [record.destination!.remote, record.destination!.url]
          : name === "pre-commit" || name === "post-commit"
            ? []
            : [messageFile!, ...(name === "prepare-commit-msg" ? ["message"] : [])];

      const invocation = await sandboxInvocation(
        this.engine.root,
        this.engine.db,
        this.workspaces.assignment(record, task),
        { program: path, args },
        true,
        undefined,
        undefined,
        undefined,
        messageFile ? [messageFile] : [],
      );

      const outputBudget = new OutputBudget(1024 * 1024);
      let outputLines = 0;

      const result = await execute({
        ...invocation,
        cwd,
        signal,
        timeoutMs: 120000,
        onSpawn: (pid, identity) => {
          record.pid = pid;
          record.process_identity = identity;
          this.store.save(record);
        },
        input:
          name === "pre-push"
            ? `refs/heads/${task.branch_name} ${record.head} refs/heads/${record.destination!.branch} ${record.destination!.expected_remote}\n`
            : undefined,
        onLine: (stream, line) => {
          outputBudget.consume(line);
          if (++outputLines > 2048)
            throw new AdeError(
              "output_limit",
              "Optional hook output exceeded 2,048 lines. Inspect saved output before retrying or explicitly skipping optional hooks.",
            );
          this.store.event(record, `${name} ${stream}`, line);
          this.engine.changed(task.id);
        },
      });

      record.pid = null;
      record.process_identity = null;
      this.store.save(record);
      this.store.event(record, `Optional ${name}`, result.stderr || result.stdout, result.code);
      if (result.code !== 0)
        throw new AdeError(
          "hook_failed",
          `Optional ${name} exited ${result.code}. Inspect its saved output or explicitly choose to skip optional hooks.`,
        );
    }
  };
}
