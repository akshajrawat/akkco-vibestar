import { z } from "zod";

import { AdeError } from "../../domain";
import type { AgentExecution } from "../contracts";
import { planSchemas } from "../providers/contracts";

/** Output contracts are independent of workspace access and historical stages. */
export const executionSchema = (execution: AgentExecution, custom?: z.ZodType) => {
  if (execution.output === "custom") {
    if (!custom) throw new AdeError("invalid_state", "Custom output requires an explicit schema.");
    return custom;
  }

  return {
    conversation: z.object({ summary: z.string() }).strict(),
    summary: z.object({ summary: z.string() }).strict(),
    plan: planSchemas[1],
    refinement: planSchemas[2],
    implementation: planSchemas[3],
    review: planSchemas[5],
  }[execution.output];
};
