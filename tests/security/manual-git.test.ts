import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Rpc } from "../../backend/rpc";
import { createFixtureEngine } from "../helpers/fixtures";

it("rejects retired commit, push and destination methods without executing Git or inference", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-manual-git-rpc-"));

  const engine = await createFixtureEngine(join(dir, "data"), () => {
    throw new Error("Retired Git operations must not invoke a provider");
  });

  const rpc = new Rpc(engine);
  try {
    for (const method of [
      "git.inspect",
      "git.preview",
      "git.approve",
      "git.commit",
      "git.publish",
      "repository.configureDestination",
      "repair.approve",
      "repair.approveLocal",
      "repair.commit",
      "repair.preparePublication",
      "repair.publish",
      "repair.reconcilePublication",
      "repair.keepLocal",
    ])
      await expect(rpc.call(method, {})).rejects.toMatchObject({ kind: "invalid_method" });

    expect(engine.db.all("SELECT id FROM git_finalizations")).toEqual([]);
    expect(engine.db.all("SELECT id FROM repair_publications")).toEqual([]);
    expect(engine.db.all("SELECT id FROM agent_runs")).toEqual([]);
  } finally {
    await rpc.close();
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});
