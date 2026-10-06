import { z } from "zod";
import type { NormalizedEvent, StageConfig } from "../../domain";
export interface ProviderDetection {
  provider: string;
  installed: boolean;
  version: string;
  authentication: string;
  models: string[];
  efforts: string[];
  capabilities: string[];
  error: string | null;
}
export interface AgentRunRequest {
  runId: string;
  cwd: string;
  stage: number;
  config: StageConfig;
  prompt: string;
  schemaPath: string;
  schema: Record<string, unknown>;
}
export interface AgentProvider {
  readonly name: string;
  detect: (cwd: string, signal?: AbortSignal) => Promise<ProviderDetection>;
  invocation: (r: AgentRunRequest) => {
    program: string;
    args: string[];
    input?: string;
  };
  normalize: (raw: Record<string, unknown>) => NormalizedEvent[];
  result: (raw: Record<string, unknown>) => unknown;
  conversationId: (raw: Record<string, unknown>) => string | null;
}
const list = z.array(z.string());
export const planSchemas = {
  1: z
    .object({
      summary: z.string(),
      understanding: z.string(),
      relevantFiles: list,
      existingPatterns: list,
      implementationSteps: list,
      tests: list,
      risks: list,
      openQuestions: list,
    })
    .strict(),
  2: z
    .object({
      goal: z.string(),
      scope: z.string(),
      filesToModify: list,
      filesToAdd: list,
      filesToDelete: list,
      implementationSteps: list,
      validationSteps: list,
      riskAnalysis: list,
      explicitNonGoals: list,
    })
    .strict(),
  3: z
    .object({
      summary: z.string(),
      filesChanged: list,
      testsPassed: list,
      testsFailed: list,
      testsSkipped: list,
      remainingRisks: list,
    })
    .strict(),
};
export const schemaFor = (stage: number) => {
  const schema = planSchemas[stage as keyof typeof planSchemas];
  if (!schema) throw new Error("No schema for stage");
  return z.toJSONSchema(schema) as Record<string, unknown>;
};
export const validatePlan = (stage: number, value: unknown) =>
  planSchemas[stage as keyof typeof planSchemas].parse(value);
export const verifyFlags = (help: string, flags: string[]) => {
  for (const flag of flags)
    if (!help.includes(flag))
      throw new Error(
        `Installed CLI lacks ${flag}. Update the official CLI before running.`,
      );
};
export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
