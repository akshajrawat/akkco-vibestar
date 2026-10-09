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
  subscription_limits_after: string | null;
  provider_session_id: string | null;
}
export class Usage {
  private readonly steps = new Map<
    string,
    Map<number, Record<string, unknown>>
  >();
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
    const step = object(raw.step_update);
    const stepUsage = object(step.usage);
    let usage = object(raw.usage || result.usage);
    // Official agy stream emits per-step usage and a final aggregate. Keep step
    // updates idempotent; sum only reported fields, then use the final aggregate.
    if (
      raw.event === "step_update" &&
      typeof step.step_index === "number" &&
      Object.keys(stepUsage).length
    ) {
      const steps =
        this.steps.get(id) || new Map<number, Record<string, unknown>>();
      if (steps.size < 10000 || steps.has(step.step_index))
        steps.set(step.step_index, stepUsage);
      this.steps.set(id, steps);
      usage = {};
      for (const value of steps.values())
        for (const [field, count] of Object.entries(value))
          if (
            typeof count === "number" &&
            Number.isSafeInteger(count) &&
            count >= 0
          )
            usage[field] = Number(usage[field] || 0) + count;
    } else if (Object.keys(usage).length) this.steps.delete(id);
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
    after = false,
  ) => {
    if (limits)
      this.db.run(
        `UPDATE ai_usage SET ${after ? "subscription_limits_after" : "subscription_limits"}=? WHERE id=?`,
        JSON.stringify(limits),
        id,
      );
  };
  finish = (
    id: string,
    start: number,
    status: string,
    error: string | null = null,
  ) => {
    this.steps.delete(id);
    return this.db.run(
      "UPDATE ai_usage SET ended_at=?,duration_ms=?,status=?,error=? WHERE id=?",
      now(),
      Date.now() - start,
      status,
      error,
      id,
    );
  };
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
