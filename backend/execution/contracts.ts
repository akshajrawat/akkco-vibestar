import { z } from "zod";

import { StageConfigSchema } from "../domain";

export const WorkspaceAccessSchema = z.enum(["read-only", "workspace-write"]);

/** Captured per invocation; labels, providers and historical stages grant no authority. */
export const AgentExecutionSchema = StageConfigSchema.extend({
  provider: z.enum(["codex", "antigravity"]),
  access: WorkspaceAccessSchema,
  output: z.enum([
    "conversation",
    "summary",
    "plan",
    "refinement",
    "implementation",
    "review",
    "custom",
  ]),
}).strict();

export type WorkspaceAccess = z.infer<typeof WorkspaceAccessSchema>;
export type AgentExecution = z.infer<typeof AgentExecutionSchema>;
