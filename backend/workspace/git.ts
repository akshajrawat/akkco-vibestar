import { readWorktreeOwner, writeWorktreeOwner } from "./ownership";
import { gitChecked, gitExecute, gitCapture } from "./git-command";
import {
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
  realpath,
  readlink,
  open,
  readdir,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import lockfile from "proper-lockfile";
import {
  AdeError,
  branchName,
  now,
  type Repository,
  type Task,
  type WorkspaceAssignment,
} from "../domain";
import {
  exists,
  inside,
  managedPath,
  safeFile,
  taskRoot,
  worktreePath,
  workspaceEntry,
} from "./paths";
export class GitWorkspace {
  constructor(
    private readonly root: string,
    private readonly repository?: (id: string) => Repository,
    private readonly transport?: (url: string) => string,
  ) {}
  private registeredPath = async (id: string) => {
    const repo = this.repository?.(id);
    if (repo && repo.source !== "imported") {
      if (!inside(join(this.root, "repos"), repo.path))
        throw new AdeError(
          "isolation",
          "Managed repository is outside its authorized root.",
        );
      await managedPath(this.root, repo.path);
    }
    return repo?.path;
  };
  commonDirectory = async (cwd: string) =>
    realpath(
      await gitChecked(
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
    const repository = await this.registeredPath(repoId);
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
    if (!inside(join(this.root, "repos"), path))
      throw new AdeError(
        "isolation",
        "Managed clone must stay inside its repository root.",
      );
    await managedPath(this.root, path);
    await mkdir(dirname(path), { recursive: true });
    await managedPath(this.root, path);
    const result = await gitExecute({
      program: "git",
      allowLocalTransport: !!this.transport,
      args: [
        "clone",
        "--progress",
        "--origin",
        "upstream",
        "--",
        this.transport?.(url) ?? url,
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
    const result = await gitExecute({
      program: "git",
      args: this.fetchArgs(repo, repo.base_branch),
      cwd: repo.path,
      signal,
      allowLocalTransport: !!this.transport,
    });
    if (result.code !== 0)
      throw new AdeError("git_fetch", `Git fetch failed: ${result.stderr}`);
    repo.last_fetched = now();
  };
  private fetchArgs = (repo: Repository, branch: string) => [
    "fetch",
    "--no-write-fetch-head",
    "--no-tags",
    "--no-recurse-submodules",
    "--",
    this.transport?.(repo.upstream_url) ?? repo.upstream_url,
    `+refs/heads/${branch}:${this.baseRef(repo, branch)}`,
  ];
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
      await managedPath(this.root, join("worktrees", repo.id));
      if (t.worktree_path) {
        if (await this.reconcileTaskPreparation(repo, t, checkpoint)) return;
      }
      t.workspace_checkpoint = {
        state: "fetching",
        git_common_dir: await this.commonDirectory(repo.path),
        started_at: now(),
        operation: null,
      };
      checkpoint?.(t);
      const command = (args: string[]) =>
        this.taskOperation(repo, t, args, signal, checkpoint, trace);
      await command(this.fetchArgs(repo, t.base_branch));
      repo.last_fetched = now();
      await gitChecked(
        ["check-ref-format", "--branch", t.base_branch],
        repo.path,
        signal,
      );
      const base = await gitChecked(
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
        await managedPath(this.root, path);
        const existing = await gitCapture(
          ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
          repo.path,
          signal,
        );
        if (existing.code === 0 || (await exists(path))) continue;
        await mkdir(dirname(path), { recursive: true });
        await managedPath(this.root, path);
        t.branch_name = branch;
        t.branch_owned = false;
        t.base_commit_sha = base;
        t.base_branch = repo.base_branch;
        t.worktree_path = path;
        t.workspace_checkpoint.state = "creating";
        t.workspace_checkpoint.started_at = now();
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
        const gitdir = await realpath(
          await gitChecked(
            ["rev-parse", "--absolute-git-dir"],
            t.worktree_path,
          ),
        );
        if (
          !inside(
            join(t.workspace_checkpoint.git_common_dir, "worktrees"),
            gitdir,
          )
        )
          throw new AdeError(
            "ownership",
            "Task Git metadata is outside its assigned common directory.",
          );
        await writeWorktreeOwner(gitdir, "vibestar-task-owner", t.id);
        t.workspace_checkpoint.state = "ready";
        checkpoint?.(t);
        return;
      }
      throw new AdeError(
        "branch_collision",
        "Unable to find a unique branch name",
      );
    });
  private taskOperation = async (
    repo: Repository,
    task: Task,
    args: string[],
    signal?: AbortSignal,
    checkpoint?: (task: Task) => void,
    trace?: (record: unknown) => Promise<void>,
  ) => {
    const started = now();
    let finished = false;
    const o = await gitExecute({
      program: "git",
      args,
      cwd: repo.path,
      signal,
      allowLocalTransport: !!this.transport,
      onSpawn: (pid, identity) => {
        if (finished || !identity || !task.workspace_checkpoint) return;
        task.workspace_checkpoint.operation = {
          kind: args[0],
          pid,
          identity,
          started_at: started,
        };
        checkpoint?.(task);
      },
    }).finally(() => {
      finished = true;
      if (task.workspace_checkpoint) task.workspace_checkpoint.operation = null;
      checkpoint?.(task);
    });
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
  recoverTaskPreparation = (
    repo: Repository,
    task: Task,
    checkpoint?: (task: Task) => void,
  ) =>
    this.withLock(repo.id, () =>
      this.reconcileTaskPreparation(repo, task, checkpoint),
    );
  private reconcileTaskPreparation = async (
    repo: Repository,
    task: Task,
    checkpoint?: (task: Task) => void,
  ) => {
    if (
      ["removing", "removed"].includes(task.workspace_checkpoint?.state || "")
    )
      throw new AdeError(
        "recovery",
        "Task workspace removal was checkpointed. Complete cleanup explicitly; preparation cannot restore it.",
      );
    await managedPath(this.root, task.worktree_path);
    if (!inside(join(this.root, "worktrees", repo.id), task.worktree_path))
      throw new AdeError(
        "ownership",
        "Task creation checkpoint is outside its repository boundary.",
      );
    const common = await this.commonDirectory(repo.path);
    if (
      task.workspace_checkpoint &&
      task.workspace_checkpoint.git_common_dir !== common
    )
      throw new AdeError(
        "ownership",
        "Task creation common directory changed; preserve the checkpoint for recovery.",
      );
    const branch = await gitCapture(
      ["rev-parse", "--verify", `refs/heads/${task.branch_name}`],
      repo.path,
    );
    const marker = await gitCapture(
      ["config", "--local", "--get", `branch.${task.branch_name}.vibestarTask`],
      repo.path,
    );
    const registrations = await gitChecked(
      ["worktree", "list", "--porcelain"],
      repo.path,
    );
    const existence = await gitCapture(
      ["show-ref", "--verify", "--quiet", `refs/heads/${task.branch_name}`],
      repo.path,
    );
    if (
      existence.code === 1 &&
      !(await exists(task.worktree_path)) &&
      !registrations.split("\n").includes(`worktree ${task.worktree_path}`)
    ) {
      task.worktree_path = "";
      task.branch_name = "";
      task.branch_owned = false;
      task.base_commit_sha = "";
      checkpoint?.(task);
      return false;
    }
    for (const entry of registrations.split("\n\n")) {
      const lines = entry.split("\n");
      if (
        lines.includes(`branch refs/heads/${task.branch_name}`) &&
        !lines.includes(`worktree ${task.worktree_path}`)
      )
        throw new AdeError(
          "ownership",
          "Task branch is registered outside its saved worktree; it was preserved.",
        );
    }
    if (branch.code !== 0 || branch.stdout.trim() !== task.base_commit_sha)
      throw new AdeError(
        "ownership",
        "Interrupted task creation no longer has its expected branch SHA. Restore or inspect the saved checkpoint before retrying.",
      );
    if (
      (marker.code === 0 && marker.stdout.trim() !== task.id) ||
      ![0, 1].includes(marker.code)
    )
      throw new AdeError(
        "ownership",
        "Task branch ownership belongs to another operation or could not be read.",
      );
    if (marker.code !== 0) {
      const creation = await gitChecked(
        [
          "reflog",
          "show",
          "--format=%gD%x00%gs",
          "--date=raw",
          `refs/heads/${task.branch_name}`,
        ],
        repo.path,
      );
      const [selector, message] = creation.split("\0");
      const created = Number(selector.match(/@\{(\d+) /)?.[1]);
      const started =
        Date.parse(task.workspace_checkpoint?.started_at || "") / 1000;
      if (
        task.workspace_checkpoint?.state !== "creating" ||
        message !== `branch: Created from ${task.base_commit_sha}` ||
        !Number.isFinite(created) ||
        !Number.isFinite(started) ||
        created < Math.floor(started) ||
        created > Math.ceil(Date.now() / 1000)
      )
        throw new AdeError(
          "ownership",
          "No positive task creation evidence matches this worktree. Its files and branch were preserved.",
        );
      if (await exists(task.worktree_path)) {
        const cwd = await this.assertTask(task);
        if (
          (await this.commonDirectory(cwd)) !== common ||
          (await gitChecked(
            ["status", "--porcelain", "--untracked-files=all"],
            cwd,
          ))
        )
          throw new AdeError(
            "ownership",
            "Interrupted worktree creation has changed contents or Git metadata. Preserve it for inspection.",
          );
      }
      await gitChecked(
        [
          "config",
          "--local",
          `branch.${task.branch_name}.vibestarTask`,
          task.id,
        ],
        repo.path,
      );
    }
    if (!(await exists(task.worktree_path))) {
      if (
        registrations.split("\n").includes(`worktree ${task.worktree_path}`)
      ) {
        const entry = registrations
          .split("\n\n")
          .find((value) =>
            value.split("\n").includes(`worktree ${task.worktree_path}`),
          );
        if (!entry?.split("\n").includes(`HEAD ${task.base_commit_sha}`))
          throw new AdeError(
            "ownership",
            "Missing worktree registration changed; it was preserved.",
          );
        // The path is absent and its exact registration, branch and creation
        // identity were verified above. No working files can be discarded.
        await this.taskOperation(
          repo,
          task,
          ["worktree", "remove", "--", task.worktree_path],
          undefined,
          checkpoint,
        );
      }
      await mkdir(dirname(task.worktree_path), { recursive: true });
      await managedPath(this.root, task.worktree_path);
      await this.taskOperation(
        repo,
        task,
        ["worktree", "add", "--", task.worktree_path, task.branch_name],
        undefined,
        checkpoint,
      );
    }
    const cwd = await this.assertTask(task);
    if (
      (await this.commonDirectory(cwd)) !== common ||
      (await gitChecked(["rev-parse", "HEAD"], cwd)) !== task.base_commit_sha
    )
      throw new AdeError(
        "ownership",
        "Task preparation identity changed; its worktree was preserved.",
      );
    const gitdir = await realpath(
      await gitChecked(["rev-parse", "--absolute-git-dir"], cwd),
    );
    if (!inside(join(common, "worktrees"), gitdir))
      throw new AdeError(
        "ownership",
        "Task metadata is not an isolated worktree.",
      );
    const owner = await readWorktreeOwner(gitdir, "vibestar-task-owner");
    if (owner && owner !== task.id)
      throw new AdeError(
        "ownership",
        "Task worktree metadata belongs to another owner; it was preserved.",
      );
    await writeWorktreeOwner(gitdir, "vibestar-task-owner", task.id);
    task.branch_owned = true;
    task.workspace_checkpoint = {
      ...task.workspace_checkpoint,
      state: "ready",
      git_common_dir: common,
      started_at: task.workspace_checkpoint?.started_at || now(),
      operation: null,
    };
    checkpoint?.(task);
    return true;
  };
  assertTask = async (t: WorkspaceAssignment) => {
    await this.registeredPath(t.repo_id);
    const cwd = await taskRoot(this.root, t);
    const branch = await gitChecked(["symbolic-ref", "--short", "HEAD"], cwd);
    if (branch !== t.branch_name)
      throw new AdeError(
        "isolation",
        `Assigned branch changed: expected ${t.branch_name}, found ${branch}`,
      );
    return cwd;
  };
  fingerprint = async (t: WorkspaceAssignment) =>
    `issue-v2:${await this.workspaceFingerprint(t, true, true)}`;
  repairFingerprint = (t: WorkspaceAssignment, includeHistory = true) =>
    this.workspaceFingerprint(t, includeHistory);
  private workspaceFingerprint = async (
    t: WorkspaceAssignment,
    includeHistory: boolean,
    allTracked = false,
    physicalDirectory?: string,
    depth = 0,
  ) => {
    const cwd = physicalDirectory || (await this.assertTask(t));
    if (
      depth > 8 ||
      (physicalDirectory &&
        (await realpath(physicalDirectory)) !== physicalDirectory)
    )
      throw new AdeError(
        "fingerprint",
        "Submodule fingerprint boundary is unsafe or exceeds the nesting limit.",
      );
    const hash = createHash("sha256").update(t.base_commit_sha);
    const output = async (args: string[], directory = cwd) => {
      const result = await gitExecute({
        program: "git",
        args,
        cwd: directory,
        rawStdoutForIntegrity: true,
      });
      if (result.code !== 0 || result.stdout_truncated)
        throw new AdeError(
          "fingerprint",
          "Git fingerprint evidence failed or exceeded the capture limit.",
        );
      return result.stdout;
    };
    const index = await output(["ls-files", "--stage", "-z"]);
    const gitlinks = new Set(
      index
        .split("\0")
        .filter((entry) => entry.startsWith("160000 "))
        .map((entry) => entry.slice(entry.indexOf("\t") + 1)),
    );
    if (includeHistory) {
      hash.update(await output(["rev-parse", "HEAD"]));
      hash.update(
        await output(
          allTracked
            ? ["ls-files", "--stage", "-v", "-z"]
            : ["ls-files", "--stage", "-z"],
        ),
      );
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
        (await output(["ls-files", "--others", "--exclude-standard", "-z"])) +
        (allTracked ? await output(["ls-files", "-z"]) : "")
      )
        .split("\0")
        .filter(Boolean),
    );
    for (const path of [...paths].sort()) {
      hash.update(`\0${path}\0`);
      const { path: file, metadata } = await workspaceEntry(cwd, path);
      if (!metadata) {
        hash.update("deleted");
        continue;
      }
      hash.update(String(metadata.mode & 0o111));
      if (metadata.isSymbolicLink()) {
        hash.update("symlink:");
        hash.update(await readlink(file, { encoding: "buffer" }));
      } else if (metadata.isFile()) {
        const handle = await open(
          file,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          if ((await realpath(`/proc/self/fd/${handle.fd}`)) !== file)
            throw new AdeError(
              "fingerprint",
              "A fingerprint file moved outside its validated path.",
            );
          const opened = await handle.stat();
          const content = createHash("sha256");
          for await (const chunk of handle.createReadStream({
            autoClose: false,
          }))
            content.update(chunk);
          const after = await handle.stat();
          if (
            [metadata, after].some((state) =>
              (
                ["dev", "ino", "mode", "size", "mtimeMs", "ctimeMs"] as const
              ).some((key) => state[key] !== opened[key]),
            )
          )
            throw new AdeError(
              "fingerprint",
              "A file changed while its integrity evidence was being read. Retry after writes finish.",
            );
          hash.update(content.digest());
        } finally {
          await handle.close();
        }
      } else if (metadata.isDirectory()) {
        if (!gitlinks.has(path)) {
          hash.update("directory");
          continue;
        }
        if (!(await exists(join(file, ".git")))) {
          if ((await readdir(file)).length)
            throw new AdeError(
              "fingerprint",
              "An uninitialized submodule contains files. Initialize or preserve it before review.",
            );
          hash.update("uninitialized-gitlink");
          continue;
        }
        const top = await realpath(
          (await output(["rev-parse", "--show-toplevel"], file)).trim(),
        );
        const common = await realpath(
          (
            await output([
              "rev-parse",
              "--path-format=absolute",
              "--git-common-dir",
            ])
          ).trim(),
        );
        const nestedCommon = await realpath(
          (
            await output(
              ["rev-parse", "--path-format=absolute", "--git-common-dir"],
              file,
            )
          ).trim(),
        );
        if (top !== file || !inside(common, nestedCommon))
          throw new AdeError(
            "fingerprint",
            "Submodule metadata is outside its parent repository boundary.",
          );
        const head = (await output(["rev-parse", "HEAD"], file)).trim();
        hash.update("gitlink:");
        hash.update(
          await this.workspaceFingerprint(
            { ...t, base_commit_sha: head },
            true,
            true,
            file,
            depth + 1,
          ),
        );
      } else
        throw new AdeError(
          "fingerprint",
          "Review changes include an unsupported file type.",
        );
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
    const originalSize = await gitCapture(
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
    const original = await gitCapture(
      ["show", `${t.base_commit_sha}:${old}`],
      cwd,
    );
    let bytes = Buffer.alloc(0);
    if (head) {
      const size = await gitCapture(["cat-file", "-s", `${head}:${path}`], cwd);
      if (size.code === 0 && Number(size.stdout) > 4 * 1024 * 1024)
        throw new AdeError("file_limit", "File exceeds the 4 MiB editor limit");
      const content = await gitCapture(["show", `${head}:${path}`], cwd);
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
    const unified = await gitCapture(
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
        ? await gitCapture(
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
    const output = await gitCapture(
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
    const untracked = await gitCapture(
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
    const porcelain = await gitCapture(
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
          const stats = await gitCapture(
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
      const tracked = await gitCapture(
        ["cat-file", "-e", `${t.base_commit_sha}:${f.path}`],
        cwd,
      );
      if (tracked.code === 0)
        await gitChecked(
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
        await gitCapture(
          ["rm", "--cached", "--ignore-unmatch", "--", f.path],
          cwd,
        );
        if (await exists(file)) await rm(file);
      }
      if (f.old_path) {
        await safeFile(cwd, f.old_path);
        await gitChecked(
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
