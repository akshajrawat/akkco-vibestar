import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createFixtureEngine } from "../helpers/fixtures";
import { Rpc } from "../../backend/rpc";
import { builtInProfiles } from "../../backend/flows/templates";

it("resets the old library once while retaining Tasks and referenced profile revisions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-reset-"));
  let engine = await createFixtureEngine(dir);
  try {
    const base = engine.flows.profile(builtInProfiles.implementer);
    const custom = { ...base, id: randomUUID(), name: "Old Viber" };
    const unused = { ...base, id: randomUUID(), name: "Unused Viber" };
    engine.flows.saveProfile(custom, null);
    engine.flows.saveProfile(unused, null);

    const solo = engine.createGeneralTask({
      request_id: randomUUID(),
      goal: "Solo chat",
      profile_id: custom.id,
      repository_id: null,
    });

    engine.db.run(
      "INSERT INTO task_messages(id,task_id,role,content,created_at,status,purpose) VALUES(?,?,'user','Hello',?,'chat_completed','chat')",
      randomUUID(),
      solo.id,
      new Date().toISOString(),
    );

    const untouched = engine.createGeneralTask({
      request_id: randomUUID(),
      goal: "Single-agent Task",
      profile_id: custom.id,
      repository_id: null,
    });

    const task = engine.createGeneralTask({
      request_id: randomUUID(),
      goal: "Workflow",
      profile_id: custom.id,
      repository_id: null,
      template: "full",
    });

    for (const table of [
      "retired_viber_profiles",
      "retired_viber_conversations",
      "viber_session_settings",
    ])
      engine.db.run(`DROP TABLE ${table}`);
    engine.db.run("DELETE FROM schema_migrations WHERE version=37");
    await engine.close();
    engine = await createFixtureEngine(dir);
    expect(engine.flows.profile(custom.id)).toEqual(custom);
    expect(() => engine.flows.profile(unused.id)).toThrow();
    expect(engine.db.task(task.id).goal).toBe("Workflow");

    expect(engine.db.all("SELECT task_id FROM retired_viber_conversations")).toEqual([
      { task_id: solo.id },
    ]);

    expect(engine.db.task(untouched.id).goal).toBe("Single-agent Task");
    const rpc = new Rpc(engine);
    const snapshot = (await rpc.call("snapshot", {})) as { tasks: { id: string }[] };

    expect(snapshot.tasks.map((task) => task.id)).toEqual(
      expect.arrayContaining([solo.id, untouched.id, task.id]),
    );

    const instances = (await rpc.call("viber.instances", {})) as { task_id: string }[];
    expect(instances.some((instance) => instance.task_id === solo.id)).toBe(false);
    expect(await rpc.call("profile.list", {})).not.toContainEqual(custom);
    const fresh = { ...base, id: randomUUID(), name: "Fresh Viber" };
    engine.flows.saveProfile(fresh, null);
    await rpc.close();
    await engine.close();
    engine = await createFixtureEngine(dir);
    expect(engine.flows.profile(fresh.id)).toEqual(fresh);

    expect(
      engine.db.all("SELECT profile_id FROM retired_viber_profiles WHERE profile_id=?", fresh.id),
    ).toEqual([]);

    expect(engine.db.all("PRAGMA foreign_key_check")).toEqual([]);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});
