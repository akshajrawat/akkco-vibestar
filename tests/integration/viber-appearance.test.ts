import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { defaultAppearance } from "../../apps/core/flows/appearance";
import { Rpc } from "../../apps/core/rpc";
import { createFixtureEngine } from "../helpers/fixtures";

it("round-trips appearance and description through profile RPC and database reopen while preserving legacy bytes and revisions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-appearance-"));
  let engine = await createFixtureEngine(dir);
  let rpc = new Rpc(engine);
  try {
    const original = engine.flows.profile(
      engine.db.all<{ id: string }>("SELECT id FROM agent_profiles")[0].id,
    );

    const bytes = () =>
      engine.db.all<{ data: string }>(
        "SELECT data FROM agent_profile_revisions WHERE profile_id=? AND revision=1",
        original.id,
      )[0].data;

    const legacy = bytes();
    expect(original.appearance).toBeUndefined();
    expect(engine.flows.profile(original.id)).toEqual(original);
    expect(bytes()).toBe(legacy);
    const appearance = { ...defaultAppearance(), color: "#123aBc", lips: "smile" as const };
    const profile = { ...original, id: randomUUID(), appearance, description: "Fixture avatar" };
    await rpc.call("profile.save", { profile, expected_revision: null });

    await rpc.call("profile.save", {
      profile: { ...original, revision: 2, appearance, description: "Legacy Viber, new look" },
      expected_revision: 1,
    });

    await expect(
      rpc.call("profile.save", {
        profile: { ...original, revision: 3, appearance: { ...appearance, version: 9 } },
        expected_revision: 2,
      }),
    ).rejects.toThrow();

    await expect(
      rpc.call("profile.save", {
        profile: { ...original, revision: 2, appearance },
        expected_revision: 1,
      }),
    ).rejects.toThrow();

    await rpc.close();
    await engine.close();
    engine = await createFixtureEngine(dir);
    rpc = new Rpc(engine);
    expect(engine.flows.profile(profile.id)).toEqual(profile);
    expect(engine.flows.profile(original.id, 1)).toEqual(original);

    expect(engine.flows.profile(original.id)).toEqual({
      ...original,
      revision: 2,
      appearance,
      description: "Legacy Viber, new look",
    });

    expect(defaultAppearance()).toEqual(defaultAppearance());
    expect(bytes()).toBe(legacy);
    expect(engine.db.all("SELECT id FROM flow_runs")).toHaveLength(0);
  } finally {
    await rpc.close();
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("starts a fresh core without default Vibers and preserves existing task profile bytes on reopen", async () => {
  const { Engine } = await import("../../apps/core/execution/engine");
  const { isCustomViber } = await import("../../apps/core/flows/templates");
  const dir = await mkdtemp(join(tmpdir(), "vibestar-no-defaults-"));
  let engine = await Engine.create(dir);
  try {
    expect(engine.db.all("SELECT id FROM agent_profiles")).toEqual([]);
    const { initializeProfiles } = await import("../../apps/core/flows/defaults");
    initializeProfiles(engine.db);

    const records = engine.db.all<{ data: string }>(
      "SELECT data FROM agent_profile_revisions ORDER BY profile_id",
    );

    const builtIn = JSON.parse(records[0].data);
    expect(isCustomViber(builtIn)).toBe(false);

    const custom = {
      ...builtIn,
      id: randomUUID(),
      name: "My Buddy",
      appearance: defaultAppearance(),
    };

    engine.flows.saveProfile(custom, null);
    expect(isCustomViber(custom)).toBe(true);
    await engine.close();
    engine = await Engine.create(dir);

    expect(
      engine.db.all(
        "SELECT data FROM agent_profile_revisions WHERE profile_id!=? ORDER BY profile_id",
        custom.id,
      ),
    ).toEqual(records);

    expect(engine.flows.profile(custom.id)).toEqual(custom);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});
