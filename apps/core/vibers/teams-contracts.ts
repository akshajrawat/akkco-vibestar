import { z } from "zod";

const identity = z.string().uuid();

export const ViberTeamMemberSchema = z.object({
  team_id: identity,
  profile_id: identity,
  added_at: z.string(),
});

export type ViberTeamMember = z.infer<typeof ViberTeamMemberSchema>;

export const ViberTeamSchema = z
  .object({
    id: identity,
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).optional(),
    members: z
      .array(identity)
      .min(2, "A team must have at least 2 members.")
      .max(8, "A team can have at most 8 members.")
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Team members must be unique.",
      }),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();

export type ViberTeam = z.infer<typeof ViberTeamSchema>;

export const ViberTeamSaveSchema = z
  .object({
    id: identity.optional(),
    name: z.string().trim().min(1, "Team name is required.").max(100),
    description: z.string().trim().max(500).optional(),
    member_ids: z
      .array(identity)
      .min(2, "A team must have between 2 and 8 members.")
      .max(8, "A team must have between 2 and 8 members.")
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Team members must be unique.",
      }),
  })
  .strict();

export type ViberTeamSaveInput = z.infer<typeof ViberTeamSaveSchema>;

export const ViberTeamDeleteSchema = z
  .object({
    team_id: identity,
  })
  .strict();

export const ViberHandoffPrepareSchema = z
  .object({
    team_id: identity,
    source_session_id: identity,
    source_profile_id: identity,
    target_profile_id: identity,
  })
  .strict()
  .refine((data) => data.source_profile_id !== data.target_profile_id, {
    message: "Cannot hand off to the same Viber profile.",
    path: ["target_profile_id"],
  });

export type ViberHandoffPrepareInput = z.infer<typeof ViberHandoffPrepareSchema>;

export const ViberHandoffExecuteSchema = z
  .object({
    request_id: identity,
    team_id: identity,
    source_session_id: identity,
    source_profile_id: identity,
    target_profile_id: identity,
    context_snapshot: z
      .string()
      .trim()
      .min(1, "Context snapshot is required.")
      .max(16000, "Context snapshot must not exceed 16,000 characters."),
    instruction: z
      .string()
      .trim()
      .min(1, "Handoff instruction is required.")
      .max(16000, "Handoff instruction must not exceed 16,000 characters."),
  })
  .strict()
  .refine((data) => data.source_profile_id !== data.target_profile_id, {
    message: "Cannot hand off to the same Viber profile.",
    path: ["target_profile_id"],
  });

export type ViberHandoffExecuteInput = z.infer<typeof ViberHandoffExecuteSchema>;

export const ViberHandoffCancelSchema = z
  .object({
    handoff_id: identity,
  })
  .strict();

export type ViberHandoffCancelInput = z.infer<typeof ViberHandoffCancelSchema>;

export const ViberTeamHandoffStatusSchema = z.enum([
  "prepared",
  "dispatched",
  "completed",
  "cancelled",
  "failed",
]);

export type ViberTeamHandoffStatus = z.infer<typeof ViberTeamHandoffStatusSchema>;

export const ViberTeamHandoffRecordSchema = z.object({
  id: identity,
  team_id: identity,
  source_profile_id: identity,
  target_profile_id: identity,
  source_session_id: identity,
  target_session_id: identity,
  target_message_id: identity.nullable().optional(),
  context_snapshot: z.string(),
  instruction: z.string(),
  status: ViberTeamHandoffStatusSchema,
  created_at: z.string(),
  updated_at: z.string(),
  error: z.string().nullable().optional(),
});

export type ViberTeamHandoffRecord = z.infer<typeof ViberTeamHandoffRecordSchema>;
