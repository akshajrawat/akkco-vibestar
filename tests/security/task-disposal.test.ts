import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import * as gitCommands from "../../backend/workspace/git-command";
import { checked, capture } from "../../backend/execution/runtime/process";
import { StorageService } from "../../backend/storage/service";
import { exists } from "../../backend/workspace/paths";
import { createFixtureEngine, fixtureRepository, prepareFixtureTask } from "../helpers/fixtures";

let directory: string;
let engine: Awaited<ReturnType<typeof createFixtureEngine>>;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "vibestar-disposal-"));
  engine = await createFixtureEngine(join(directory, "data"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await engine.close();
  await rm(directory, { recursive: true, force: true });
});
const fixture = async () => {
  const { repo } = await fixtureRepository(engine, directory);
  const task = await prepareFixtureTask(engine, repo, "discard-fixture");
  return { repo, task, storage: new StorageService(engine) };
};

it.each(["modified", "staged", "untracked", "ignored"])(
  "deliberately discards %s files only from the confirmed owned workspace",
  async (kind) => {
    const { repo, task, storage } = await fixture();
    const path =
      kind === "untracked" ? "new.txt" : kind === "ignored" ? "ignored.txt" : "source.txt";
    await writeFile(join(task.worktree_path, path), "discard fixture bytes\n");
    if (kind === "staged") await checked("git", ["add", "source.txt"], task.worktree_path);
    const preview = await storage.previewTaskDisposal(task.id);
    expect([...preview.modified, ...preview.untracked, ...preview.ignored]).toContain(path);
    expect(await exists(task.worktree_path)).toBe(true);
    await storage.discardTask(task.id, preview.fingerprint, false);
    expect(await exists(task.worktree_path)).toBe(false);
    expect(engine.db.tasks()).toEqual([]);
    expect(
      (
        await capture(
          "git",
          ["show-ref", "--verify", "--quiet", `refs/heads/${task.branch_name}`],
          repo.path,
        )
      ).code,
    ).toBe(1);
    expect(await readFile(join(repo.path, "source.txt"), "utf8")).toBe("base\n");
  },
);

it("binds the preview to ignored content and refuses fresh data or another task's preview", async () => {
  const { repo, task, storage } = await fixture();
  await writeFile(join(task.worktree_path, "ignored.txt"), "first");
  const preview = await storage.previewTaskDisposal(task.id);
  await writeFile(join(task.worktree_path, "ignored.txt"), "new work");
  await expect(storage.discardTask(task.id, preview.fingerprint, true)).rejects.toThrow("changed");
  const other = await prepareFixtureTask(engine, repo, "another");
  await expect(storage.discardTask(other.id, preview.fingerprint, true)).rejects.toThrow("changed");
  expect(await readFile(join(task.worktree_path, "ignored.txt"), "utf8")).toBe("new work");
});

it("requires additional acknowledgment of unique commits and never lets ordinary cleanup erase them", async () => {
  const { task, storage } = await fixture();
  await writeFile(join(task.worktree_path, "source.txt"), "unique commit\n");
  await checked(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-am",
      "Unique fixture work",
    ],
    task.worktree_path,
  );
  await expect(
    storage.cleanupTask(task.id, {
      worktree: true,
      logs: true,
      artifacts: true,
      history: true,
    }),
  ).rejects.toThrow("Unpushed");
  const preview = await storage.previewTaskDisposal(task.id);
  expect(preview.unpublished_commits).toBe(1);
  await expect(storage.discardTask(task.id, preview.fingerprint, false)).rejects.toThrow(
    "additional loss",
  );
  await storage.discardTask(task.id, preview.fingerprint, true);
  expect(engine.db.tasks()).toEqual([]);
});

it.each(["hidden-index", "merge", "wrong-owner", "symlink"])(
  "fails closed for %s metadata",
  async (kind) => {
    const { task, storage } = await fixture();
    const gitdir = await checked("git", ["rev-parse", "--absolute-git-dir"], task.worktree_path);
    if (kind === "hidden-index")
      await checked("git", ["update-index", "--skip-worktree", "source.txt"], task.worktree_path);
    if (kind === "merge") await writeFile(join(gitdir, "MERGE_HEAD"), task.base_commit_sha + "\n");
    if (kind === "wrong-owner")
      await writeFile(join(gitdir, "vibestar-task-owner"), "another-task");
    if (kind === "symlink") {
      const moved = task.worktree_path + "-preserved";
      const { rename } = await import("node:fs/promises");
      await rename(task.worktree_path, moved);
      await symlink(moved, task.worktree_path, "dir");
    }
    await expect(storage.previewTaskDisposal(task.id)).rejects.toThrow();
    expect(await readFile(join(task.worktree_path, "source.txt"), "utf8")).toBe("base\n");
    expect(engine.db.tasks()).toHaveLength(1);
  },
);

it("preserves files, branch and ownership across restart when removing task history", async () => {
  const { repo, task, storage } = await fixture();
  await writeFile(join(task.worktree_path, "source.txt"), "retain my work\n");
  engine.followUp(task.id, "A saved instruction", undefined, true);
  await storage.preserveTaskWork(task.id);
  expect(engine.db.detail(task.id).messages).toEqual([]);
  expect(engine.db.task(task.id)).toMatchObject({
    status: "preserved",
    archived: true,
    branch_name: task.branch_name,
  });
  await engine.close();
  engine = await createFixtureEngine(join(directory, "data"));
  expect(engine.db.task(task.id).status).toBe("preserved");
  expect(await readFile(join(task.worktree_path, "source.txt"), "utf8")).toBe("retain my work\n");
  expect(await checked("git", ["rev-parse", task.branch_name], repo.path)).toBe(
    task.base_commit_sha,
  );
  await expect(engine.retry(task.id)).rejects.toThrow();
});

it("refuses concurrent task operations and finalization dependencies before removing data", async () => {
  const { task, storage } = await fixture();
  const release = engine.acquireTaskWorkspace(task.id, "fixture terminal");
  await expect(storage.previewTaskDisposal(task.id)).rejects.toThrow("active operations");
  release();
  const preview = await storage.previewTaskDisposal(task.id);
  engine.db.run(
    "INSERT INTO git_finalizations VALUES(?,?,?,'{}',?,?)",
    randomUUID(),
    task.id,
    "uncertain",
    new Date().toISOString(),
    new Date().toISOString(),
  );
  await expect(storage.discardTask(task.id, preview.fingerprint, false)).rejects.toThrow(
    "Finalization",
  );
  expect(await exists(task.worktree_path)).toBe(true);
});

it("resumes a journaled discard after worktree removal without adopting recreated work or changing the confirmed branch head", async () => {
  const { task, storage } = await fixture();
  await writeFile(join(task.worktree_path, "untracked.txt"), "explicitly discarded fixture");
  const preview = await storage.previewTaskDisposal(task.id);
  const execute = gitCommands.gitExecute;
  const failure = vi.spyOn(gitCommands, "gitExecute").mockImplementation(async (options) => {
    if (options.args[0] === "update-ref")
      throw new Error("Fixture interruption after scoped worktree removal");
    return execute(options);
  });
  await expect(storage.discardTask(task.id, preview.fingerprint, false)).rejects.toThrow(
    "Fixture interruption",
  );
  failure.mockRestore();
  expect(await exists(task.worktree_path)).toBe(false);
  expect(engine.db.task(task.id).disposal_authorization?.fingerprint).toBe(preview.fingerprint);
  await engine.close();
  engine = await createFixtureEngine(join(directory, "data"));
  const reopened = new StorageService(engine);
  const recovery = await reopened.previewTaskDisposal(task.id);
  expect(recovery.fingerprint).toBe(preview.fingerprint);
  await reopened.discardTask(task.id, recovery.fingerprint, false);
  expect(engine.db.tasks()).toEqual([]);
});
