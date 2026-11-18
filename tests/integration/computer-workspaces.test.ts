import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createFixtureEngine, fixtureRepository } from "../helpers/fixtures";
import { Rpc } from "../../apps/core/rpc";
import { builtInProfiles } from "../../apps/core/vibers/appearance";

it("keeps each session's owned workspace and deletes every workspace and computer when its Viber is deleted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibestar-computer-workspaces-"));
  const engine = await createFixtureEngine(join(directory, "data"));
  const rpc = new Rpc(engine);
  try {
    const { repo } = await fixtureRepository(engine, directory);

    const create = async (profile_id: string, repository_id?: string) =>
      engine.viberSessions.store.create({ request_id: randomUUID(), profile_id, repository_id });

    const profile_id = builtInProfiles.implementer;
    const managed = await create(profile_id);
    const repository = await create(profile_id, repo.id);
    const sibling = await create(builtInProfiles.reviewer);
    const files = await engine.viberSessions.prepareWorkspace(managed.id, profile_id);
    const worktree = await engine.viberSessions.prepareWorkspace(repository.id, profile_id);

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
      rpc.call("computer.files", { profile_id: sibling.profile_id, session_id: managed.id }),
    ).rejects.toThrow("not found");

    expect(
      await rpc.call("computer.files", { profile_id, session_id: repository.id }),
    ).toMatchObject({
      entries: expect.arrayContaining([{ name: "source.txt", directory: false }]),
    });

    const release = engine.computers.acquire(
      { profile_id, session_id: managed.id },
      "agent",
      async () => {},
    );

    await expect(rpc.call("profile.delete", { profile_id, confirmed: true })).rejects.toThrow(
      "active operations",
    );

    release();
    await expect(rpc.call("profile.delete", { profile_id })).rejects.toThrow();
    await rpc.call("profile.delete", { profile_id, confirmed: true });
    await expect(stat(files)).rejects.toThrow();
    await expect(stat(worktree)).rejects.toThrow();
    expect(await readFile(join(siblingFiles, "retained.txt"), "utf8")).toBe("another Viber");

    expect(await rpc.call("profile.list", {})).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: profile_id })]),
    );

    await expect(rpc.call("computer.status", { profile_id })).rejects.toThrow("active Viber");
    expect(engine.db.all("PRAGMA foreign_key_check")).toEqual([]);
  } finally {
    await rpc.close();
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  }
});
