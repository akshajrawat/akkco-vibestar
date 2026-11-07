import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { Database } from "../../backend/storage/database";
import { FlowStore } from "../../backend/flows/store";
import { AgentProfileSchema, type FlowDefinition } from "../../backend/flows/contracts";

it("keeps profile and flow revisions immutable across edits, layout changes and database reopening", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-flow-store-"));
  const path = join(dir, "state.sqlite");
  let db = await Database.open(path);
  try {
    let store = new FlowStore(db);

    const profile = AgentProfileSchema.parse({
      id: randomUUID(),
      revision: 1,
      name: "A Viber",
      instructions: "Original instructions",
      supported_access: ["read-only", "workspace-write"],
      execution: {
        provider: "codex",
        model: "original-model",
        effort: "low",
        timeout_secs: 60,
        access: "workspace-write",
        output: "summary",
      },
    });

    store.saveProfile(profile, null);
    const flowId = randomUUID();
    const nodeId = randomUUID();

    const definition: FlowDefinition = {
      name: "Solo or flow",
      nodes: [
        {
          id: nodeId,
          type: "agent",
          name: "My Viber",
          profile_id: profile.id,
          instructions: "",
          overrides: {},
          inputs: [{ kind: "task-goal" }],
          completion: { verification: "record-only", review: "none" },
        },
      ],
      edges: [],
    };

    const first = store.saveDefinition(flowId, definition, null);

    const layout = {
      positions: { [nodeId]: { x: 120, y: 150 } },
      viewport: { x: 10, y: 0, zoom: 1 },
    };

    store.saveLayout(flowId, layout);
    store.saveLayout(flowId, { ...layout, viewport: { ...layout.viewport, zoom: 0.5 } });
    expect(store.definition(flowId)).toEqual(first);
    expect(db.all("SELECT * FROM flow_revisions")).toHaveLength(1);

    expect(() =>
      store.saveLayout(flowId, { ...layout, positions: { [randomUUID()]: { x: 0, y: 0 } } }),
    ).toThrow("must belong");

    store.saveProfile(
      {
        ...profile,
        revision: 2,
        instructions: "Future instructions",
        execution: { ...profile.execution, model: "future-model" },
      },
      1,
    );

    store.saveDefinition(flowId, { ...definition, name: "Edited flow" }, 1);
    expect(() => store.saveDefinition(flowId, definition, 1)).toThrow("Reload");
    expect(() => store.saveProfile({ ...profile, revision: 2 }, 1)).toThrow("Reload");
    expect(() => store.saveDefinition(randomUUID(), definition, 1)).toThrow("Reload");
    expect(db.all("SELECT * FROM flow_revisions")).toHaveLength(2);
    expect(store.profile(profile.id, 1)).toEqual(profile);
    expect(store.profile(profile.id).instructions).toBe("Future instructions");
    expect(db.all("SELECT * FROM agent_runs")).toEqual([]);
    expect(db.all("SELECT * FROM utility_runs")).toEqual([]);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    db.close();
    db = await Database.open(path);
    store = new FlowStore(db);
    expect(store.definition(flowId, 1)).toEqual(first);
    expect(store.definition(flowId).definition.name).toBe("Edited flow");
    expect(store.profile(profile.id, 1)).toEqual(profile);
    expect(store.layout(flowId)?.viewport.zoom).toBe(0.5);

    const raw = '{"corrupt":"profile"}';

    db.run(
      "UPDATE agent_profile_revisions SET data=? WHERE profile_id=? AND revision=2",
      raw,
      profile.id,
    );

    expect(() => store.profile(profile.id)).toThrow("original data is preserved");

    expect(
      db.all<{ data: string }>(
        "SELECT data FROM agent_profile_revisions WHERE profile_id=? AND revision=2",
        profile.id,
      )[0].data,
    ).toBe(raw);

    expect(db.records.diagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table_name: "agent_profile_revisions",
          record_id: `${profile.id}:2`,
        }),
      ]),
    );

    expect(store.profile(profile.id, 1)).toEqual(profile);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("binds saved flows to their task and rolls back missing task ownership", () => {
  const db = new Database(":memory:");
  try {
    const store = new FlowStore(db);
    const flowId = randomUUID();
    const definition = { name: "Empty draft", nodes: [], edges: [] };
    expect(() => store.saveDefinition(flowId, definition, null, "missing-task")).toThrow();
    expect(db.all("SELECT * FROM flow_definitions")).toEqual([]);
    expect(db.all("SELECT * FROM flow_revisions")).toEqual([]);
    db.run("INSERT INTO repositories VALUES('repo','fixture','fixture','{}')");
    for (const id of ["task-a", "task-b"])
      db.run(
        "INSERT INTO tasks(id,repo_id,status,stage,data,created_at) VALUES(?,'repo','not_started',0,'{}','fixture')",
        id,
      );
    store.saveDefinition(flowId, definition, null, "task-a");
    expect(() => store.saveDefinition(flowId, definition, 1, "task-b")).toThrow("another task");
    expect(store.definition(flowId).revision).toBe(1);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  } finally {
    db.close();
  }
});
