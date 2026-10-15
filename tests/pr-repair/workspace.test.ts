import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Engine } from "../../backend/execution/engine";
import { capture, checked } from "../../backend/execution/process";
import { RepairWorkspaces } from "../../backend/review/repair/workspace";
import { repairFixture } from "./fixtures";
import { RepairStore } from "../../backend/review/repair/store";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

it.each([true, false])(
  "prepares a manual PR in an isolated %s imported checkout without touching source or remotes",
  async (imported) => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-pr-workspace-"));
    const engine = await Engine.create(join(dir, "ade"));
    try {
      const fixture = await repairFixture(engine, dir, {
        imported,
        conflict: false,
      });
      const {
        repo,
        session,
        checkpoint,
        source,
        fork,
        upstream,
        head,
        base,
        originalBase,
      } = fixture;
      const workspaces = new RepairWorkspaces(
        engine.root,
        engine.git,
        (_, side) => (side === "head" ? fork : upstream),
      );
      const before = await checked("git", ["status", "--porcelain"], source);
      const sourceIndex = await readFile(join(source, ".git", "index"));
      expect(
        await workspaces.prepare(
          session,
          repo,
          checkpoint,
          new AbortController().signal,
        ),
      ).toBe("ready");
      const cwd = await workspaces.assert(session, repo);
      expect(cwd).not.toBe(source);
      expect(session.workspace.branch_owned).toBe(true);
      expect(session.workspace.original_head).toBe(head);
      expect(session.workspace.original_base).toBe(originalBase);
      expect(session.workspace.fetched_base).toBe(base);
      expect(session.workspace.merge_commit).not.toBeNull();
      expect(
        await checked("git", ["show", "-s", "--format=%P", "HEAD"], cwd),
      ).toBe(`${head} ${base}`);
      expect(await readFile(join(cwd, "README.md"), "utf8")).toBe(
        "Latest upstream development\n",
      );
      expect(await readFile(join(source, "README.md"), "utf8")).toBe(
        "Personal dirty source checkout\n",
      );
      expect(await checked("git", ["status", "--porcelain"], source)).toBe(
        before,
      );
      expect(await readFile(join(source, ".git", "index"))).toEqual(
        sourceIndex,
      );
      expect(await checked("git", ["branch", "--show-current"], source)).toBe(
        "fix-translation-tests",
      );
      expect(
        await checked(
          "git",
          ["rev-parse", "refs/heads/fix-translation-tests"],
          fork,
        ),
      ).toBe(head);
      expect(
        await checked("git", ["rev-parse", "refs/heads/develop"], upstream),
      ).toBe(base);
      const integrated = await checked("git", ["rev-parse", "HEAD"], cwd);
      // A restart reconciles intent from Git; it never creates a second merge.
      session.workspace.merge_state = "intent";
      session.workspace.preparation = "merging";
      checkpoint();
      expect(
        await workspaces.prepare(
          session,
          repo,
          checkpoint,
          new AbortController().signal,
        ),
      ).toBe("ready");
      expect(await checked("git", ["rev-parse", "HEAD"], cwd)).toBe(integrated);
      const wrong = { ...repo, owner: "other" };
      await expect(
        workspaces.prepare(
          session,
          wrong,
          checkpoint,
          new AbortController().signal,
        ),
      ).rejects.toThrow("upstream repository");
      await checked(
        "git",
        [
          "config",
          "--local",
          `branch.${session.workspace.branch_name}.vibestarRepair`,
          "foreign",
        ],
        source,
      );
      await expect(workspaces.assert(session, repo)).rejects.toThrow(
        "ownership",
      );
    } finally {
      await engine.close();
      await rm(dir, { recursive: true });
    }
  },
  30000,
);

it("preserves conflicted index stages and explicitly recovers a resolved merge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-pr-conflict-"));
  const engine = await Engine.create(join(dir, "ade"));
  try {
    const { repo, session, checkpoint, upstream, fork } = await repairFixture(
      engine,
      dir,
      { imported: true, conflict: true },
    );
    const workspaces = new RepairWorkspaces(
      engine.root,
      engine.git,
      (_, side) => (side === "head" ? fork : upstream),
    );
    const signal = new AbortController().signal;
    expect(await workspaces.prepare(session, repo, checkpoint, signal)).toBe(
      "conflict",
    );
    expect(session.workspace.conflict_paths).toEqual(["spec.ts"]);
    expect(session.workspace.conflict_index).toContain(" 1\tspec.ts");
    expect(session.workspace.conflict_index).toContain(" 2\tspec.ts");
    expect(session.workspace.conflict_index).toContain(" 3\tspec.ts");
    const mergeHead = await checked(
      "git",
      ["rev-parse", "MERGE_HEAD"],
      session.workspace.worktree_path,
    );
    expect(await workspaces.prepare(session, repo, checkpoint, signal)).toBe(
      "conflict",
    );
    expect(
      await checked(
        "git",
        ["rev-parse", "MERGE_HEAD"],
        session.workspace.worktree_path,
      ),
    ).toBe(mergeHead);
    await expect(
      workspaces.recoverConflict(session, repo, checkpoint, signal),
    ).rejects.toThrow("Stage resolved files");
    await writeFile(
      join(session.workspace.worktree_path, "spec.ts"),
      "export const selectors = ['upstream', 'draft', 'publish'];\n",
    );
    await checked("git", ["add", "spec.ts"], session.workspace.worktree_path);
    expect(
      await workspaces.recoverConflict(session, repo, checkpoint, signal),
    ).toBe("ready");
    expect(session.workspace.conflict_paths).toEqual([]);
    expect(session.workspace.merge_commit).not.toBeNull();
  } finally {
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);

it("rejects changed PR head and serializes registrations sharing Git metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-pr-shared-"));
  const engine = await Engine.create(join(dir, "ade"));
  try {
    const { repo, session, checkpoint, upstream, fork, seed } =
      await repairFixture(engine, dir);
    const sibling = join(dir, "sibling-checkout");
    await checked(
      "git",
      ["worktree", "add", "--detach", sibling, "HEAD"],
      repo.path,
    );
    const duplicate = { ...repo, id: randomUUID(), path: sibling };
    engine.db.saveRepository(duplicate);
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let secondEntered = false;
    const first = engine.git.withLock(repo.id, async () => {
      entered();
      await gate;
    });
    await ready;
    const second = engine.git.withLock(duplicate.id, async () => {
      secondEntered = true;
    });
    // Inspect the authoritative common lock while the first operation is live.
    expect(await readFile(join(repo.path, ".git", "HEAD"), "utf8")).toContain(
      "fix-translation-tests",
    );
    expect(secondEntered).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
    await checked("git", ["switch", "fix-translation-tests"], seed);
    await writeFile(join(seed, "new.txt"), "Remote changed\n");
    await checked("git", ["add", "."], seed);
    await checked("git", ["commit", "-m", "new remote head"], seed);
    await checked(
      "git",
      ["push", fork, "HEAD:refs/heads/fix-translation-tests"],
      seed,
    );
    const workspaces = new RepairWorkspaces(
      engine.root,
      engine.git,
      (_, side) => (side === "head" ? fork : upstream),
    );
    await expect(
      workspaces.prepare(
        session,
        repo,
        checkpoint,
        new AbortController().signal,
      ),
    ).rejects.toThrow("remote PR head changed");
    expect(
      (
        await capture(
          "git",
          [
            "show-ref",
            "--verify",
            `refs/heads/${session.workspace.branch_name}`,
          ],
          repo.path,
        )
      ).code,
    ).not.toBe(0);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);

it("integrates the actual PR base ref even when the selected repository has a different default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-pr-base-ref-"));
  const engine = await Engine.create(join(dir, "ade"));
  try {
    const { session, repo, checkpoint, upstream, fork, base } =
      await repairFixture(engine, dir, {
        imported: true,
        conflict: false,
        baseBranch: "release/candidate",
      });
    repo.base_branch = "unrelated-source-default";
    engine.db.saveRepository(repo);
    const workspace = new RepairWorkspaces(
      engine.root,
      engine.git,
      (_, side) => (side === "head" ? fork : upstream),
    );
    expect(
      await workspace.prepare(
        session,
        repo,
        checkpoint,
        new AbortController().signal,
      ),
    ).toBe("ready");
    expect(session.workspace.fetched_base).toBe(base);
    expect(session.identity.base.branch).toBe("release/candidate");
  } finally {
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);

it("recovers a crash between exact-head worktree creation and its ownership checkpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-pr-create-checkpoint-"));
  let engine = await Engine.create(join(dir, "ade"));
  try {
    const { session, repo, checkpoint, upstream, fork, head } =
      await repairFixture(engine, dir);
    session.workspace.git_common_dir = await engine.git.commonDirectory(
      repo.path,
    );
    session.workspace.preparation = "creating";
    session.status = "preparing";
    checkpoint();
    await mkdir(dirname(session.workspace.worktree_path), { recursive: true });
    await checked(
      "git",
      [
        "worktree",
        "add",
        "-b",
        session.workspace.branch_name,
        session.workspace.worktree_path,
        head,
      ],
      repo.path,
    );
    await engine.close();
    engine = await Engine.create(join(dir, "ade"));
    const workspace = new RepairWorkspaces(
      engine.root,
      engine.git,
      (_, side) => (side === "head" ? fork : upstream),
    );
    const store = new RepairStore(engine.db);
    expect(
      await workspace.prepare(
        session,
        repo,
        () => store.save(session),
        new AbortController().signal,
      ),
    ).toBe("ready");
    expect(session.workspace.branch_owned).toBe(true);
    expect(await workspace.assert(session, repo)).toBe(
      session.workspace.worktree_path,
    );
    expect(engine.db.all("SELECT * FROM ai_usage")).toEqual([]);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);

it("preserves ignored local files that an upstream merge would overwrite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-pr-ignored-"));
  const engine = await Engine.create(join(dir, "ade"));
  try {
    const { session, repo, checkpoint, upstream, fork, seed, source, head } =
      await repairFixture(engine, dir);
    await writeFile(
      join(seed, "ignored-local.txt"),
      "Upstream tracked content\n",
    );
    await checked("git", ["add", "ignored-local.txt"], seed);
    await checked("git", ["commit", "-m", "upstream tracked file"], seed);
    await checked("git", ["push", upstream, "develop"], seed);
    await appendFile(
      join(source, ".git", "info", "exclude"),
      "\nignored-local.txt\n",
    );
    session.workspace.git_common_dir = await engine.git.commonDirectory(
      repo.path,
    );
    session.workspace.preparation = "creating";
    checkpoint();
    await mkdir(dirname(session.workspace.worktree_path), { recursive: true });
    await checked(
      "git",
      [
        "worktree",
        "add",
        "-b",
        session.workspace.branch_name,
        session.workspace.worktree_path,
        head,
      ],
      source,
    );
    await writeFile(
      join(session.workspace.worktree_path, "ignored-local.txt"),
      "Preserve my ignored data\n",
    );
    const workspace = new RepairWorkspaces(
      engine.root,
      engine.git,
      (_, side) => (side === "head" ? fork : upstream),
    );
    await expect(
      workspace.prepare(
        session,
        repo,
        checkpoint,
        new AbortController().signal,
      ),
    ).rejects.toThrow("ignored-local.txt");
    expect(
      await readFile(
        join(session.workspace.worktree_path, "ignored-local.txt"),
        "utf8",
      ),
    ).toBe("Preserve my ignored data\n");
    expect(
      await checked(
        "git",
        ["rev-parse", "HEAD"],
        session.workspace.worktree_path,
      ),
    ).toBe(head);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);
