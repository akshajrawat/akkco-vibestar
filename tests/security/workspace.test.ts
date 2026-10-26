import { expect, it } from "vitest";

import { chmod, rm, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createLayout, managedPath, taskRoot } from "../../backend/workspace/paths";
import { checked } from "../../backend/execution/runtime/process";
import { migrateDataRoot } from "../../backend/storage/migrate-root";
import { securityWorkspace } from "./fixtures";

it.each(["worktrees", "repos", "state", "logs", "cache", "artifacts", "runtime", "telemetry"])(
  "refuses an escaping %s category and leaves its target intact",
  async (category) => {
    const { dir, root } = await securityWorkspace();
    const external = join(dir, "external");
    await mkdir(external);
    await writeFile(join(external, "canary"), "preserved");
    await rename(join(root, category), join(root, `${category}-original`));
    await symlink(external, join(root, category));
    await expect(createLayout(root)).rejects.toThrow("symlink");
    expect(await readFile(join(external, "canary"), "utf8")).toBe("preserved");
  },
);

it.each(["internal", "dangling"])(
  "refuses %s repository-parent aliases before worktree access or creation",
  async (kind) => {
    const { root, task, git, source } = await securityWorkspace();
    const original = join(root, "worktrees", task.repo_id);
    const moved = `${original}-original`;
    await rename(original, moved);
    await symlink(kind === "internal" ? moved : join(root, "missing"), original);
    await expect(taskRoot(root, task)).rejects.toThrow("symlink");
    await expect(git.fingerprint(task)).rejects.toThrow("symlink");
    await rename(join(root, "repos"), join(root, "repos-original"));
    await symlink(source, join(root, "repos"));

    await expect(
      git.clone("https://github.com/fixture/fixture.git", join(root, "repos", "new")),
    ).rejects.toThrow("symlink");

    expect(await readFile(join(source, "file.txt"), "utf8")).toBe("base\n");
  },
);

it("retains the canonical root identity after its original directory is renamed and replaced", async () => {
  const { root, dir } = await securityWorkspace();
  const external = join(dir, "external");
  await mkdir(external);
  await rename(root, join(dir, "old-root"));
  await symlink(external, root);
  await expect(managedPath(root, "logs/output")).rejects.toThrow("root or path changed");
});

it("blocks root migration before following an escaping source category", async () => {
  const { root, dir, source } = await securityWorkspace();
  await rename(join(root, "state"), join(root, "state-original"));
  await symlink(source, join(root, "state"));
  await expect(migrateDataRoot(root, join(dir, "target"))).rejects.toThrow("symlink");
  expect(await readFile(join(source, "file.txt"), "utf8")).toBe("base\n");
});

it("hashes exact credential-shaped names, large binary bytes, modes, deletions and symlink targets", async () => {
  const { task, git, dir } = await securityWorkspace();
  const original = await git.fingerprint(task);
  expect(original).toMatch(/^issue-v2:[a-f0-9]{64}$/);
  expect(await git.fingerprint(task)).toBe(original);
  await writeFile(join(task.worktree_path, "\ufeffname"), "BOM filename");
  const bomHash = await git.fingerprint(task);
  await writeFile(join(task.worktree_path, "\ufeffname"), "changed BOM filename");
  expect(await git.fingerprint(task)).not.toBe(bomHash);
  const path = join(task.worktree_path, "api_key=fixture-private-name.bin");
  const bytes = Buffer.alloc(35 * 1024 * 1024, 0xa5);
  await writeFile(path, bytes);
  const first = await git.fingerprint(task);
  expect(first).not.toBe(original);
  bytes[bytes.length - 1] = 0x5a;
  await writeFile(path, bytes);
  expect(await git.fingerprint(task)).not.toBe(first);
  const beforeMode = await git.fingerprint(task);
  await chmod(join(task.worktree_path, "file.txt"), 0o755);
  expect(await git.fingerprint(task)).not.toBe(beforeMode);
  const link = join(task.worktree_path, "link");
  await writeFile(join(dir, "outside-canary"), "not read through the link");
  await symlink(join(dir, "outside-canary"), link);
  const linkHash = await git.fingerprint(task);
  await rename(link, join(task.worktree_path, "old-link"));
  await symlink("missing-target", link);
  expect(await git.fingerprint(task)).not.toBe(linkHash);
  await rename(join(task.worktree_path, "file.txt"), join(task.worktree_path, "renamed.txt"));
  expect(await git.fingerprint(task)).not.toBe(beforeMode);
}, 15000);

it("binds index-only changes and files hidden from Git's normal modified-file list", async () => {
  const { task, git } = await securityWorkspace();
  const original = await git.fingerprint(task);
  const path = join(task.worktree_path, "file.txt");
  await writeFile(path, "staged\n");
  await checked("git", ["add", "file.txt"], task.worktree_path);
  await writeFile(path, "base\n");
  expect(await git.fingerprint(task)).not.toBe(original);
  await checked("git", ["restore", "--staged", "file.txt"], task.worktree_path);
  expect(await git.fingerprint(task)).toBe(original);
  await checked("git", ["update-index", "--assume-unchanged", "file.txt"], task.worktree_path);
  await writeFile(path, "hidden modification\n");
  expect(await checked("git", ["diff", "--name-only"], task.worktree_path)).toBe("");
  expect(await git.fingerprint(task)).not.toBe(original);
});

it("rejects invalid UTF-8 filename evidence instead of hashing a replacement-character alias", async () => {
  const { task, git } = await securityWorkspace();
  await writeFile(join(task.worktree_path, "\ufffd"), "valid UTF-8 name");

  await writeFile(
    Buffer.concat([Buffer.from(`${task.worktree_path}/`), Buffer.from([0xff])]),
    "invalid name bytes",
  );

  await expect(git.fingerprint(task)).rejects.toThrow("non-UTF-8");
});

it("fingerprints tracked file/directory/link transformations without following replaced parents", async () => {
  const { task, git, dir } = await securityWorkspace();
  const original = await git.fingerprint(task);
  await rm(join(task.worktree_path, "file.txt"));
  await mkdir(join(task.worktree_path, "file.txt"));
  await writeFile(join(task.worktree_path, "file.txt", "new.txt"), "new child");
  const asDirectory = await git.fingerprint(task);
  expect(asDirectory).not.toBe(original);
  await checked("git", ["add", "."], task.worktree_path);
  await checked("git", ["commit", "-m", "file becomes directory"], task.worktree_path);
  await rm(join(task.worktree_path, "file.txt"), { recursive: true });
  await writeFile(join(task.worktree_path, "file.txt"), "directory becomes file");
  const asFile = await git.fingerprint(task);
  expect(asFile).not.toBe(asDirectory);
  await rm(join(task.worktree_path, "file.txt"));
  await symlink(dir, join(task.worktree_path, "file.txt"));
  expect(await git.fingerprint(task)).not.toBe(asFile);
});

it("preserves clean uninitialized gitlinks and binds initialized submodule changes", async () => {
  const { task, git, source, dir } = await securityWorkspace();
  const child = join(dir, "child");
  await mkdir(child);
  await checked("git", ["init", "-b", "main"], child);
  await checked("git", ["config", "user.name", "Fixture"], child);
  await checked("git", ["config", "user.email", "fixture@example.invalid"], child);
  await writeFile(join(child, "child.txt"), "child contents");
  await checked("git", ["add", "."], child);
  await checked("git", ["commit", "-m", "child"], child);

  await checked(
    "git",
    ["-c", "protocol.file.allow=always", "submodule", "add", child, "module"],
    task.worktree_path,
  );

  await checked("git", ["commit", "-m", "submodule"], task.worktree_path);
  const initialized = await git.fingerprint(task);
  await writeFile(join(task.worktree_path, "module", "child.txt"), "changed child");
  expect(await git.fingerprint(task)).not.toBe(initialized);

  await checked(
    "git",
    ["worktree", "add", "-b", "uninitialized", join(task.worktree_path, "..", "second"), "HEAD"],
    task.worktree_path,
  );

  const second = {
    ...task,
    branch_name: "uninitialized",
    worktree_path: join(task.worktree_path, "..", "second"),
  };

  expect(await git.fingerprint(second)).toMatch(/^issue-v2:/);
  expect(await readFile(join(source, "file.txt"), "utf8")).toBe("base\n");
});
