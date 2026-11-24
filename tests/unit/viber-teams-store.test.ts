import { describe, expect, it, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Database } from "../../apps/core/storage/database";
import { ViberTeamsStore } from "../../apps/core/vibers/teams-store";
import { now } from "../../apps/core/domain";

describe("ViberTeamsStore", () => {
  let db: Database;
  let store: ViberTeamsStore;
  let p1: string;
  let p2: string;
  let p3: string;

  beforeEach(async () => {
    db = await Database.open(":memory:");
    store = new ViberTeamsStore(db);

    p1 = randomUUID();
    p2 = randomUUID();
    p3 = randomUUID();

    // Setup active profiles in agent_profiles and agent_profile_revisions
    db.transaction(() => {
      for (const id of [p1, p2, p3]) {
        const timestamp = now();

        const profileData = JSON.stringify({
          id,
          revision: 1,
          name: `Viber-${id.slice(0, 4)}`,
          instructions: "Work on tasks.",
          supported_access: ["workspace-write"],
          execution: {
            provider: "codex",
            model: "gpt-6.2-sol",
            effort: "high",
            timeout_secs: 1800,
            access: "workspace-write",
            output: "conversation",
          },
        });

        db.run(
          "INSERT INTO agent_profiles(id, current_revision, created_at, updated_at) VALUES(?,1,?,?)",
          id,
          timestamp,
          timestamp,
        );

        db.run(
          "INSERT INTO agent_profile_revisions(profile_id, revision, data, created_at) VALUES(?,1,?,?)",
          id,
          profileData,
          timestamp,
        );
      }
    });
  });

  it("creates, retrieves, updates, and deletes teams", () => {
    const team = store.save({
      name: "Engineering Core",
      description: "Frontend and backend engineers",
      member_ids: [p1, p2],
    });

    expect(team.name).toBe("Engineering Core");
    expect(team.description).toBe("Frontend and backend engineers");
    expect(team.members).toEqual([p1, p2]);

    const retrieved = store.get(team.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(team.id);
    expect(retrieved?.members).toEqual([p1, p2]);

    // Update team
    const updated = store.save({
      id: team.id,
      name: "Engineering Core V2",
      description: "Updated description",
      member_ids: [p1, p2, p3],
    });

    expect(updated.name).toBe("Engineering Core V2");
    expect(updated.members).toEqual([p1, p2, p3]);

    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(team.id);

    // Delete team
    store.delete(team.id);
    expect(store.get(team.id)).toBeNull();
    expect(store.list()).toHaveLength(0);
  });

  it("rejects saving team with non-existent or retired profiles", () => {
    const nonExistentId = randomUUID();

    expect(() =>
      store.save({
        name: "Invalid Team",
        member_ids: [p1, nonExistentId],
      }),
    ).toThrow("All team members must be active, non-retired Viber profiles.");

    // Retiring p2
    db.run("INSERT INTO retired_viber_profiles(profile_id) VALUES(?)", p2);

    expect(() =>
      store.save({
        name: "Retired Team",
        member_ids: [p1, p2],
      }),
    ).toThrow("All team members must be active, non-retired Viber profiles.");
  });

  it("excludes retired profiles from existing team memberships and lists", () => {
    const team = store.save({
      name: "Trio Team",
      member_ids: [p1, p2, p3],
    });

    expect(store.get(team.id)?.members).toEqual([p1, p2, p3]);

    // Retire p3
    db.run("INSERT INTO retired_viber_profiles(profile_id) VALUES(?)", p3);
    db.run("DELETE FROM viber_team_members WHERE profile_id=?", p3);

    expect(store.get(team.id)?.members).toEqual([p1, p2]);

    // Retire p2 -> team only has 1 active member left, list() filters out < 2 members
    db.run("INSERT INTO retired_viber_profiles(profile_id) VALUES(?)", p2);
    db.run("DELETE FROM viber_team_members WHERE profile_id=?", p2);

    expect(store.get(team.id)?.members).toEqual([p1]);
    expect(store.list()).toHaveLength(0);
  });

  it("prepares context while strictly omitting private memory runs and redacting content", () => {
    const sessionId = randomUUID();
    const timestamp = now();

    // Create session in SQLite
    db.run(
      "INSERT INTO viber_sessions(id, profile_id, title, selection, configuration, created_at, updated_at) VALUES(?,?,?, '{}', '{}', ?, ?)",
      sessionId,
      p1,
      "Test Session",
      timestamp,
      timestamp,
    );

    // Normal user message
    db.run(
      "INSERT INTO viber_messages(id, session_id, role, content, status, created_at) VALUES(?,?, 'user', 'Build authentication flow with JWT tokens', 'completed', ?)",
      randomUUID(),
      sessionId,
      timestamp,
    );

    // Assistant message associated with a private memory run
    const privateRunId = randomUUID();

    db.run(
      "INSERT INTO utility_runs(id, stage, provider, model, effort, prompt, status, started_at, purpose) VALUES(?, 1, 'codex', 'gpt-6.2-sol', 'high', 'prompt', 'completed', ?, 'memory-extraction')",
      privateRunId,
      timestamp,
    );

    db.run("INSERT INTO viber_memory_private_runs(run_id) VALUES(?)", privateRunId);

    db.run(
      "INSERT INTO viber_messages(id, session_id, role, content, status, run_id, created_at) VALUES(?,?, 'assistant', 'Private memory internal inference text: User secret password', 'completed', ?, ?)",
      randomUUID(),
      sessionId,
      privateRunId,
      timestamp,
    );

    // Normal assistant message
    db.run(
      "INSERT INTO viber_messages(id, session_id, role, content, status, created_at) VALUES(?,?, 'assistant', 'Implemented JWT token verification and user route protection.', 'completed', ?)",
      randomUUID(),
      sessionId,
      timestamp,
    );

    const context = store.prepareContext(sessionId);

    // Context should contain normal user and assistant messages
    expect(context).toContain("Build authentication flow with JWT tokens");
    expect(context).toContain("Implemented JWT token verification and user route protection.");

    // Context must NOT contain the private memory text
    expect(context).not.toContain("Private memory internal inference text");
  });

  it("records and updates handoff records", () => {
    const handoffId = randomUUID();
    const teamId = randomUUID();
    const sourceSessionId = randomUUID();
    const targetSessionId = randomUUID();
    const timestamp = now();

    db.run(
      "INSERT INTO viber_sessions(id, profile_id, title, selection, configuration, created_at, updated_at) VALUES(?,?,?, '{}', '{}', ?, ?)",
      sourceSessionId,
      p1,
      "Source Session",
      timestamp,
      timestamp,
    );

    db.run(
      "INSERT INTO viber_sessions(id, profile_id, title, selection, configuration, created_at, updated_at) VALUES(?,?,?, '{}', '{}', ?, ?)",
      targetSessionId,
      p2,
      "Target Session",
      timestamp,
      timestamp,
    );

    store.save({
      id: teamId,
      name: "Pair",
      member_ids: [p1, p2],
    });

    const record = store.recordHandoff({
      id: handoffId,
      team_id: teamId,
      source_profile_id: p1,
      target_profile_id: p2,
      source_session_id: sourceSessionId,
      target_session_id: targetSessionId,
      context_snapshot: "Snapshot text",
      instruction: "Review PR",
      status: "dispatched",
    });

    expect(record.status).toBe("dispatched");
    expect(store.getHandoff(handoffId)?.status).toBe("dispatched");

    // Update status to completed
    const messageId = randomUUID();

    db.run(
      "INSERT INTO viber_messages(id, session_id, role, content, status, created_at) VALUES(?,?, 'user', 'Handoff task', 'completed', ?)",
      messageId,
      targetSessionId,
      timestamp,
    );

    store.updateHandoff(handoffId, {
      status: "completed",
      target_message_id: messageId,
    });

    const updated = store.getHandoff(handoffId);
    expect(updated?.status).toBe("completed");
    expect(updated?.target_message_id).toBe(messageId);
  });
});
