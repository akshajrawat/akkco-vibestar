import { now } from "../domain";
import type { Database } from "../storage/database";
import { object, type ProviderDetection } from "./providers/contracts";

export interface UsageRecord {
  id: string;
  task_id: string | null;
  job_id: string | null;
  repository: string | null;
  purpose: string;
  provider: string;
  model: string;
  effort: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  status: string;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  error: string | null;
  subscription_limits: string | null;
}
export class Usage {
  constructor(private readonly db: Database) {}
  start = (
    id: string,
    value: Pick<
      UsageRecord,
      | "task_id"
      | "job_id"
      | "repository"
      | "purpose"
      | "provider"
      | "model"
      | "effort"
    >,
  ) =>
    this.db.run(
      "INSERT INTO ai_usage(id,task_id,job_id,repository,purpose,provider,model,effort,started_at,status) VALUES(?,?,?,?,?,?,?,?,?,'running')",
      id,
      value.task_id,
      value.job_id,
      value.repository,
      value.purpose,
      value.provider,
      value.model,
      value.effort,
      now(),
    );
  observe = (id: string, raw: Record<string, unknown>) => {
    const result = object(raw.result);
    const usage = object(raw.usage || result.usage);
    const details = object(usage.output_tokens_details);
    const input = object(usage.input_tokens_details);
    const values = {
      input_tokens: usage.input_tokens,
      cached_input_tokens:
        usage.cached_input_tokens ??
        usage.cache_read_tokens ??
        input.cached_tokens,
      output_tokens: usage.output_tokens,
      reasoning_tokens:
        usage.reasoning_tokens ??
        usage.reasoning_output_tokens ??
        usage.thinking_tokens ??
        details.reasoning_tokens,
      total_tokens: usage.total_tokens,
    };
    for (const [key, value] of Object.entries(values))
      if (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
      )
        this.db.run(`UPDATE ai_usage SET ${key}=? WHERE id=?`, value, id);
    const model = object(raw.init).model || raw.model;
    if (typeof model === "string" && model)
      this.db.run(
        "UPDATE ai_usage SET model=? WHERE id=? AND model=''",
        model,
        id,
      );
  };
  recordLimits = (
    id: string,
    limits: ProviderDetection["subscriptionLimits"],
  ) => {
    if (limits)
      this.db.run(
        "UPDATE ai_usage SET subscription_limits=? WHERE id=?",
        JSON.stringify(limits),
        id,
      );
  };
  finish = (
    id: string,
    start: number,
    status: string,
    error: string | null = null,
  ) =>
    this.db.run(
      "UPDATE ai_usage SET ended_at=?,duration_ms=?,status=?,error=? WHERE id=?",
      now(),
      Date.now() - start,
      status,
      error,
      id,
    );
  list = (taskId?: string, days?: number) =>
    this.db.all<UsageRecord>(
      `SELECT * FROM ai_usage WHERE (? IS NULL OR task_id=?) AND (? IS NULL OR started_at>=?) ORDER BY started_at DESC`,
      taskId || null,
      taskId || null,
      days || null,
      days
        ? new Date(
            days === 1
              ? new Date().setUTCHours(0, 0, 0, 0)
              : Date.now() - days * 86400000,
          ).toISOString()
        : null,
    );
}
