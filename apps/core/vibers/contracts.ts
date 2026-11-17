import { z } from "zod";

import { AgentProfileSchema } from "../flows/contracts";
import { ConversationSelectionSchema } from "../flows/run-contracts";
import { AgentExecutionSchema } from "../execution/contracts";

const identity = z.string().uuid();

export const ViberSessionScopeSchema = z
  .object({ session_id: identity, profile_id: identity })
  .strict();

export const ViberSessionCreateSchema = z
  .object({
    request_id: identity,
    profile_id: identity,
    selection: ConversationSelectionSchema.optional(),
  })
  .strict();

export const ViberSessionSendSchema = ViberSessionScopeSchema.extend({
  request_id: identity,
  content: z.string().trim().min(1).max(32000),
  history_ids: z
    .array(identity)
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length),
  selection: ConversationSelectionSchema.optional(),
}).strict();

export const ViberSessionSchema = z.object({
  id: identity,
  profile_id: identity,
  title: z.string(),
  selection: ConversationSelectionSchema,
  created_at: z.string(),
  updated_at: z.string(),
});

export const ViberMessageSnapshotSchema = z.object({
  request: ViberSessionSendSchema,
  profile: AgentProfileSchema,
  execution: AgentExecutionSchema,
  prompt: z.string(),
});

export const ViberMessageSchema = z.object({
  id: identity,
  session_id: identity,
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  status: z.enum(["pending", "completed", "failed", "cancelled", "interrupted"]),
  run_id: identity.nullable(),
  created_at: z.string(),
  error: z.string().nullable(),
});

export type ViberSession = z.infer<typeof ViberSessionSchema>;
export type ViberMessage = z.infer<typeof ViberMessageSchema>;

export interface ViberSessionDetail {
  session: ViberSession;
  messages: ViberMessage[];
}
