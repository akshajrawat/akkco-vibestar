import { expect, it } from "vitest";

import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checked } from "../../backend/execution/runtime/process";
import { taskRuntime } from "../../backend/workspace/runtime";
import { createFixtureEngine, fixtureRepository, prepareFixtureTask } from "../helpers/fixtures";

it("refuses dependency aliases and tracked or nonempty destinations while preserving exact nested path names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibestar-nested-runtime-"));
  const engine = await createFixtureEngine(join(directory, "data"));
  try {
    const { repo, upstream } = await fixtureRepository(engine, directory);

    const packages = [
      "packages/ suite",
      "packages/occupied",
      "packages/alias",
      "packages/tracked",
      "packages/linked-parent",
    ];

    for (const name of packages) {
      await mkdir(join(upstream, name), { recursive: true });
      await writeFile(join(upstream, name, "package.json"), "{}\n");
    }

    await writeFile(join(repo.path, ".git", "info", "exclude"), "node_modules/\n");
    await checked("git", ["add", "--", "packages"], upstream);

    await checked(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "Package fixtures",
      ],
      upstream,
    );

    await engine.git.fetch(repo);
    await checked("git", ["merge", "--ff-only", "refs/remotes/upstream/main"], repo.path);
    const task = await prepareFixtureTask(engine, repo, "nested-runtime");
    for (const name of packages) {
      await mkdir(join(repo.path, name, "node_modules"));
      await writeFile(join(repo.path, name, "node_modules", "dependency.txt"), "installed\n");
    }

    const occupied = join(task.worktree_path, "packages/occupied/node_modules");
    await mkdir(occupied);
    await writeFile(join(occupied, "user.txt"), "keep\n");
    const outside = join(directory, "outside");
    await mkdir(outside);
    await symlink(outside, join(task.worktree_path, "packages/alias/node_modules"));
    const linkedParent = join(task.worktree_path, "packages/linked-parent");
    await rm(linkedParent, { recursive: true });
    await symlink(outside, linkedParent);
    const tracked = join(task.worktree_path, "packages/tracked/node_modules");
    await mkdir(tracked);
    await writeFile(join(tracked, "tracked.txt"), "owned by task\n");

    await checked(
      "git",
      ["add", "--force", "--", "packages/tracked/node_modules/tracked.txt"],
      task.worktree_path,
    );

    const runtime = await taskRuntime(repo.path, task.worktree_path, true);
    expect(runtime.dependencies).toEqual(["packages/ suite/node_modules"]);

    expect(runtime.mounts).toContainEqual({
      source: join(repo.path, "packages/ suite/node_modules"),
      target: join(task.worktree_path, "packages/ suite/node_modules"),
    });

    expect(await readFile(join(occupied, "user.txt"), "utf8")).toBe("keep\n");
    expect(await readFile(join(tracked, "tracked.txt"), "utf8")).toBe("owned by task\n");

    expect(
      runtime.mounts.some((mount) => mount.source === outside || mount.target.startsWith(outside)),
    ).toBe(false);
  } finally {
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
