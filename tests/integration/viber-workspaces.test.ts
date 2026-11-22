import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";

import { createFixtureEngine, fixtureRepository } from "../helpers/fixtures";
import { Rpc } from "../../apps/core/rpc";
import { gitChecked } from "../../apps/core/workspace/git-command";
import { testProfileIds as builtInProfiles } from "../helpers/viber-fixtures";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, lstat: vi.fn(fs.lstat), rename: vi.fn(fs.rename), rm: vi.fn(fs.rm) };
});

it("keeps each session's owned workspace and removes it when its Viber is deleted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibestar-session-workspaces-"));
  const engine = await createFixtureEngine(join(directory, "data"));
  const rpc = new Rpc(engine);
  try {
    const { repo } = await fixtureRepository(engine, directory);

    const create = async (profile_id: string, repository_id?: string) =>
      engine.viberSessions.store.create({ request_id: randomUUID(), profile_id, repository_id });

    const profile_id = builtInProfiles.implementer;
    const managed = await create(profile_id);

    await expect(create(profile_id)).rejects.toThrow(
      "Each Viber owns exactly one continuous conversation",
    );

    const repository = await create(builtInProfiles.planner, repo.id);
    const sibling = await create(builtInProfiles.reviewer);
    const files = await engine.viberSessions.prepareWorkspace(managed.id, profile_id);

    const worktree = await engine.viberSessions.prepareWorkspace(
      repository.id,
      builtInProfiles.planner,
    );

    const siblingFiles = await engine.viberSessions.prepareWorkspace(
      sibling.id,
      sibling.profile_id,
    );

    await writeFile(join(files, "notes.txt"), "keep across sessions");
    await writeFile(join(worktree, "source.txt"), "dirty work explicitly discarded on deletion");
    await writeFile(join(siblingFiles, "retained.txt"), "another Viber");
    expect(await engine.viberSessions.prepareWorkspace(managed.id, profile_id)).toBe(files);
    expect(await readFile(join(files, "notes.txt"), "utf8")).toBe("keep across sessions");

    await expect(
      rpc.call("viber.session.inspect", { profile_id: sibling.profile_id, session_id: managed.id }),
    ).rejects.toThrow("not found");

    const release = engine.trackActivity(
      { id: "test-active-run", kind: "viber", label: "Viber is running", stoppable: false },
      async () => {},
    );

    await expect(rpc.call("profile.delete", { profile_id, confirmed: true })).rejects.toThrow(
      "active operations",
    );

    release();
    await expect(rpc.call("profile.delete", { profile_id })).rejects.toThrow();

    const logs = join(engine.root, "logs", `viber-${managed.id}`);
    await symlink(siblingFiles, logs);

    await expect(rpc.call("profile.delete", { profile_id, confirmed: true })).rejects.toThrow(
      "symlink",
    );

    await expect(stat(files)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(logs);
    await mkdir(logs);
    await writeFile(join(logs, "run.jsonl"), "synthetic log");
    await rpc.call("profile.delete", { profile_id, confirmed: true });
    await expect(stat(logs)).rejects.toMatchObject({ code: "ENOENT" });

    const workspace = engine.viberSessions.store.workspace(repository.id);
    const branch = `refs/heads/${workspace.branch_name}`;
    const lock = join(await engine.git.commonDirectory(repo.path), `${branch}.lock`);

    const deletePlanner = () =>
      rpc.call("profile.delete", { profile_id: builtInProfiles.planner, confirmed: true });

    await writeFile(lock, "", { flag: "wx" });
    await expect(deletePlanner()).rejects.toThrow("git exited");
    await expect(stat(worktree)).rejects.toMatchObject({ code: "ENOENT" });

    expect(engine.viberSessions.store.workspace(repository.id).workspace_checkpoint?.state).toBe(
      "removing",
    );

    expect(await gitChecked(["rev-parse", "--verify", branch], repo.path)).toBe(
      workspace.base_commit_sha,
    );

    await rm(lock);
    const marker = `branch.${workspace.branch_name}.vibestarTask`;
    await gitChecked(["config", "--local", marker, randomUUID()], repo.path);
    await expect(deletePlanner()).rejects.toThrow("ownership changed");

    expect(await gitChecked(["rev-parse", "--verify", branch], repo.path)).toBe(
      workspace.base_commit_sha,
    );

    await gitChecked(["config", "--local", "--unset", marker], repo.path);
    await expect(deletePlanner()).rejects.toThrow("ownership changed");

    await gitChecked(["config", "--local", marker, workspace.id], repo.path);
    await deletePlanner();
    await expect(gitChecked(["rev-parse", "--verify", branch], repo.path)).rejects.toThrow();
    expect(await readFile(join(siblingFiles, "retained.txt"), "utf8")).toBe("another Viber");

    expect(await rpc.call("profile.list", {})).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: profile_id })]),
    );

    await expect(rpc.call("profile.delete", { profile_id, confirmed: true })).rejects.toThrow(
      "active Viber",
    );

    expect(engine.db.all("PRAGMA foreign_key_check")).toEqual([]);
  } finally {
    await rpc.close();
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["before move", "after move", "after partial removal", "after full removal"])(
  "retries managed workspace deletion after interruption %s",
  async (interruption) => {
    const directory = await mkdtemp(join(tmpdir(), "vibestar-session-removal-"));
    const data = join(directory, "data");
    let engine = await createFixtureEngine(data);
    let rpc = new Rpc(engine);

    try {
      const profile_id = builtInProfiles.implementer;
      const session = engine.viberSessions.store.create({ request_id: randomUUID(), profile_id });
      const files = await engine.viberSessions.prepareWorkspace(session.id, profile_id);
      const owner = dirname(files);
      const marker = join(owner, "vibestar-task-owner");
      const retained = join(files, "retained.txt");
      const deleteProfile = () => rpc.call("profile.delete", { profile_id, confirmed: true });
      const workspace = () => engine.viberSessions.store.workspace(session.id);

      await writeFile(retained, "remaining workspace data");
      const markerContents = await readFile(marker, "utf8");
      await rm(marker);
      await expect(deleteProfile()).rejects.toThrow("ownership could not be proved");
      expect(workspace().managed_removal_identity).toBeUndefined();
      expect(await readFile(retained, "utf8")).toBe("remaining workspace data");
      await writeFile(marker, markerContents);

      const {
        lstat: realLstat,
        rename: realRename,
        rm: realRm,
      } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

      let quarantine = "";
      let timestampDrift = 0n;

      // Some filesystems report ctime where birthtime is not available. Model
      // that mutable field advancing at the quarantined path throughout retry.
      vi.mocked(lstat).mockImplementation((async (path, options) => {
        const entry = await realLstat(path, options as { bigint: true });
        if (
          dirname(String(path)) === join(dirname(owner), "pending-delete") &&
          typeof entry.birthtimeNs === "bigint"
        ) {
          entry.birthtimeNs += ++timestampDrift;
        }

        return entry;
      }) as typeof lstat);

      if (interruption === "before move" || interruption === "after move") {
        vi.mocked(rename).mockImplementationOnce(async (from, to) => {
          expect(from).toBe(owner);
          quarantine = String(to);
          if (interruption === "after move") {
            await realRename(from, to);
          }

          throw new Error("interrupted workspace removal");
        });
      } else {
        vi.mocked(rm).mockImplementationOnce(async (path, options) => {
          quarantine = String(path);
          expect(dirname(quarantine)).toBe(join(dirname(owner), "pending-delete"));
          expect(quarantine).not.toBe(owner);
          if (interruption === "after partial removal") {
            await realRm(join(quarantine, "vibestar-task-owner"));
          } else {
            await realRm(path, options);
          }

          throw new Error("interrupted workspace removal");
        });
      }

      await expect(deleteProfile()).rejects.toThrow("interrupted workspace removal");
      expect(workspace().worktree_path).toBe(files);

      expect(workspace().managed_removal_identity).toMatch(
        interruption.endsWith("move") ? /^moving:/ : /^quarantined:/,
      );

      await rpc.close();
      await engine.close();
      engine = await createFixtureEngine(data);
      rpc = new Rpc(engine);

      await expect(engine.viberSessions.prepareWorkspace(session.id, profile_id)).rejects.toThrow(
        "removal is pending",
      );

      if (interruption === "before move") {
        // A stale checkpoint must not authorize moving a replacement workspace.
        const moved = join(directory, "moved");
        await rename(owner, moved);
        await mkdir(owner);
        await writeFile(join(owner, "unrelated.txt"), "unrelated data");
        await expect(deleteProfile()).rejects.toThrow("directory changed during removal");
        expect(await readFile(join(owner, "unrelated.txt"), "utf8")).toBe("unrelated data");
        await rename(owner, join(directory, "replacement"));
        await rename(moved, owner);
      } else {
        await expect(stat(owner)).rejects.toMatchObject({ code: "ENOENT" });
        await mkdir(owner);
        await writeFile(join(owner, "unrelated.txt"), "unrelated data");
      }

      if (interruption === "after partial removal") {
        // A replacement at the quarantine path must be preserved too.
        await expect(stat(join(quarantine, "vibestar-task-owner"))).rejects.toMatchObject({
          code: "ENOENT",
        });

        const retainedQuarantine = join(directory, "quarantine");
        await rename(quarantine, retainedQuarantine);
        await mkdir(quarantine);
        await writeFile(join(quarantine, "unrelated.txt"), "unrelated quarantine data");
        await expect(deleteProfile()).rejects.toThrow("directory changed during removal");

        expect(await readFile(join(quarantine, "unrelated.txt"), "utf8")).toBe(
          "unrelated quarantine data",
        );

        await rename(quarantine, join(directory, "replacement-quarantine"));
        await rename(retainedQuarantine, quarantine);
      }

      await deleteProfile();
      await expect(stat(quarantine)).rejects.toMatchObject({ code: "ENOENT" });
      if (interruption !== "before move") {
        expect(await readFile(join(owner, "unrelated.txt"), "utf8")).toBe("unrelated data");
      }

      expect(timestampDrift).toBeGreaterThan(0n);
      expect(workspace().worktree_path).toBe("");
      expect(workspace().managed_removal_identity).toBeUndefined();
      await expect(deleteProfile()).rejects.toThrow("active Viber");
    } finally {
      vi.mocked(lstat).mockReset();
      await rpc.close();
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
