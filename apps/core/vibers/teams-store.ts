import { randomUUID } from "node:crypto";
import type { Database } from "../storage/database";
import { AdeError, now } from "../domain";
import { redact } from "../execution/runtime/process";
import {
  ViberTeamSchema,
  type ViberTeam,
  type ViberTeamHandoffRecord,
  type ViberTeamHandoffStatus,
  type ViberTeamSaveInput,
} from "./teams-contracts";

interface TeamRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface TeamMemberRow {
  team_id: string;
  profile_id: string;
  added_at: string;
}

export class ViberTeamsStore {
  constructor(private readonly db: Database) {}

  list = (): ViberTeam[] => {
    const teams = this.db.all<TeamRow>(
      "SELECT id, name, description, created_at, updated_at FROM viber_teams ORDER BY created_at ASC",
    );

    if (teams.length === 0) {
      return [];
    }

    const members = this.db.all<TeamMemberRow>(
      `SELECT m.team_id, m.profile_id, m.added_at
       FROM viber_team_members m
       WHERE m.profile_id NOT IN (SELECT profile_id FROM retired_viber_profiles)
       ORDER BY m.rowid ASC`,
    );

    const membersByTeam = new Map<string, string[]>();
    for (const member of members) {
      const list = membersByTeam.get(member.team_id) ?? [];
      list.push(member.profile_id);
      membersByTeam.set(member.team_id, list);
    }

    return teams
      .map((team) => {
        const teamMembers = membersByTeam.get(team.id) ?? [];
        return {
          id: team.id,
          name: team.name,
          description: team.description ?? undefined,
          members: teamMembers,
          created_at: team.created_at,
          updated_at: team.updated_at,
        };
      })
      .filter((team) => team.members.length >= 2);
  };

  get = (id: string): ViberTeam | null => {
    const team = this.db.all<TeamRow>(
      "SELECT id, name, description, created_at, updated_at FROM viber_teams WHERE id=?",
      id,
    )[0];

    if (!team) {
      return null;
    }

    const members = this.db
      .all<{ profile_id: string }>(
        `SELECT profile_id FROM viber_team_members
         WHERE team_id=? AND profile_id NOT IN (SELECT profile_id FROM retired_viber_profiles)
         ORDER BY rowid ASC`,
        id,
      )
      .map((row) => row.profile_id);

    return {
      id: team.id,
      name: team.name,
      description: team.description ?? undefined,
      members,
      created_at: team.created_at,
      updated_at: team.updated_at,
    };
  };

  save = (input: ViberTeamSaveInput): ViberTeam => {
    const id = input.id ?? randomUUID();
    const timestamp = now();

    // Verify all members exist in agent_profiles and are not retired
    const placeholders = input.member_ids.map(() => "?").join(",");

    const activeProfiles = this.db.all<{ id: string }>(
      `SELECT id FROM agent_profiles
       WHERE id IN (${placeholders}) AND id NOT IN (SELECT profile_id FROM retired_viber_profiles)`,
      ...input.member_ids,
    );

    if (activeProfiles.length !== input.member_ids.length) {
      throw new AdeError(
        "invalid_input",
        "All team members must be active, non-retired Viber profiles.",
      );
    }

    return this.db.transaction(() => {
      const existing = this.db.all<TeamRow>("SELECT id FROM viber_teams WHERE id=?", id)[0];

      if (existing) {
        this.db.run(
          "UPDATE viber_teams SET name=?, description=?, updated_at=? WHERE id=?",
          input.name.trim(),
          input.description?.trim() || null,
          timestamp,
          id,
        );
      } else {
        this.db.run(
          "INSERT INTO viber_teams(id, name, description, created_at, updated_at) VALUES(?,?,?,?,?)",
          id,
          input.name.trim(),
          input.description?.trim() || null,
          timestamp,
          timestamp,
        );
      }

      this.db.run("DELETE FROM viber_team_members WHERE team_id=?", id);
      for (const profileId of input.member_ids) {
        this.db.run(
          "INSERT INTO viber_team_members(team_id, profile_id, added_at) VALUES(?,?,?)",
          id,
          profileId,
          timestamp,
        );
      }

      return ViberTeamSchema.parse({
        id,
        name: input.name.trim(),
        description: input.description?.trim() || undefined,
        members: input.member_ids,
        created_at: existing ? (this.get(id)?.created_at ?? timestamp) : timestamp,
        updated_at: timestamp,
      });
    });
  };

  delete = (teamId: string): void => {
    this.db.transaction(() => {
      const existing = this.db.all<TeamRow>("SELECT id FROM viber_teams WHERE id=?", teamId)[0];
      if (!existing) {
        throw new AdeError("not_found", "Team not found.");
      }

      this.db.run("DELETE FROM viber_teams WHERE id=?", teamId);
    });
  };

  prepareContext = (sourceSessionId: string): string => {
    const lastClearRowid =
      this.db.all<{ rowid: number }>(
        "SELECT rowid FROM viber_messages WHERE session_id=? AND role='user' AND content='/clear' AND configuration IS NULL AND status='completed' ORDER BY rowid DESC LIMIT 1",
        sourceSessionId,
      )[0]?.rowid ?? 0;

    const messages = this.db.all<{
      id: string;
      role: "user" | "assistant";
      content: string;
      created_at: string;
    }>(
      `SELECT m.id, m.role, m.content, m.created_at
       FROM viber_messages m
       LEFT JOIN utility_runs r ON r.id = m.run_id
       WHERE m.session_id = ? AND m.rowid > ? AND m.status = 'completed'
         AND (m.role <> 'assistant' OR NOT EXISTS (SELECT 1 FROM viber_memory_private_runs p WHERE p.run_id = m.run_id))
       ORDER BY m.rowid ASC`,
      sourceSessionId,
      lastClearRowid,
    );

    if (messages.length === 0) {
      return "No prior completed exchange in source session.";
    }

    const firstUser = messages.find((m) => m.role === "user");
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    const lastUser = [...messages].reverse().find((m) => m.role === "user");

    const parts: string[] = [];
    if (firstUser) {
      parts.push(`Original Goal: ${redact(firstUser.content).trim()}`);
    }

    if (lastUser && lastUser !== firstUser) {
      parts.push(`Latest Request: ${redact(lastUser.content).trim()}`);
    }

    if (lastAssistant) {
      parts.push(`Current Progress: ${redact(lastAssistant.content).trim()}`);
    }

    let snapshot = parts.join("\n\n");
    if (!snapshot) {
      snapshot = messages
        .slice(-4)
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${redact(m.content).trim()}`)
        .join("\n\n");
    }

    if (snapshot.length > 15000) {
      snapshot = `${snapshot.slice(0, 14950)}... [truncated]`;
    }

    return snapshot;
  };

  getHandoff = (id: string): ViberTeamHandoffRecord | null => {
    const row = this.db.all<ViberTeamHandoffRecord>(
      "SELECT * FROM viber_team_handoffs WHERE id=?",
      id,
    )[0];

    return row ?? null;
  };

  recordHandoff = (record: {
    id: string;
    team_id: string;
    source_profile_id: string;
    target_profile_id: string;
    source_session_id: string;
    target_session_id: string;
    context_snapshot: string;
    instruction: string;
    status: ViberTeamHandoffStatus;
  }): ViberTeamHandoffRecord => {
    const timestamp = now();

    this.db.run(
      `INSERT INTO viber_team_handoffs(
        id, team_id, source_profile_id, target_profile_id,
        source_session_id, target_session_id, context_snapshot,
        instruction, status, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      record.id,
      record.team_id,
      record.source_profile_id,
      record.target_profile_id,
      record.source_session_id,
      record.target_session_id,
      record.context_snapshot,
      record.instruction,
      record.status,
      timestamp,
      timestamp,
    );

    return {
      ...record,
      target_message_id: null,
      created_at: timestamp,
      updated_at: timestamp,
      error: null,
    };
  };

  updateHandoff = (
    id: string,
    updates: {
      status?: ViberTeamHandoffStatus;
      target_message_id?: string | null;
      error?: string | null;
    },
  ): void => {
    const timestamp = now();
    const existing = this.getHandoff(id);
    if (!existing) {
      return;
    }

    const nextStatus = updates.status ?? existing.status;

    const nextMessageId =
      updates.target_message_id !== undefined
        ? updates.target_message_id
        : existing.target_message_id;

    const nextError = updates.error !== undefined ? updates.error : existing.error;

    this.db.run(
      "UPDATE viber_team_handoffs SET status=?, target_message_id=?, error=?, updated_at=? WHERE id=?",
      nextStatus,
      nextMessageId,
      nextError,
      timestamp,
      id,
    );
  };
}
