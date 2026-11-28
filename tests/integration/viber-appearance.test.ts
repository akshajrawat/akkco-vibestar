import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { defaultAppearance } from "../../apps/core/vibers/appearance";
import type { AgentProfile } from "../../apps/core/vibers/contracts";
import { Rpc } from "../../apps/core/rpc";
import { createFixtureEngine } from "../helpers/fixtures";

it("round-trips appearance and description through profile RPC and database reopen while preserving legacy bytes and revisions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-appearance-"));
  let engine = await createFixtureEngine(dir);
  let rpc = new Rpc(engine);
  try {
    const fixture = engine.vibers.profile(
      engine.db.all<{ id: string }>("SELECT id FROM agent_profiles")[0].id,
    );

    const original: AgentProfile = {
      ...fixture,
      id: randomUUID(),
      appearance: {
        version: 1,
        shape: "capsule",
        color: "#123aBc",
        device: "laptop",
        eyes: "wink",
        eyebrows: "sharp",
        glasses: "oversized",
        accessory: "headphones",
      },
    };

    await rpc.call("profile.save", { profile: original, expected_revision: null });
    const scope = { session_id: randomUUID(), profile_id: original.id };

    await rpc.call("viber.session.create", {
      profile_id: original.id,
      request_id: scope.session_id,
    });

    await rpc.call("viber.session.send", {
      ...scope,
      request_id: randomUUID(),
      content: "/clear",
      history_ids: [],
    });

    const conversation = await rpc.call("viber.session.detail", scope);
    expect(conversation).toMatchObject({ messages: [expect.anything(), expect.anything()] });

    const bytes = () =>
      engine.db.all<{ data: string }>(
        "SELECT data FROM agent_profile_revisions WHERE profile_id=? AND revision=1",
        original.id,
      )[0].data;

    const legacy = bytes();
    expect(engine.vibers.profile(original.id)).toEqual(original);
    expect(bytes()).toBe(legacy);

    const appearance = {
      ...defaultAppearance(),
      shape: "double-blob" as const,
      color: "#ba33c9",
      headwear: "crown" as const,
      neckwear: "scarf" as const,
      extra: "sparkles" as const,
      colors: { eyes: "#000000", headwear: "#f19e00", neckwear: "#ffffff", extra: "#30d8d0" },
    };

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
    expect(engine.vibers.profile(profile.id)).toEqual(profile);
    expect(engine.vibers.profile(original.id, 1)).toEqual(original);

    expect(engine.vibers.profile(original.id)).toEqual({
      ...original,
      revision: 2,
      appearance,
      description: "Legacy Viber, new look",
    });

    expect(bytes()).toBe(legacy);
    expect(await rpc.call("viber.session.detail", scope)).toEqual(conversation);
  } finally {
    await rpc.close();
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("starts a fresh core without default Vibers and preserves existing profile bytes on reopen", async () => {
  const { Engine } = await import("../../apps/core/execution/engine");
  const dir = await mkdtemp(join(tmpdir(), "vibestar-no-defaults-"));
  let engine = await Engine.create(dir);
  try {
    expect(engine.db.all("SELECT id FROM agent_profiles")).toEqual([]);

    const custom = {
      id: randomUUID(),
      revision: 1,
      name: "My Buddy",
      appearance: defaultAppearance(),
      instructions: "Work on user tasks",
      supported_access: ["read-only", "workspace-write"] as ("read-only" | "workspace-write")[],
      execution: {
        provider: "codex" as const,
        model: "codex",
        effort: "high",
        timeout_secs: 1800,
        access: "workspace-write" as const,
        output: "conversation" as const,
      },
    };

    engine.vibers.saveProfile(custom, null);
    expect(engine.vibers.profile(custom.id)).toEqual(custom);

    await engine.close();
    engine = await Engine.create(dir);
    expect(engine.vibers.profile(custom.id)).toEqual(custom);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});
