import { z } from "zod";
import type { Settings } from "../domain";
import type { Database } from "../storage/database";

export interface UtilityRequest {
  purpose: string;
  prompt: string;
  schema?: z.ZodType;
  workspace?: string;
  configuration?: Settings["utility_ai"];
  context?: {
    taskId?: string;
    jobId?: string;
    repository?: string;
    questionId?: string;
  };
}
export class UtilityAI {
  constructor(
    private readonly db: Database,
    private readonly execute: (
      request: UtilityRequest,
      config: Settings["utility_ai"],
    ) => Promise<unknown>,
  ) {}
  run = (request: UtilityRequest) =>
    this.execute(
      {
        ...request,
        schema: request.schema || z.object({ summary: z.string() }).strict(),
      },
      request.configuration || this.db.settings().utility_ai,
    );
}
