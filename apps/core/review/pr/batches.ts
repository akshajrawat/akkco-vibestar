import { z } from "zod";

import { createHash, randomUUID } from "node:crypto";

import { AdeError, FollowupConfigSchema, now } from "../../domain";
import type { Engine } from "../../execution/engine";
import type { Scheduler } from "../../scheduled/scheduler";

export const BatchSelectionSchema = z
  .object({
    job_ids: z.array(z.string().uuid()).min(1),
    scope: z.enum(["open", "attention", "stale", "selected"]),
  })
  .strict();

export const StartPRBatchSchema = BatchSelectionSchema.extend({
  request_id: z.string().uuid(),
  max_analyses: z.number().int().min(0),
  configuration: FollowupConfigSchema,
  confirmed: z.literal(true),
})
  .strict()
  .refine(
    (input) => input.max_analyses <= input.job_ids.length,
    "Authorize at most one analysis per selected PR.",
  );

const BatchSchema = z
  .object({
    id: z.string().uuid(),
    digest: z.string(),
    scope: BatchSelectionSchema.shape.scope,
    configuration: FollowupConfigSchema,
    max_analyses: z.number().int().min(0),
    analyses_used: z.number().int().min(0),
    status: z.enum(["running", "cancelling", "completed", "cancelled", "interrupted"]),
    created_at: z.string(),
    ended_at: z.string().nullable(),
    items: z.array(
      z
        .object({
          job_id: z.string().uuid(),
          analysis_id: z.string().uuid(),
          status: z.enum([
            "pending",
            "running",
            "completed",
            "partial",
            "failed",
            "cancelled",
            "interrupted",
          ]),
          error: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export type PRBatch = z.infer<typeof BatchSchema>;

export class PRAnalysisBatches {
  private previews = new Map<AbortController, Promise<unknown>>();

  private active = new Map<
    string,
    { promise: Promise<void>; cancelled: boolean; jobId?: string; batch: PRBatch }
  >();

  constructor(
    private readonly engine: Engine,
    private readonly scheduler: Scheduler,
  ) {
    for (const batch of this.list().filter((batch) =>
      ["running", "cancelling"].includes(batch.status),
    )) {
      batch.status = "interrupted";
      batch.ended_at = now();
      for (const item of batch.items)
        if (["pending", "running"].includes(item.status)) item.status = "interrupted";
      this.save(batch);
    }
  }

  list = () =>
    this.engine.db.records.list(
      "pr_analysis_batches",
      this.engine.db.all<{ id: string; data: string }>(
        "SELECT id,data FROM pr_analysis_batches ORDER BY created_at DESC LIMIT 50",
      ),
      BatchSchema.parse,
      "id",
    );

  private save = (batch: PRBatch) => {
    this.engine.db.run(
      "INSERT INTO pr_analysis_batches VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data",
      batch.id,
      batch.status,
      JSON.stringify(batch),
      batch.created_at,
    );

    this.engine.changed();
  };

  private validateSelection = (ids: string[]) => {
    if (new Set(ids).size !== ids.length)
      throw new AdeError("invalid_input", "Select each PR once.");
    const jobs = this.scheduler.jobs();
    if (ids.some((id) => !jobs.some((job) => job.id === id)))
      throw new AdeError("not_found", "A selected PR is no longer available.");
  };

  /** Inspects report reuse with bounded GitHub reads and no inference authorization. */
  preview = (input: z.input<typeof BatchSelectionSchema>) => {
    this.engine.assertAvailable();
    const p = BatchSelectionSchema.parse(input);
    this.validateSelection(p.job_ids);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]);

    const promise = Promise.resolve().then(async () => {
      let reusable = 0;
      for (const id of p.job_ids) if (await this.scheduler.inspectForBatch(id, signal)) reusable++;
      signal.throwIfAborted();
      return { selected: p.job_ids.length, reusable, checked_at: now() };
    });

    const release = this.engine.trackActivity(
      {
        id: `pr-batch-preview:${randomUUID()}`,
        kind: "pr_watch",
        label: "Inspecting PR batch reuse · GitHub only",
        stoppable: true,
      },
      async () => {
        controller.abort();
        await promise.catch(() => {});
      },
    );

    const settled = promise.finally(() => {
      this.previews.delete(controller);
      release();
    });

    this.previews.set(controller, settled);
    return settled;
  };

  /** Journals a manual batch and charges its durable cap immediately before semantic analysis. */
  start = (input: z.input<typeof StartPRBatchSchema>) => {
    this.engine.assertAvailable();
    const p = StartPRBatchSchema.parse(input);
    this.validateSelection(p.job_ids);
    const digest = createHash("sha256").update(JSON.stringify(p)).digest("hex");

    const existing = this.engine.db.all<{ data: string }>(
      "SELECT data FROM pr_analysis_batches WHERE id=?",
      p.request_id,
    )[0];

    if (existing) {
      const batch = BatchSchema.parse(JSON.parse(existing.data));
      if (batch.digest !== digest)
        throw new AdeError(
          "invalid_input",
          "This batch request belongs to a different selection or allowance.",
        );
      return batch;
    }

    if (this.active.size)
      throw new AdeError("busy", "Another PR batch is already running. Cancel or finish it first.");

    const batch: PRBatch = {
      id: p.request_id,
      digest,
      scope: p.scope,
      configuration: p.configuration,
      max_analyses: p.max_analyses,
      analyses_used: 0,
      status: "running",
      created_at: now(),
      ended_at: null,
      items: p.job_ids.map((job_id) => ({
        job_id,
        analysis_id: randomUUID(),
        status: "pending",
        error: null,
      })),
    };

    this.save(batch);

    const operation = {
      promise: Promise.resolve(),
      cancelled: false,
      jobId: undefined as string | undefined,
      batch,
    };

    const release = this.engine.trackActivity(
      {
        id: `pr-batch:${batch.id}`,
        kind: "pr_watch",
        label: `PR batch · ${batch.items.length} selected`,
        stoppable: true,
      },
      () => this.cancel(batch.id),
    );

    operation.promise = Promise.resolve().then(async () => {
      try {
        for (const item of batch.items) {
          if (operation.cancelled) break;
          item.status = "running";
          operation.jobId = item.job_id;
          this.save(batch);
          try {
            const session = await this.scheduler.analyzeBatchItem(item.job_id, item.analysis_id, {
              configuration: {
                ...batch.configuration.config,
                provider: batch.configuration.provider,
              },
              authorizeInference: () => {
                if (operation.cancelled)
                  throw new AdeError("cancelled", "Batch cancelled before inference.");
                if (batch.analyses_used >= batch.max_analyses)
                  throw new AdeError(
                    "analysis_cap",
                    "The authorized AI analysis cap is reached. Current GitHub evidence is retained; authorize another analysis explicitly.",
                  );
                batch.analyses_used++;
                this.save(batch);
              },
            });

            item.status = session?.status === "running" || !session ? "failed" : session.status;
            item.error = session?.error || null;
          } catch (error) {
            item.status = "failed";
            item.error = error instanceof Error ? error.message : String(error);
          }

          this.save(batch);
        }

        batch.status = operation.cancelled ? "cancelled" : "completed";
        for (const item of batch.items) if (item.status === "pending") item.status = "cancelled";
      } finally {
        batch.ended_at = now();
        this.save(batch);
        this.active.delete(batch.id);
        release();
      }
    });

    this.active.set(batch.id, operation);
    return batch;
  };

  cancel = async (id: string) => {
    const operation = this.active.get(id);
    if (!operation) return;
    if (operation.cancelled) return operation.promise;
    operation.cancelled = true;
    operation.batch.status = "cancelling";
    this.save(operation.batch);
    if (operation.jobId) await this.scheduler.cancel(operation.jobId);
    await operation.promise;
  };

  close = async () => {
    for (const controller of this.previews.keys()) controller.abort();
    await Promise.allSettled(this.previews.values());
    for (const id of this.active.keys()) await this.cancel(id);
  };
}
