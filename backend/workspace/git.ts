import {
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
  realpath,
  lstat,
  readlink,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import lockfile from "proper-lockfile";
import {
  AdeError,
  branchName,
  now,
  type Repository,
  type Task,
  type WorkspaceAssignment,
} from "../domain";
import { capture, checked, execute } from "../execution/process";
import { exists, safeFile, taskRoot, worktreePath } from "./paths";
export class GitWorkspace {
  constructor(
    private readonly root: string,
    private readonly repositoryPath?: (id: string) => string,
  ) {}
  commonDirectory = async (cwd: string) =>
    realpath(
      await checked(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd,
      ),
    );
  acquireWrite = async (cwd: string, identity: string) => {
    const common = await this.commonDirectory(cwd);
    const key = createHash("sha256").update(identity).digest("hex");
    const target = join(common, `vibestar-write-${key}`);
    await writeFile(target, "", { flag: "a", mode: 0o600 });
    try {
      return await lockfile.lock(target, {
        stale: 30000,
        update: 10000,
        retries: 0,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED")
        throw new AdeError(
          "busy",
          "Another operation has exclusive write access to this Git workspace or PR destination.",
        );
      throw error;
    }
  };
  withLock = async <T>(repoId: string, operation: () => Promise<T>) => {
    if (!/^[\w-]+$/.test(repoId))
      throw new AdeError("invalid_input", "Invalid repository lock key");
    const repository = this.repositoryPath?.(repoId);
    const common =
      repository && (await exists(join(repository, ".git")))
        ? await this.commonDirectory(repository)
        : null;
    const path = common || join(this.root, "state", `repo-${repoId}.lock`);
    if (!common) await writeFile(path, "", { flag: "a", mode: 0o600 });
    const release = await lockfile.lock(path, {
      ...(common
        ? { lockfilePath: join(common, "vibestar-operation.lock") }
        : {}),
      stale: 30000,
      update: 10000,
      retries: { retries: 30, minTimeout: 250, maxTimeout: 2000 },
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  };
  clone = async (
    url: string,
    path: string,
    signal?: AbortSignal,
    onProgress?: (line: string) => void,
  ) => {
    await mkdir(dirname(path), { recursive: true });
    const result = await execute({
      program: "git",
      args: [
        "clone",
        "--progress",
        "--filter=blob:none",
        "--origin",
        "upstream",
        "--",
        url,
        path,
      ],
      cwd: dirname(path),
      signal,
      timeoutMs: 1800000,
      progressLines: true,
      onLine: (_, line) => onProgress?.(line),
    });
    if (result.code !== 0)
      throw new AdeError(
        "clone_failed",
        `Couldn't clone repository. ${result.stderr.slice(-4000)}`,
      );
  };
  fetch = async (repo: Repository, signal?: AbortSignal) => {
    await checked(
      "git",
      this.fetchArgs(repo, repo.base_branch),
      repo.path,
      signal,
    );
    repo.last_fetched = now();
  };
  private fetchArgs = (repo: Repository, branch: string) =>
    repo.source === "imported"
      ? [
          "fetch",
          "--no-write-fetch-head",
          "--no-tags",
          "--no-recurse-submodules",
          "--",
          repo.upstream_url,
          `+refs/heads/${branch}:refs/vibestar/${repo.id}/${branch}`,
        ]
      : ["fetch", "upstream", "--prune"];
  private baseRef = (repo: Repository, branch: string) =>
    repo.source === "imported"
      ? `refs/vibestar/${repo.id}/${branch}`
      : `refs/remotes/upstream/${branch}`;
  prepare = async (
    repo: Repository,
    t: Task,
    signal?: AbortSignal,
    checkpoint?: (t: Task) => void,
    trace?: (record: unknown) => Promise<void>,
  ) =>
    this.withLock(repo.id, async () => {
      const command = async (args: string[]) => {
        const started = now();
        const o = await capture(
          "git",
          [
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            ...args,
          ],
          repo.path,
          signal,
        );
        await trace?.({
          argv: ["git", ...args],
          cwd: repo.path,
          started_at: started,
          ...o,
        });
        if (o.code !== 0)
          throw new AdeError(
            "git_prepare",
            `git ${args[0]} exited ${o.code}: ${o.stderr}`,
          );
        return o.stdout.trim();
      };
      await command(this.fetchArgs(repo, t.base_branch));
      repo.last_fetched = now();
      await checked(
        "git",
        ["check-ref-format", "--branch", t.base_branch],
        repo.path,
        signal,
      );
      const base = await checked(
        "git",
        [
          "rev-parse",
          "--verify",
          `${this.baseRef(repo, t.base_branch)}^{commit}`,
        ],
        repo.path,
        signal,
      );
      if (!/^[a-f0-9]{40,64}$/.test(base))
        throw new AdeError("git_base", "Invalid base commit SHA");
      for (let suffix = 0; suffix < 10000; suffix++) {
        const branch = branchName(
          t.issue_number,
          t.scope_mode === "whole_issue" ? "whole-issue" : t.claimed_scope,
          suffix,
        );
        const path = worktreePath(
          this.root,
          repo.id,
          t.issue_number,
          t.scope_mode === "whole_issue" ? "whole-issue" : t.claimed_scope,
          suffix,
        );
        const existing = await capture(
          "git",
          ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
          repo.path,
          signal,
        );
        if (existing.code === 0 || (await exists(path))) continue;
        await mkdir(dirname(path), { recursive: true });
        t.branch_name = branch;
        t.branch_owned = false;
        t.base_commit_sha = base;
        t.base_branch = repo.base_branch;
        t.worktree_path = path;
        checkpoint?.(t);
        await command(["worktree", "add", "-b", branch, path, base]);
        await command([
          "config",
          "--local",
          `branch.${branch}.vibestarTask`,
          t.id,
        ]);
        t.branch_name = branch;
        t.branch_owned = true;
        t.base_commit_sha = base;
        t.base_branch = repo.base_branch;
        t.worktree_path = await realpath(path);
        checkpoint?.(t);
        return;
      }
      throw new AdeError(
        "branch_collision",
        "Unable to find a unique branch name",
      );
    });
  assertTask = async (t: WorkspaceAssignment) => {
    const cwd = await taskRoot(this.root, t);
    const branch = await checked(
      "git",
      ["symbolic-ref", "--short", "HEAD"],
      cwd,
    );
    if (branch !== t.branch_name)
      throw new AdeError(
        "isolation",
        `Assigned branch changed: expected ${t.branch_name}, found ${branch}`,
      );
    return cwd;
  };
  fingerprint = async (t: WorkspaceAssignment) => {
    const cwd = await this.assertTask(t);
    const hash = createHash("sha256");
    hash.update(await checked("git", ["rev-parse", "HEAD"], cwd));
    hash.update(
      (
        await capture(
          "git",
          [
            "diff",
            "--binary",
            "--no-ext-diff",
            "--no-textconv",
            t.base_commit_sha,
            "--",
          ],
          cwd,
        )
      ).stdout,
    );
    const untracked = await capture(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      cwd,
    );
    for (const file of untracked.stdout.split("\0").filter(Boolean).sort()) {
      hash.update(file);
      hash.update(await readFile(await safeFile(cwd, file)));
    }
    return hash.digest("hex");
  };
  repairFingerprint = async (t: WorkspaceAssignment, includeHistory = true) => {
    const cwd = await this.assertTask(t);
    const hash = createHash("sha256").update(t.base_commit_sha);
    const output = async (args: string[]) => {
      const result = await execute({
        program: "git",
        args,
        cwd,
        rawStdoutForIntegrity: true,
      });
      if (
        result.code !== 0 ||
        Buffer.byteLength(result.stdout) >= 32 * 1024 * 1024
      )
        throw new AdeError(
          "fingerprint",
          "Git fingerprint evidence failed or exceeded the capture limit.",
        );
      return result.stdout;
    };
    if (includeHistory) {
      hash.update(await output(["rev-parse", "HEAD"]));
      hash.update(await output(["ls-files", "--stage", "-z"]));
    }
    const paths = new Set(
      (
        (await output([
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-renames",
          "--name-only",
          "-z",
          t.base_commit_sha,
          "--",
        ])) +
        (await output(["ls-files", "--others", "--exclude-standard", "-z"]))
      )
        .split("\0")
        .filter(Boolean),
    );
    for (const path of [...paths].sort()) {
      const file = await safeFile(cwd, path);
      hash.update(`\0${path}\0`);
      try {
        const metadata = await lstat(file);
        hash.update(String(metadata.mode & 0o111));
        if (metadata.isSymbolicLink())
          hash.update(`symlink:${await readlink(file)}`);
        else if (metadata.isFile()) {
          const content = createHash("sha256");
          for await (const chunk of createReadStream(file))
            content.update(chunk);
          hash.update(content.digest());
        } else
          throw new AdeError(
            "fingerprint",
            "Review changes include an unsupported file type.",
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        hash.update("deleted");
      }
    }
    return hash.digest("hex");
  };
  file = async (
    t: WorkspaceAssignment,
    path: string,
    oldPath?: string | null,
    head?: string,
  ) => {
    const cwd = await this.assertTask(t);
    const file = await safeFile(cwd, path);
    const old = oldPath || path;
    await safeFile(cwd, old);
    const originalSize = await capture(
      "git",
      ["cat-file", "-s", `${t.base_commit_sha}:${old}`],
      cwd,
    );
    if (
      originalSize.code === 0 &&
      Number(originalSize.stdout) > 4 * 1024 * 1024
    )
      throw new AdeError(
        "file_limit",
        "Base file exceeds the 4 MiB editor limit",
      );
    const original = await capture(
      "git",
      ["show", `${t.base_commit_sha}:${old}`],
      cwd,
    );
    let bytes = Buffer.alloc(0);
    if (head) {
      const size = await capture(
        "git",
        ["cat-file", "-s", `${head}:${path}`],
        cwd,
      );
      if (size.code === 0 && Number(size.stdout) > 4 * 1024 * 1024)
        throw new AdeError("file_limit", "File exceeds the 4 MiB editor limit");
      const content = await capture("git", ["show", `${head}:${path}`], cwd);
      if (content.code === 0) bytes = Buffer.from(content.stdout);
    } else
      try {
        const s = await stat(file);
        if (s.isFile()) {
          if (s.size > 4 * 1024 * 1024)
            throw new AdeError(
              "file_limit",
              "File exceeds the 4 MiB editor limit",
            );
          bytes = await readFile(file);
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    const binary = bytes.includes(0) || original.stdout.includes("\0");
    const unified = await capture(
      "git",
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        t.base_commit_sha,
        ...(head ? [head] : []),
        "--",
        path,
        old,
      ],
      cwd,
    );
    const addedPatch =
      original.code !== 0 && bytes.length && !unified.stdout
        ? await capture(
            "git",
            [
              "diff",
              "--no-index",
              "--no-ext-diff",
              "--no-textconv",
              "--",
              "/dev/null",
              file,
            ],
            cwd,
          )
        : null;
    return {
      original: original.code === 0 ? original.stdout : "",
      modified: bytes.toString("utf8"),
      binary,
      unified: unified.stdout || addedPatch?.stdout || "",
    };
  };
  diff = async (t: WorkspaceAssignment, head?: string) => {
    const cwd = await this.assertTask(t);
    const output = await capture(
      "git",
      [
        "diff",
        "--name-status",
        "-z",
        "--find-renames",
        t.base_commit_sha,
        ...(head ? [head] : []),
        "--",
      ],
      cwd,
    );
    if (output.code !== 0) throw new AdeError("diff", output.stderr);
    const fields = output.stdout.split("\0");
    const files: DiffFile[] = [];
    for (let i = 0; i < fields.length - 1;) {
      const status = fields[i++];
      const old = fields[i++];
      if (!status) break;
      const renamed = status.startsWith("R") || status.startsWith("C");
      files.push({
        path: renamed ? fields[i++] : old,
        old_path: renamed ? old : null,
        status: status[0],
        staged: false,
        unstaged: false,
        untracked: false,
        insertions: 0,
        deletions: 0,
        binary: false,
      });
    }
    const untracked = await capture(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      cwd,
    );
    for (const path of head ? [] : untracked.stdout.split("\0").filter(Boolean))
      files.push({
        path,
        old_path: null,
        status: "A",
        staged: false,
        unstaged: true,
        untracked: true,
        insertions: 0,
        deletions: 0,
        binary: false,
      });
    const porcelain = await capture(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      cwd,
    );
    const rows = head ? [] : porcelain.stdout.split("\0");
    for (let i = 0; i < rows.length; i++) {
      const line = rows[i];
      if (line.length < 4) continue;
      const x = line[0],
        y = line[1],
        path = line.slice(3);
      if (x === "R" || x === "C") i++;
      let file = files.find((f) => f.path === path);
      if (!file) {
        file = {
          path,
          old_path: null,
          status: x === "?" ? "A" : "M",
          staged: false,
          unstaged: false,
          untracked: x === "?",
          insertions: 0,
          deletions: 0,
          binary: false,
        };
        files.push(file);
      }
      file.staged = x !== " " && x !== "?";
      file.unstaged = y !== " ";
      file.untracked = x === "?";
    }
    for (const f of files) {
      try {
        const content = await this.file(t, f.path, f.old_path, head);
        f.binary = content.binary;
        if (f.status === "A" && !f.old_path)
          f.insertions = countLines(content.modified);
        else {
          const stats = await capture(
            "git",
            [
              "diff",
              "--numstat",
              t.base_commit_sha,
              ...(head ? [head] : []),
              "--",
              f.path,
              ...(f.old_path ? [f.old_path] : []),
            ],
            cwd,
          );
          for (const line of stats.stdout.split("\n")) {
            const [a, d] = line.split("\t");
            f.insertions += Number(a) || 0;
            f.deletions += Number(d) || 0;
          }
        }
      } catch (e) {
        if (e instanceof AdeError && e.kind === "file_limit") {
          f.binary = true;
        } else throw e;
      }
    }
    return {
      files,
      insertions: files.reduce((n, f) => n + f.insertions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
      base: t.base_commit_sha,
    };
  };
  discard = async (t: Task, path?: string) => {
    const cwd = await this.assertTask(t);
    for (const f of (await this.diff(t)).files.filter(
      (f) => !path || f.path === path,
    )) {
      const file = await safeFile(cwd, f.path);
      const tracked = await capture(
        "git",
        ["cat-file", "-e", `${t.base_commit_sha}:${f.path}`],
        cwd,
      );
      if (tracked.code === 0)
        await checked(
          "git",
          [
            "restore",
            "--source",
            t.base_commit_sha,
            "--staged",
            "--worktree",
            "--",
            f.path,
          ],
          cwd,
        );
      else {
        await capture(
          "git",
          ["rm", "--cached", "--ignore-unmatch", "--", f.path],
          cwd,
        );
        if (await exists(file)) await rm(file);
      }
      if (f.old_path) {
        await safeFile(cwd, f.old_path);
        await checked(
          "git",
          [
            "restore",
            "--source",
            t.base_commit_sha,
            "--staged",
            "--worktree",
            "--",
            f.old_path,
          ],
          cwd,
        );
      }
    }
  };
}
export interface DiffFile {
  path: string;
  old_path: string | null;
  status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  insertions: number;
  deletions: number;
  binary: boolean;
}
const countLines = (s: string) =>
  s ? s.split("\n").length - (s.endsWith("\n") ? 1 : 0) : 0;
