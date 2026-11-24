import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  ViberTeamSchema,
  ViberTeamSaveSchema,
  ViberHandoffPrepareSchema,
  ViberHandoffExecuteSchema,
  ViberHandoffCancelSchema,
} from "../../apps/core/vibers/teams-contracts";

describe("Viber Teams & Handoff Contracts", () => {
  const p1 = randomUUID();
  const p2 = randomUUID();
  const p3 = randomUUID();
  const teamId = randomUUID();
  const sessionId = randomUUID();
  const requestId = randomUUID();

  it("validates ViberTeamSchema with 2 to 8 unique members", () => {
    const valid = ViberTeamSchema.safeParse({
      id: teamId,
      name: "Core Engineers",
      description: "Handles core systems",
      members: [p1, p2],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    expect(valid.success).toBe(true);

    // Reject less than 2 members
    const tooFew = ViberTeamSchema.safeParse({
      id: teamId,
      name: "Solo",
      members: [p1],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    expect(tooFew.success).toBe(false);

    // Reject more than 8 members
    const tooMany = ViberTeamSchema.safeParse({
      id: teamId,
      name: "Crowd",
      members: Array.from({ length: 9 }, () => randomUUID()),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    expect(tooMany.success).toBe(false);

    // Reject duplicate members
    const duplicates = ViberTeamSchema.safeParse({
      id: teamId,
      name: "Dupes",
      members: [p1, p1],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    expect(duplicates.success).toBe(false);
  });

  it("validates ViberTeamSaveSchema", () => {
    const valid = ViberTeamSaveSchema.safeParse({
      name: "Reviewers",
      member_ids: [p1, p2, p3],
    });

    expect(valid.success).toBe(true);

    // Reject empty name
    const emptyName = ViberTeamSaveSchema.safeParse({
      name: "   ",
      member_ids: [p1, p2],
    });

    expect(emptyName.success).toBe(false);

    // Reject duplicate member IDs
    const duplicateMembers = ViberTeamSaveSchema.safeParse({
      name: "Reviewers",
      member_ids: [p1, p2, p1],
    });

    expect(duplicateMembers.success).toBe(false);
  });

  it("validates ViberHandoffPrepareSchema preventing self-handoff", () => {
    const valid = ViberHandoffPrepareSchema.safeParse({
      team_id: teamId,
      source_session_id: sessionId,
      source_profile_id: p1,
      target_profile_id: p2,
    });

    expect(valid.success).toBe(true);

    // Self-handoff rejected
    const selfHandoff = ViberHandoffPrepareSchema.safeParse({
      team_id: teamId,
      source_session_id: sessionId,
      source_profile_id: p1,
      target_profile_id: p1,
    });

    expect(selfHandoff.success).toBe(false);
  });

  it("validates ViberHandoffExecuteSchema bounds and sanitization", () => {
    const valid = ViberHandoffExecuteSchema.safeParse({
      request_id: requestId,
      team_id: teamId,
      source_session_id: sessionId,
      source_profile_id: p1,
      target_profile_id: p2,
      context_snapshot: "Goal: Fix auth bug\nProgress: Unit tests passing",
      instruction: "Please write integration tests.",
    });

    expect(valid.success).toBe(true);

    // Reject empty context snapshot
    const emptyContext = ViberHandoffExecuteSchema.safeParse({
      request_id: requestId,
      team_id: teamId,
      source_session_id: sessionId,
      source_profile_id: p1,
      target_profile_id: p2,
      context_snapshot: "   ",
      instruction: "Do task",
    });

    expect(emptyContext.success).toBe(false);

    // Reject context snapshot exceeding 16,000 characters
    const hugeContext = ViberHandoffExecuteSchema.safeParse({
      request_id: requestId,
      team_id: teamId,
      source_session_id: sessionId,
      source_profile_id: p1,
      target_profile_id: p2,
      context_snapshot: "a".repeat(16001),
      instruction: "Do task",
    });

    expect(hugeContext.success).toBe(false);

    // Reject self-handoff
    const selfHandoff = ViberHandoffExecuteSchema.safeParse({
      request_id: requestId,
      team_id: teamId,
      source_session_id: sessionId,
      source_profile_id: p1,
      target_profile_id: p1,
      context_snapshot: "Valid context",
      instruction: "Do task",
    });

    expect(selfHandoff.success).toBe(false);
  });

  it("validates ViberHandoffCancelSchema", () => {
    const valid = ViberHandoffCancelSchema.safeParse({ handoff_id: requestId });
    expect(valid.success).toBe(true);

    const invalid = ViberHandoffCancelSchema.safeParse({ handoff_id: "not-a-uuid" });
    expect(invalid.success).toBe(false);
  });
});
