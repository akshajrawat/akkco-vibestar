import { z } from "zod";

import type { NormalizedEvent, StageConfig } from "../../domain";
import type { ProcessInputProtocol } from "../runtime/process";
import type { WorkspaceAccess } from "../contracts";

export const VerificationCheckSchema = z
  .object({
    name: z.string().min(1).max(1000),
    command: z.string().max(16000).nullable(),
    kind: z.enum(["check", "setup"]),
    outcome: z.enum(["passed", "failed", "blocked", "interrupted", "not_run", "unknown"]),
    required: z.boolean(),
    detail: z.string().max(16000),
    prerequisite: z.string().max(1000).nullable(),
    scope: z.enum(["repository", "issue", "manual", "discovery"]).optional(),
  })
  .strict();

export interface ProviderDetection {
  provider: string;
  installed: boolean;
  version: string;
  connected: boolean;
  accountLabel?: string;
  subscriptionLimits?: {
    reportedAt: string;
    planType?: string;
    windows: {
      usedPercent: number;
      windowDurationMins: number;
      resetsAt: number;
    }[];
  };
  models: {
    id: string;
    label?: string;
    supportedEfforts: string[];
    isDefault?: boolean;
  }[];
  efforts: string[];
  capabilities: string[];
  error: string | null;
}

export const supportedEfforts = (d: ProviderDetection | undefined, model: string) =>
  (model ? d?.models.find((m) => m.id === model) : d?.models.find((m) => m.isDefault))
    ?.supportedEfforts ||
  (!model ? d?.efforts : []) ||
  [];

export const configurationError = (d: ProviderDetection, config: StageConfig) => {
  if (config.model && !d.models.some((m) => m.id === config.model)) {
    return `${d.provider} model '${config.model}' is not available from the official CLI. Refresh model discovery.`;
  }

  const efforts = supportedEfforts(d, config.model);
  if (!efforts.includes(config.effort)) {
    return `${d.provider} model '${config.model || "CLI default"}' does not support '${config.effort}' effort. Supported: ${efforts.join(", ") || "capabilities unavailable"}.`;
  }

  return null;
};

export interface AgentRunRequest {
  runId: string;
  cwd: string;
  stage: number;
  access: WorkspaceAccess;
  config: StageConfig;
  prompt: string;
  schemaPath: string;
  schema: Record<string, unknown>;
  workspaceType?: "task" | "utility";
  conversation?: { threadId?: string };
}

export interface AgentProvider {
  readonly name: string;
  detect: (cwd: string, signal?: AbortSignal) => Promise<ProviderDetection>;
  invocation: (r: AgentRunRequest) => {
    program: string;
    args: string[];
    input?: string;
    inputProtocol?: ProcessInputProtocol;
    isolateProviderConfig?: boolean;
  };
  normalize: (raw: Record<string, unknown>) => NormalizedEvent[];
  result: (raw: Record<string, unknown>, conversation?: boolean) => unknown;
  conversationId: (raw: Record<string, unknown>) => string | null;
  outputSchema?: (schema: Record<string, unknown>) => Record<string, unknown>;
  parseStructuredOutput?: (schema: Record<string, unknown>, value: unknown) => unknown;
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
      verification: z.array(VerificationCheckSchema).max(200).optional(),
    })
    .strict(),
  5: z
    .object({
      approval: z.enum(["approved", "changes_requested", "blocked"]),
      summary: z.string(),
      findings: list,
      testsRun: list,
      testsNotRun: list,
      verification: z.array(VerificationCheckSchema).max(200).optional(),
      environmentLimitations: list.optional(),
      implementationConcerns: list.optional(),
      recommendedNextActions: list.optional(),
      issues: z
        .array(
          z
            .object({
              severity: z.enum(["critical", "high", "medium", "low"]),
              file: z.string().nullable(),
              summary: z.string(),
              evidence: z.string(),
            })
            .strict(),
        )
        .max(100)
        .optional(),
    })
    .strict(),
};

export const verifyFlags = (help: string, flags: string[]) => {
  for (const flag of flags) {
    if (!help.includes(flag)) {
      throw new Error(`Installed CLI lacks ${flag}. Update the official CLI before running.`);
    }
  }
};

export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
