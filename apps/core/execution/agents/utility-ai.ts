import { z } from "zod";

import type { AgentConfiguration } from "../../domain";

export interface UtilityRequest {
  purpose: string;
  prompt: string;
  schema?: z.ZodType;
  workspace?: string;
  configuration: AgentConfiguration;
  signal?: AbortSignal;
  context?: {
    taskId?: string;
    jobId?: string;
    repository?: string;
    questionId?: string;
    analysisId?: string;
    watchId?: string;
    scanId?: string;
  };
}

export class UtilityAI {
  constructor(
    private readonly execute: (
      request: UtilityRequest,
      config: AgentConfiguration,
    ) => Promise<unknown>,
  ) {}

  run = (request: UtilityRequest) =>
    this.execute(
      {
        ...request,
        schema: request.schema || z.object({ summary: z.string() }).strict(),
      },
      request.configuration,
    );
}
