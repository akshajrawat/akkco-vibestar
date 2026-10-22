import {
  readWorktreeOwner,
  writeWorktreeOwner,
} from "../../workspace/ownership";
import { gitExecute, gitChecked } from "../../workspace/git-command";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AdeError, now, remoteIdentity, type Repository } from "../../domain";
import { GitWorkspace } from "../../workspace/git";
import { exists, inside, managedPath, safeFile } from "../../workspace/paths";
import type { PRIdentity, RepairSession } from "./contracts";

export const repairAssignment = (session: RepairSession) => ({
  id: session.id,
  repo_id: session.repo_id,
  branch_name: session.workspace.branch_name,
  worktree_path: session.workspace.worktree_path,
  base_commit_sha:
    session.workspace.integrated_head || session.workspace.original_head,
});
interface GitCheckpoint {
  session: RepairSession;
  save: () => void;
}

export class RepairWorkspaces {
  constructor(
    private readonly root: string,
    private readonly git: GitWorkspace,
    private readonly transport?: (
      identity: PRIdentity,
      side: "head" | "upstream",
    ) => string,
  ) {}
  private command = async (
    cwd: string,
    args: string[],
    signal?: AbortSignal,
    checkpoint?: GitCheckpoint,
  ) => {
    let finished = false;
    try {
      return await gitExecute({
        program: "git",
        allowLocalTransport: !!this.transport,
        rawStdoutForIntegrity: true,
        args: [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "maintenance.auto=false",
          "-c",
          "gc.auto=0",
          ...args,
        ],
        cwd,
        signal,
        onSpawn: checkpoint
          ? (pid, identity) => {
              if (finished || !identity) return;
              checkpoint.session.workspace.operation = {
                kind:
                  args.find((arg) =>
                    ["fetch", "worktree", "merge", "commit"].includes(arg),
                  ) || args[0],
                pid,
                identity,
                started_at: now(),
              };
              checkpoint.save();
            }
          : undefined,
      });
    } finally {
      finished = true;
      if (checkpoint) {
        checkpoint.session.workspace.operation = null;
        checkpoint.save();
      }
    }
  };
  private checked = async (
    cwd: string,
    args: string[],
    signal?: AbortSignal,
    checkpoint?: GitCheckpoint,
  ) => {
    const result = await this.command(cwd, args, signal, checkpoint);
    if (result.code !== 0)
      throw new AdeError(
        "git_repair",
        `git ${args[0]} exited ${result.code}: ${result.stderr}`,
      );
    return result.stdout.trim();
  };
  remoteHead = async (
    identity: PRIdentity,
    cwd: string,
    signal?: AbortSignal,
  ) => {
    const output = await this.checked(
      cwd,
      [
        "ls-remote",
        "--refs",
        "--",
        this.transport?.(identity, "head") ?? identity.head.url,
        `refs/heads/${identity.head.branch}`,
      ],
      signal,
    );
    const [sha, ref, extra] = output.split(/\s+/);
    if (
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha) ||
      ref !== `refs/heads/${identity.head.branch}` ||
      extra
    )
      throw new AdeError(
        "pr_identity",
        "The exact PR branch is missing or ambiguous on its source repository.",
      );
    return sha;
  };
  validateRepository = async (repo: Repository, identity: PRIdentity) => {
    if (repo.source !== "imported") {
      if (!inside(join(this.root, "repos"), repo.path))
        throw new AdeError(
          "isolation",
          "Managed repository is outside its authorized root.",
        );
      await managedPath(this.root, repo.path);
    }
    if (
      repo.connected === false ||
      repo.clone_status === "cloning" ||
      `${repo.owner}/${repo.name}`.toLowerCase() !==
        identity.upstream.name.toLowerCase()
    )
      throw new AdeError(
        "repository_mismatch",
        "Select a connected checkout of the PR's upstream repository.",
      );
    const remotes = await gitChecked(["remote", "-v"], repo.path);
    const matches = remotes.split("\n").some((line) => {
      try {
        const parsed = remoteIdentity(line.split(/\s+/)[1]);
        return (
          `${parsed.owner}/${parsed.name}`.toLowerCase() ===
          identity.upstream.name.toLowerCase()
        );
      } catch {
        return false;
      }
    });
    if (!matches)
      throw new AdeError(
        "repository_mismatch",
        "The selected checkout no longer has the verified upstream GitHub identity.",
      );
    return this.git.commonDirectory(repo.path);
  };
  assert = async (session: RepairSession, repo: Repository) => {
    const workspace = session.workspace;
    const cwd = await this.git.assertTask(repairAssignment(session));
    const common = await this.git.commonDirectory(cwd);
    if (
      common !== workspace.git_common_dir ||
      common !== (await this.git.commonDirectory(repo.path))
    )
      throw new AdeError("isolation", "Repair Git common directory changed.");
    const gitdir = await realpath(
      await this.checked(cwd, ["rev-parse", "--absolute-git-dir"]),
    );
    if (!inside(join(common, "worktrees"), gitdir))
      throw new AdeError(
        "isolation",
        "Repair metadata is not an isolated worktree.",
      );
    const marker = await readWorktreeOwner(gitdir, "vibestar-repair-owner");
    const branchOwner = await this.command(cwd, [
      "config",
      "--local",
      "--get",
      `branch.${workspace.branch_name}.vibestarRepair`,
    ]);
    if (
      !workspace.branch_owned ||
      marker !== session.id ||
      branchOwner.stdout.trim() !== session.id
    )
      throw new AdeError(
        "ownership",
        "Repair worktree or branch ownership could not be verified.",
      );
    if (
      (
        await this.command(cwd, [
          "merge-base",
          "--is-ancestor",
          workspace.original_head,
          "HEAD",
        ])
      ).code !== 0
    )
      throw new AdeError(
        "ancestry",
        "The repair branch no longer descends from the verified PR head.",
      );
    return cwd;
  };
  private mergeState = async (session: RepairSession, cwd: string) => {
    const workspace = session.workspace;
    const unmerged = await this.checked(cwd, ["ls-files", "--unmerged", "-z"]);
    workspace.conflict_index = unmerged;
    workspace.conflict_paths = [
      ...new Set(
        unmerged
          .split("\0")
          .filter(Boolean)
          .map((line) => line.slice(line.indexOf("\t") + 1)),
      ),
    ];
    const merging =
      (await this.command(cwd, ["rev-parse", "--verify", "MERGE_HEAD"]))
        .code === 0;
    const head = await this.checked(cwd, ["rev-parse", "HEAD"]);
    const integrated =
      workspace.fetched_base &&
      (
        await this.command(cwd, [
          "merge-base",
          "--is-ancestor",
          workspace.fetched_base,
          head,
        ])
      ).code === 0;
    if (merging || workspace.conflict_paths.length) {
      workspace.preparation = "conflict";
      workspace.merge_state = "conflict";
      return "conflict";
    }
    if (integrated) {
      if (!workspace.integrated_head) {
        workspace.integrated_head = head;
        workspace.merge_commit = head === workspace.original_head ? null : head;
      }
      workspace.preparation = "ready";
      workspace.merge_state = "complete";
      return "ready";
    }
    return "pending";
  };
  prepare = async (
    session: RepairSession,
    repo: Repository,
    checkpoint: () => void,
    signal: AbortSignal,
  ) =>
    this.git.withLock(repo.id, async () => {
      const workspace = session.workspace;
      await managedPath(this.root, workspace.worktree_path);
      const common = await this.validateRepository(repo, session.identity);
      if (workspace.git_common_dir && workspace.git_common_dir !== common)
        throw new AdeError(
          "isolation",
          "Registered repository Git directory changed.",
        );
      workspace.git_common_dir = common;
      workspace.source_worktrees = await this.checked(
        repo.path,
        ["worktree", "list", "--porcelain", "-z"],
        signal,
      );
      const remote = await this.remoteHead(session.identity, repo.path, signal);
      workspace.remote_head = remote;
      workspace.remote_checked_at = now();
      checkpoint();
      if (remote !== workspace.original_head)
        throw new AdeError(
          "stale_remote_head",
          "The remote PR head changed. Analyze again and create a new repair session.",
        );
      if (identityClosed(session.identity))
        throw new AdeError("pr_closed", "The PR is no longer open.");
      for (const branch of [
        session.identity.head.branch,
        session.identity.base.branch,
        workspace.branch_name,
      ])
        await this.checked(
          repo.path,
          ["check-ref-format", "--branch", branch],
          signal,
        );
      if (!workspace.branch_owned) {
        if (await exists(workspace.worktree_path)) {
          // A crash between worktree creation and writing its marker is reconciled
          // only against the checkpointed path, exact SHA and creation reflog.
          if (workspace.preparation !== "creating")
            throw new AdeError(
              "ownership",
              "Unowned worktree path already exists.",
            );
          const assignment = repairAssignment(session);
          const cwd = await this.git.assertTask(assignment);
          if (
            (await this.git.commonDirectory(cwd)) !== common ||
            (await this.checked(cwd, ["rev-parse", "HEAD"])) !==
              workspace.original_head ||
            (await this.checked(cwd, ["status", "--porcelain"]))
          )
            throw new AdeError(
              "ownership",
              "Interrupted worktree creation no longer matches its checkpoint.",
            );
          const creation = await this.checked(cwd, [
            "reflog",
            "show",
            "--format=%gs",
            `refs/heads/${workspace.branch_name}`,
          ]);
          if (creation !== `branch: Created from ${workspace.original_head}`)
            throw new AdeError(
              "ownership",
              "Branch creation evidence does not match this repair session.",
            );
        } else {
          if (
            (
              await this.command(repo.path, [
                "show-ref",
                "--verify",
                "--quiet",
                `refs/heads/${workspace.branch_name}`,
              ])
            ).code === 0
          )
            throw new AdeError(
              "ownership",
              "Repair branch already exists outside the assigned worktree.",
            );
          await this.checked(
            repo.path,
            [
              "fetch",
              "--no-write-fetch-head",
              "--no-tags",
              "--no-recurse-submodules",
              "--",
              this.transport?.(session.identity, "head") ??
                session.identity.head.url,
              `refs/heads/${session.identity.head.branch}:refs/vibestar/repairs/${session.id}/head`,
            ],
            signal,
            { session, save: checkpoint },
          );
          const fetched = await this.checked(
            repo.path,
            [
              "rev-parse",
              "--verify",
              `refs/vibestar/repairs/${session.id}/head^{commit}`,
            ],
            signal,
          );
          if (fetched !== workspace.original_head)
            throw new AdeError(
              "stale_remote_head",
              "The PR branch changed while fetching. No worktree was created.",
            );
          if (
            !inside(
              join(this.root, "worktrees", repo.id),
              workspace.worktree_path,
            )
          )
            throw new AdeError(
              "isolation",
              "Repair worktree must stay inside the managed root.",
            );
          await mkdir(dirname(workspace.worktree_path), { recursive: true });
          await managedPath(this.root, workspace.worktree_path);
          workspace.preparation = "creating";
          checkpoint();
          await this.checked(
            repo.path,
            [
              "worktree",
              "add",
              "-b",
              workspace.branch_name,
              workspace.worktree_path,
              workspace.original_head,
            ],
            signal,
            { session, save: checkpoint },
          );
        }
        const gitdir = await realpath(
          await this.checked(workspace.worktree_path, [
            "rev-parse",
            "--absolute-git-dir",
          ]),
        );
        if (!inside(join(common, "worktrees"), gitdir))
          throw new AdeError(
            "isolation",
            "Unexpected repair metadata location.",
          );
        await writeWorktreeOwner(gitdir, "vibestar-repair-owner", session.id);
        await this.checked(repo.path, [
          "config",
          "--local",
          `branch.${workspace.branch_name}.vibestarRepair`,
          session.id,
        ]);
        workspace.branch_owned = true;
        checkpoint();
      }
      const cwd = await this.assert(session, repo);
      if (workspace.merge_state !== "not_started") {
        const actual = await this.mergeState(session, cwd);
        checkpoint();
        if (actual !== "pending") return actual;
        if (await this.checked(cwd, ["status", "--porcelain"]))
          throw new AdeError(
            "recovery",
            "Interrupted merge has local changes; inspect them before recovery.",
          );
      }
      if (!workspace.fetched_base) {
        await this.checked(
          repo.path,
          [
            "fetch",
            "--no-write-fetch-head",
            "--no-tags",
            "--no-recurse-submodules",
            "--",
            this.transport?.(session.identity, "upstream") ??
              session.identity.upstream.url,
            `refs/heads/${session.identity.base.branch}:refs/vibestar/repairs/${session.id}/base`,
          ],
          signal,
          { session, save: checkpoint },
        );
        workspace.fetched_base = await this.checked(
          repo.path,
          [
            "rev-parse",
            "--verify",
            `refs/vibestar/repairs/${session.id}/base^{commit}`,
          ],
          signal,
        );
        workspace.original_base = await this.checked(
          cwd,
          ["merge-base", workspace.original_head, workspace.fetched_base],
          signal,
        );
        checkpoint();
      }
      if (await this.checked(cwd, ["status", "--porcelain"]))
        throw new AdeError(
          "git_dirty",
          "Repair preparation has local modifications; preserve and inspect them before merging.",
        );
      const incoming = await this.checked(cwd, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--name-only",
        "--diff-filter=A",
        "-z",
        workspace.original_head,
        workspace.fetched_base,
        "--",
      ]);
      for (const path of incoming.split("\0").filter(Boolean)) {
        if (await exists(await safeFile(cwd, path)))
          throw new AdeError(
            "git_dirty",
            `Upstream integration would overwrite local file ${path}. Preserve it before continuing.`,
          );
      }
      workspace.merge_state = "intent";
      workspace.preparation = "merging";
      checkpoint();
      const merged = await this.command(
        cwd,
        [
          "-c",
          "user.name=Vibestar",
          "-c",
          "user.email=vibestar@localhost",
          "-c",
          "commit.gpgSign=false",
          "merge",
          "--no-overwrite-ignore",
          "--no-edit",
          "--no-ff",
          workspace.fetched_base,
        ],
        signal,
        { session, save: checkpoint },
      );
      const state = await this.mergeState(session, cwd);
      checkpoint();
      if (merged.code !== 0 && state !== "conflict")
        throw new AdeError(
          "git_merge",
          `Upstream integration stopped: ${merged.stderr || merged.stdout}`,
        );
      if (state === "pending")
        throw new AdeError(
          "git_merge",
          "Upstream integration did not reach a verified checkpoint.",
        );
      return state;
    });
  recoverConflict = async (
    session: RepairSession,
    repo: Repository,
    checkpoint: () => void,
    signal: AbortSignal,
  ) =>
    this.git.withLock(repo.id, async () => {
      const cwd = await this.assert(session, repo);
      const state = await this.mergeState(session, cwd);
      checkpoint();
      if (session.workspace.conflict_paths.length)
        throw new AdeError(
          "merge_conflict",
          "Stage resolved files in the repair worktree before recovering the merge.",
        );
      if (state === "ready") return state;
      const pending = await this.command(cwd, [
        "rev-parse",
        "--verify",
        "MERGE_HEAD",
      ]);
      if (
        pending.code !== 0 ||
        pending.stdout.trim() !== session.workspace.fetched_base
      )
        throw new AdeError(
          "recovery",
          "The pending merge no longer matches the fetched base.",
        );
      await this.checked(
        cwd,
        [
          "-c",
          "user.name=Vibestar",
          "-c",
          "user.email=vibestar@localhost",
          "-c",
          "commit.gpgSign=false",
          "commit",
          "--no-edit",
        ],
        signal,
        { session, save: checkpoint },
      );
      const actual = await this.mergeState(session, cwd);
      checkpoint();
      if (actual !== "ready")
        throw new AdeError(
          "recovery",
          "Resolved merge ancestry was not verified.",
        );
      return actual;
    });
  inspect = async (session: RepairSession, repo: Repository) => {
    const cwd = await this.assert(session, repo);
    return this.mergeState(session, cwd);
  };
  cleanup = async (
    session: RepairSession,
    repo: Repository,
    checkpoint: () => void,
  ) =>
    this.git.withLock(repo.id, async () => {
      if (session.workspace.preparation === "removed") return;
      const workspace = session.workspace;
      const present = await exists(workspace.worktree_path);
      const branch = `refs/heads/${workspace.branch_name}`;
      const ref = await this.command(repo.path, [
        "rev-parse",
        "--verify",
        branch,
      ]);
      const owner = await this.command(repo.path, [
        "config",
        "--local",
        "--get",
        `branch.${workspace.branch_name}.vibestarRepair`,
      ]);
      if (
        !present &&
        ref.code !== 0 &&
        !workspace.branch_owned &&
        ["pending", "creating"].includes(workspace.preparation)
      ) {
        const registrations = await this.checked(repo.path, [
          "worktree",
          "list",
          "--porcelain",
        ]);
        if (
          registrations
            .split("\n")
            .includes(`worktree ${workspace.worktree_path}`)
        )
          throw new AdeError(
            "ownership",
            "Unverified worktree registration was preserved.",
          );
        workspace.preparation = "removed";
        checkpoint();
        return;
      }
      if (
        workspace.git_common_dir !==
          (await this.git.commonDirectory(repo.path)) ||
        (ref.code === 0 && owner.stdout.trim() !== session.id)
      )
        throw new AdeError(
          "ownership",
          "Repair branch/common-directory ownership changed; cleanup was stopped.",
        );
      if (!present && workspace.preparation !== "removing")
        throw new AdeError(
          "ownership",
          "Missing worktree has no saved removal checkpoint. Preserve its Git metadata for inspection.",
        );
      const cwd = present
        ? await this.assert(session, repo)
        : workspace.worktree_path;
      if (
        present &&
        ((await this.checked(cwd, [
          "status",
          "--porcelain",
          "--untracked-files=all",
        ])) ||
          (await this.command(cwd, ["rev-parse", "--verify", "MERGE_HEAD"]))
            .code === 0)
      )
        throw new AdeError(
          "git_dirty",
          "The repair has local changes or a pending merge. Preserve them before removing this workspace.",
        );
      const head = present
        ? await this.checked(cwd, ["rev-parse", "HEAD"])
        : workspace.cleanup_head;
      if (!head)
        throw new AdeError(
          "ownership",
          "Removal checkpoint has no verified branch head.",
        );
      workspace.cleanup_head = head;
      workspace.preparation = "removing";
      checkpoint();
      const registered = await this.checked(repo.path, [
        "worktree",
        "list",
        "--porcelain",
      ]);
      if (present || registered.split("\n").includes(`worktree ${cwd}`))
        await this.checked(
          repo.path,
          ["worktree", "remove", "--", cwd],
          undefined,
          { session, save: checkpoint },
        );
      const checkouts = await this.checked(repo.path, [
        "worktree",
        "list",
        "--porcelain",
      ]);
      if (
        checkouts
          .split("\n")
          .includes(`branch refs/heads/${session.workspace.branch_name}`)
      )
        throw new AdeError(
          "ownership",
          "The repair branch is checked out elsewhere; it was preserved.",
        );
      if (ref.code === 0)
        await this.checked(repo.path, [
          "update-ref",
          "-d",
          `refs/heads/${session.workspace.branch_name}`,
          head,
        ]);
      for (const [name, sha] of [
        ["head", session.workspace.original_head],
        ["base", session.workspace.fetched_base],
      ])
        if (sha)
          await this.checked(repo.path, [
            "update-ref",
            "-d",
            `refs/vibestar/repairs/${session.id}/${name}`,
            sha,
          ]);
      if (owner.stdout.trim() === session.id)
        await this.checked(repo.path, [
          "config",
          "--local",
          "--unset",
          `branch.${session.workspace.branch_name}.vibestarRepair`,
        ]);
      session.workspace.branch_owned = false;
      session.workspace.preparation = "removed";
      checkpoint();
    });
}
const identityClosed = (identity: PRIdentity) => identity.state !== "open";
