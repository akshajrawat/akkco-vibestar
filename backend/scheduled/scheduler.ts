import { ActionSchema } from "./action";
import { z } from "zod";
import type { GitHubPullRequest } from "../github/contracts";
import { randomUUID } from "node:crypto";
import { now, AdeError, type Settings } from "../domain";
import type { Engine } from "../execution/engine";
import { redact } from "../execution/runtime/process";
import { PRAnalysis } from "../review/pr/analysis";
import type { PRAnalysisSession } from "../review/pr/contracts";
import { GitHubMonitor } from "./github";
import {
  ScheduleInput,
  parsePullRequest,
  type ScheduleJob,
  type ScheduleAttention,
  PullRequestStateSchema,
} from "./contracts";
const savedJob = z
  .object({
    id: z.string(),
    url: z.string().optional(),
    status: z.string().optional(),
    action: ActionSchema.optional(),
    conversation_action: ActionSchema.optional(),
    title: z.string().optional(),
    task_id: z.string().nullable().optional(),
    last_snapshot: PullRequestStateSchema.nullable().optional(),
    pending_snapshot: PullRequestStateSchema.nullable().optional(),
    changes: z.array(z.string()).optional(),
    error: z.string().nullable().optional(),
    last_checked_at: z.string().nullable().optional(),
    next_run_at: z.string().optional(),
    last_analyzed_at: z.string().optional(),
    archived: z.boolean().optional(),
    paused_before_archive: z.boolean().optional(),
  })
  .loose()
  .transform((value) => ({ ...value, enabled: false, check_once: false }) as ScheduleJob);

// Legacy tracked records remain readable; only explicit operations execute.
export class Scheduler {
  private readonly active = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private stopped = false;
  readonly analysis: PRAnalysis;
  constructor(
    private readonly engine: Engine,
    private readonly monitor = new GitHubMonitor(engine.root),
  ) {
    this.analysis = new PRAnalysis(engine);
  }
  jobs = () =>
    this.engine.db.records.list(
      "scheduled_jobs",
      this.engine.db.all<{ id: string; data: string }>(
        "SELECT id,data FROM scheduled_jobs ORDER BY rowid",
      ),
      savedJob.parse,
      "id",
    );
  attention = () =>
    this.engine.db.all<ScheduleAttention>(
      "SELECT * FROM scheduled_attention WHERE dismissed=0 ORDER BY created_at DESC",
    );
  private save = (job: ScheduleJob) => {
    if (job.task_id && !this.engine.db.all("SELECT id FROM tasks WHERE id=?", job.task_id).length)
      job.task_id = null;
    this.engine.db.run(
      "INSERT INTO scheduled_jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      job.id,
      JSON.stringify({ ...job, enabled: false, check_once: false }),
    );
    this.engine.changed();
  };
  private job = (id: string) => {
    const row = this.engine.db.all<{ data: string }>(
      "SELECT data FROM scheduled_jobs WHERE id=?",
      id,
    )[0];
    if (!row) throw new AdeError("not_found", "Tracked PR not found");
    return this.engine.db.records.decode(
      {
        table: "scheduled_jobs",
        id,
        column: "data",
        source: row.data,
        identity: "id",
      },
      savedJob.parse,
    );
  };
  add = (input: unknown) => {
    this.engine.assertAvailable();
    const p = ScheduleInput.parse(input);
    const ref = parsePullRequest(p.url);
    const existing = this.jobs().find((j) => j.url === ref.url);
    if (existing) return existing;
    if (p.task_id) {
      const repo = this.engine.db.repository(this.engine.db.task(p.task_id).repo_id);
      if (`${repo.owner}/${repo.name}`.toLowerCase() !== `${ref.owner}/${ref.repo}`.toLowerCase())
        throw new AdeError(
          "invalid_input",
          "PR and linked task must belong to the same upstream repository",
        );
    }
    const job: ScheduleJob = {
      ...p,
      verify_codex: false,
      url: ref.url,
      id: randomUUID(),
      enabled: false,
      next_run_at: now(),
      status: "idle",
      last_checked_at: null,
      last_snapshot: null,
      pending_snapshot: null,
      changes: [],
      error: null,
    };
    this.save(job);
    return job;
  };
  discovered = (pr: GitHubPullRequest) => {
    const job =
      this.jobs().find((j) => j.url.toLowerCase() === pr.url.toLowerCase()) ||
      this.add({
        url: pr.url,
        task_id: pr.task_id,
        interval_minutes: 60,
        verify_codex: false,
      });
    if (this.active.has(job.id)) return;
    job.title = pr.title;
    if (["OPEN", "CLOSED", "MERGED"].includes(pr.state)) job.archived = pr.state !== "OPEN";
    if (!job.task_id && pr.task_id) job.task_id = pr.task_id;
    this.save(job);
  };
  setEnabled = (id: string, enabled: boolean) => {
    if (enabled)
      throw new AdeError(
        "manual_policy",
        "Automatic PR inspection is disabled. Use Analyze PR explicitly.",
      );
    this.save(this.job(id));
  };
  dismiss = (id: string) => {
    this.engine.db.run("UPDATE scheduled_attention SET dismissed=1 WHERE id=?", id);
    this.engine.changed();
  };
  fix = () => {
    throw new AdeError(
      "repair_unavailable",
      "Legacy scheduled.fix is unsupported. Use Solve Review with an explicitly selected analysis, observations and repository.",
    );
  };
  start = () => {
    for (const job of this.jobs()) {
      if (["polling", "pending", "analyzing"].includes(job.status)) {
        job.status = "interrupted";
        job.error = "PR inspection was interrupted. Request analysis explicitly to continue.";
      }
      this.save(job);
    }
  };
  // Older callers cannot restore timers or execute imported enabled records.
  tick = async () => {};
  runNow = (id: string) => this.launch(id, randomUUID(), false);
  analyze = (
    id: string,
    requestId: string = randomUUID(),
    options?: {
      configuration: Settings["utility_ai"];
      authorizeInference: () => void;
    },
  ) => this.launch(id, requestId, true, options);
  inspectForBatch = async (id: string, signal: AbortSignal) => {
    const snapshot = await this.monitor.inspect(this.job(id).url, signal);
    return this.analysis.canReuse(id, snapshot);
  };
  analyzeBatchItem = async (
    id: string,
    requestId: string,
    options: {
      configuration: Settings["utility_ai"];
      authorizeInference: () => void;
    },
  ) => {
    this.analyze(id, requestId, options);
    await this.active.get(id)?.promise;
    return this.analysis.history(id).find((session) => session.id === requestId);
  };
  cancel = async (id: string) => {
    const active = this.active.get(id);
    active?.controller.abort();
    await active?.promise;
  };
  private launch = (
    id: string,
    requestId: string,
    semantic: boolean,
    options?: {
      configuration: Settings["utility_ai"];
      authorizeInference: () => void;
    },
  ) => {
    this.engine.assertAvailable();
    const duplicate = this.engine.db.all<{ job_id: string }>(
      "SELECT job_id FROM pr_analyses WHERE id=?",
      requestId,
    )[0];
    if (duplicate) {
      if (duplicate.job_id !== id)
        throw new AdeError("isolation", "Analysis request belongs to a different PR");
      return { analysis_id: requestId };
    }
    if (this.stopped || this.active.has(id))
      throw new AdeError("busy", "PR inspection already running or the core is stopping");
    const job = this.job(id);
    const controller = new AbortController();
    const session: PRAnalysisSession = {
      id: requestId,
      job_id: id,
      status: "running",
      started_at: now(),
      ended_at: null,
      phase: "Fetching complete GitHub context",
      configuration: structuredClone(
        options?.configuration || this.engine.db.settings().utility_ai,
      ),
    };
    let release = () => {};
    release = this.engine.trackActivity(
      {
        id: `pr-watch:${id}`,
        kind: "pr_watch",
        task_id: job.task_id || undefined,
        label: `Explicit PR inspection ${job.url}`,
        stoppable: true,
      },
      () => this.cancel(id),
    );
    const promise = Promise.resolve()
      .then(async () => {
        try {
          controller.signal.throwIfAborted();
          job.status = "polling";
          job.error = null;
          this.save(job);
          this.analysis.save(session);
          const snapshot = await this.monitor.inspect(job.url, controller.signal);
          controller.signal.throwIfAborted();
          session.snapshot = snapshot;
          job.title = snapshot.title;
          job.last_checked_at = now();
          job.pending_snapshot = snapshot;
          if (semantic) {
            job.status = "analyzing";
            this.save(job);
            await this.analysis.analyze(
              session,
              snapshot,
              job.url,
              controller.signal,
              options?.authorizeInference,
            );
            job.last_analyzed_at = session.ended_at || now();
          } else {
            session.method = "deterministic";
            session.phase = "GitHub inspection only · No AI usage";
            session.status = snapshot.coverage?.complete ? "completed" : "partial";
            session.ended_at = now();
            this.analysis.save(session);
          }
          controller.signal.throwIfAborted();
          job.last_snapshot = snapshot;
          job.pending_snapshot = null;
          job.status = "idle";
          job.archived = snapshot.state !== "OPEN";
          job.analysis_method = session.method === "utility_ai" ? "utility_ai" : "deterministic";
          if (session.report) {
            const outstanding = session.report.actions.filter(
              (a) =>
                !["positive_feedback", "informational"].includes(a.classification) &&
                a.responseState !== "answered" &&
                !a.reviewerAcknowledgmentIds.length,
            );
            job.action = ActionSchema.parse({
              manualActionRequired:
                !session.report.complete ||
                (snapshot.reviewDecision === "CHANGES_REQUESTED" &&
                  !session.report.actions.length) ||
                outstanding.length > 0 ||
                snapshot.checks.some((c) =>
                  ["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED"].includes(c.state),
                ) ||
                snapshot.mergeable === "CONFLICTING",
              conversationState:
                snapshot.state === "MERGED"
                  ? "merged"
                  : snapshot.state === "CLOSED"
                    ? "closed"
                    : outstanding.length
                      ? "waiting_for_me"
                      : "neutral",
              severity: outstanding.length ? "action_required" : "info",
              summary: session.report.summary,
              reason: session.report.complete
                ? "Source-linked review observations; code remains unverified."
                : "Partial coverage; inspect warnings.",
              outstandingRequests: outstanding.map((a) => ({
                author: a.reviewer,
                request: a.originalText,
                sourceId: a.sourceId,
              })),
              alreadyAddressed: [],
              recommendedNextAction:
                "Inspect observations, unanswered questions and check evidence.",
              affectedFiles: [...new Set(outstanding.flatMap((a) => a.affectedFiles))],
              newActivity: session.changes || [],
            });
            job.changes = session.changes || [];
            this.engine.db.run("UPDATE scheduled_attention SET dismissed=1 WHERE job_id=?", id);
            if (job.action.manualActionRequired)
              this.engine.db.run(
                "INSERT INTO scheduled_attention(id,job_id,task_id,created_at,summary,changes,analysis) VALUES(?,?,?,?,?,?,?)",
                randomUUID(),
                id,
                job.task_id,
                now(),
                session.report.summary,
                JSON.stringify(job.changes),
                JSON.stringify(session.report),
              );
          }
        } catch (error) {
          session.status =
            error instanceof AdeError && error.kind === "analysis_cap"
              ? "partial"
              : controller.signal.aborted
                ? this.stopped
                  ? "interrupted"
                  : "cancelled"
                : "failed";
          session.error = redact(error instanceof Error ? error.message : String(error));
          session.phase = controller.signal.aborted
            ? this.stopped
              ? "Analysis interrupted — explicit retry required"
              : "Analysis cancelled — no automatic retry"
            : "Analysis failed — explicit retry required";
          session.ended_at = now();
          this.analysis.save(session);
          job.status = controller.signal.aborted ? "interrupted" : "error";
          job.error = session.error;
        } finally {
          try {
            this.save(job);
          } finally {
            this.active.delete(id);
            release();
          }
        }
      })
      .catch((error) =>
        this.engine.publish({
          event: "core.error",
          text: redact(error instanceof Error ? error.message : String(error)),
        }),
      );
    this.active.set(id, { controller, promise });
    this.analysis.save(session);
    return { analysis_id: requestId };
  };
  close = async () => {
    this.stopped = true;
    for (const operation of this.active.values()) operation.controller.abort();
    await Promise.all([...this.active.values()].map((operation) => operation.promise));
  };
}
