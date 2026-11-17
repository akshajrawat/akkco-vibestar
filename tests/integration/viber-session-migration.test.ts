import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Sqlite from "better-sqlite3";
import { expect, it } from "vitest";

import { Database } from "../../apps/core/storage/database";
import { migrations } from "../../apps/core/storage/migrations";

it("adds standalone session storage to version 37 without rewriting Task, Flow, profile, message or execution history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-session-migration-"));
  const path = join(dir, "state.sqlite");
  const old = new Sqlite(path);
  old.pragma("foreign_keys = OFF");
  let db: Database | undefined;
  try {
    old.pragma("foreign_keys = OFF");
    for (const migration of migrations.filter((migration) => migration.version <= 37)) {
      old.exec(migration.sql);

      old
        .prepare("INSERT OR IGNORE INTO schema_migrations VALUES(?,?)")
        .run(migration.version, "before");
    }

    const profileId = randomUUID();
    const taskId = randomUUID();
    const flowId = randomUUID();
    const runId = randomUUID();
    const agentId = randomUUID();
    const utilityId = randomUUID();
    const messageId = randomUUID();
    const timestamp = "2026-11-01T00:00:00.000Z";
    const source = '{ "preserve": "original source bytes", "historical": true }';
    old.prepare("INSERT INTO agent_profiles VALUES(?,1,?,?)").run(profileId, timestamp, timestamp);

    old
      .prepare("INSERT INTO agent_profile_revisions VALUES(?,1,?,?)")
      .run(profileId, source, timestamp);

    old
      .prepare(
        "INSERT INTO tasks(id,repo_id,status,stage,data,created_at) VALUES(?,NULL,'completed',0,?,?)",
      )
      .run(taskId, source, timestamp);

    old
      .prepare("INSERT INTO flow_definitions VALUES(?,?,1,?,?)")
      .run(flowId, taskId, timestamp, timestamp);

    old.prepare("INSERT INTO flow_revisions VALUES(?,1,?,?)").run(flowId, source, timestamp);

    old
      .prepare(
        "INSERT INTO flow_runs(id,flow_id,revision,task_id,status,request_id,request_digest,snapshot,created_at,updated_at,kind) VALUES(?,?,1,?,'completed',?,?,?,?,?,'conversation')",
      )
      .run(runId, flowId, taskId, randomUUID(), "retained-digest", source, timestamp, timestamp);

    old
      .prepare(
        "INSERT INTO agent_runs(id,task_id,stage,provider,model,effort,prompt,status,started_at,purpose,execution) VALUES(?,?,0,'codex','old-model','high','Historical prompt','completed',?,'Solo Viber',?)",
      )
      .run(agentId, taskId, timestamp, source);

    old
      .prepare(
        "INSERT INTO agent_events(run_id,task_id,timestamp,kind,data,raw,stream) VALUES(?,?,?,'message',?,?,'stdout')",
      )
      .run(agentId, taskId, timestamp, source, source);

    old
      .prepare(
        "INSERT INTO task_messages(id,task_id,role,content,created_at,status,run_id,purpose,flow_node_id,viber_profile_id) VALUES(?,?,'assistant',?,?,'chat_completed',?,'chat',?,?)",
      )
      .run(messageId, taskId, source, timestamp, agentId, randomUUID(), profileId);

    old
      .prepare("INSERT INTO viber_session_settings VALUES(?,?,?)")
      .run(taskId, randomUUID(), '{"provider":"codex","model":"old-model","effort":"high"}');

    old
      .prepare(
        "INSERT INTO utility_runs(id,stage,provider,model,effort,prompt,status,started_at,purpose) VALUES(?,0,'codex','old-model','low','Retained utility prompt','completed',?,'utility')",
      )
      .run(utilityId, timestamp);

    const tables = [
      "tasks",
      "flow_definitions",
      "flow_revisions",
      "flow_runs",
      "agent_profiles",
      "agent_profile_revisions",
      "task_messages",
      "agent_runs",
      "agent_events",
      "viber_session_settings",
    ];

    const before = tables.map((table) => old.prepare(`SELECT * FROM ${table}`).all());
    old.close();
    db = await Database.open(path);

    tables.forEach((table, index) =>
      expect(db!.all(`SELECT * FROM ${table}`)).toEqual(before[index]),
    );

    expect(db.all("SELECT * FROM viber_sessions")).toEqual([]);
    expect(db.all("SELECT * FROM viber_messages")).toEqual([]);

    expect(
      db.all("SELECT viber_session_id,viber_message_id FROM utility_runs WHERE id=?", utilityId),
    ).toEqual([{ viber_session_id: null, viber_message_id: null }]);

    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    const versions = db.all("SELECT version FROM schema_migrations");
    db.close();
    db = await Database.open(path);
    expect(db.all("SELECT version FROM schema_migrations")).toEqual(versions);

    tables.forEach((table, index) =>
      expect(db!.all(`SELECT * FROM ${table}`)).toEqual(before[index]),
    );
  } finally {
    if (old.open) {
      old.close();
    }

    db?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("preserves version 38 sessions without inventing native continuity or workspace ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibestar-native-migration-"));
  const path = join(directory, "state.sqlite");
  const old = new Sqlite(path);
  old.pragma("foreign_keys = OFF");
  let db: Database | undefined;
  try {
    for (const migration of migrations.filter((migration) => migration.version <= 38)) {
      old.exec(migration.sql);

      old
        .prepare("INSERT OR IGNORE INTO schema_migrations VALUES(?,?)")
        .run(migration.version, "before");
    }

    const profile = randomUUID();
    const session = randomUUID();
    const message = randomUUID();
    const failed = randomUUID();
    const timestamp = "2026-11-01T00:00:00.000Z";
    const selection = { provider: "codex", model: "old-model", effort: "high" };
    const configuration = JSON.stringify({ request_id: session, profile_id: profile, selection });
    old.prepare("INSERT INTO agent_profiles VALUES(?,1,?,?)").run(profile, timestamp, timestamp);
    old.prepare("INSERT INTO agent_profile_revisions VALUES(?,1,'{}',?)").run(profile, timestamp);

    old
      .prepare("INSERT INTO viber_sessions VALUES(?,?,?,?,?,?,?)")
      .run(
        session,
        profile,
        "Legacy chat",
        JSON.stringify(selection),
        configuration,
        timestamp,
        timestamp,
      );

    old
      .prepare(
        "INSERT INTO viber_messages(id,session_id,role,content,status,created_at) VALUES(?,?,'assistant','Retained answer','completed',?)",
      )
      .run(message, session, timestamp);

    old
      .prepare(
        "INSERT INTO viber_messages(id,session_id,role,content,status,created_at) VALUES(?,?,'user','Unknown execution outcome','failed',?)",
      )
      .run(failed, session, timestamp);

    old.close();
    db = await Database.open(path);
    const { ViberSessionStore } = await import("../../apps/core/vibers/store");
    const store = new ViberSessionStore(db);

    expect(store.detail(session, profile)).toMatchObject({
      session: { repository_id: null, thread: null, selection },
      recovery_required: true,
      messages: [
        { id: message, content: "Retained answer" },
        { id: failed, effects: "possible" },
      ],
    });

    expect(
      db.all<{ configuration: string }>("SELECT configuration FROM viber_sessions")[0]
        .configuration,
    ).toBe(configuration);

    expect(() => store.workspace(session)).toThrow("legacy session");
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    db.close();
    db = await Database.open(path);
    expect(new ViberSessionStore(db).detail(session, profile).session.thread).toBeNull();
  } finally {
    if (old.open) {
      old.close();
    }

    db?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
