import { assessActivity, ActionSchema, reviewPrompt } from "./action";
import type { GitHubPullRequest, WatchSettings } from "../github/contracts";
import { randomUUID } from "node:crypto";
import { now, AdeError } from "../domain";
import type { Engine } from "../execution/engine";
import { redact } from "../execution/process";
import { GitHubMonitor } from "./github";
import {
  ScheduleInput,
  changedPullRequest,
  parsePullRequest,
  type ScheduleJob,
  type ScheduleAttention,
} from "./contracts";
export class Scheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller = new AbortController();
  private running: Promise<void> | undefined;
  private stopped = false;
  constructor(
    private readonly engine: Engine,
    private readonly monitor = new GitHubMonitor(engine.root),
  ) {}
  jobs = () =>
    this.engine.db
      .all<{ data: string }>("SELECT data FROM scheduled_jobs ORDER BY rowid")
      .map((r) => {
        const job = JSON.parse(r.data) as ScheduleJob;
        if (job.action) job.action = ActionSchema.parse(job.action);
        if (job.conversation_action)
          job.conversation_action = ActionSchema.parse(job.conversation_action);
        return job;
      });
  attention = () =>
    this.engine.db.all<ScheduleAttention>(
      "SELECT * FROM scheduled_attention WHERE dismissed=0 ORDER BY created_at DESC",
    );
  private save = (job: ScheduleJob) => {
    if (
      job.task_id &&
      !this.engine.db.tasks().some((t) => t.id === job.task_id)
    )
      job.task_id = null;
    this.engine.db.run(
      "INSERT INTO scheduled_jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      job.id,
      JSON.stringify(job),
    );
    this.engine.changed();
  };
  private job = (id: string) => {
    const job = this.jobs().find((j) => j.id === id);
    if (!job) throw new AdeError("not_found", "Scheduled job not found");
    return job;
  };
  add = (input: unknown) => {
    const p = ScheduleInput.parse(input);
    const ref = parsePullRequest(p.url);
    if (this.jobs().some((j) => j.url === ref.url))
      throw new AdeError("duplicate", "This PR is already tracked");
    if (p.task_id) {
      const repo = this.engine.db.repository(
        this.engine.db.task(p.task_id).repo_id,
      );
      if (
        `${repo.owner}/${repo.name}`.toLowerCase() !==
        `${ref.owner}/${ref.repo}`.toLowerCase()
      )
        throw new AdeError(
          "invalid_input",
          "PR and linked worktree must belong to the same upstream repository",
        );
    }
    const job: ScheduleJob = {
      ...p,
      url: ref.url,
      id: randomUUID(),
      enabled: true,
      next_run_at: now(),
      status: "idle",
      last_checked_at: null,
      last_snapshot: null,
      pending_snapshot: null,
      changes: [],
      error: null,
    };
    this.save(job);
    this.wake();
    return job;
  };
  discovered = (pr: GitHubPullRequest, settings: WatchSettings) => {
    if (pr.task_id && !this.engine.db.tasks().some((t) => t.id === pr.task_id))
      pr = { ...pr, task_id: null };
    let job = this.jobs().find((j) => j.url === pr.url);
    if (!job && pr.state === "OPEN" && settings.auto_watch)
      job = this.add({
        url: pr.url,
        task_id: pr.task_id,
        interval_minutes: settings.interval_minutes,
        verify_codex: settings.verify_codex,
      });
    if (!job) return;
    if (!job.task_id && pr.task_id) job.task_id = pr.task_id;
    job.title = pr.title;
    if (pr.state === "OPEN" && job.archived) {
      job.archived = false;
      job.enabled = !job.paused_before_archive;
      job.last_snapshot = null;
      job.pending_snapshot = null;
      job.status = "idle";
      job.next_run_at = now();
      job.action = undefined;
    }
    if (pr.state !== "OPEN") {
      if (!job.archived) job.paused_before_archive = !job.enabled;
      job.enabled = false;
      job.archived = true;
      job.check_once = false;
      job.action = ActionSchema.parse({
        conversationState: pr.state === "MERGED" ? "merged" : "closed",
        manualActionRequired: false,
        severity: "info",
        summary: pr.state === "MERGED" ? "PR merged" : "PR closed",
        reason: "",
        newActivity: [],
        recommendedNextAction: "",
        affectedFiles: [],
      });
    }
    if (job.archived)
      this.engine.db.run(
        "UPDATE scheduled_attention SET dismissed=1 WHERE job_id=?",
        job.id,
      );
    this.save(job);
    this.wake();
  };
  setEnabled = (id: string, enabled: boolean) => {
    const job = this.job(id);
    if (["polling", "analyzing"].includes(job.status))
      throw new AdeError("busy", "Wait for the current inspection to finish");
    if (job.archived)
      throw new AdeError(
        "invalid_state",
        "This PR is closed; its watch is archived",
      );
    job.enabled = enabled;
    if (!enabled) job.check_once = false;
    this.save(job);
    this.wake();
  };
  runNow = (id: string, retry = false) => {
    const job = this.job(id);
    if (["polling", "analyzing"].includes(job.status))
      throw new AdeError("busy", "Inspection already running");
    if (job.archived)
      throw new AdeError("invalid_state", "This PR is archived");
    if (retry && job.pending_snapshot) job.status = "pending";
    else if (["error", "interrupted"].includes(job.status)) job.status = "idle";
    job.next_run_at = now();
    job.check_once = !job.enabled;
    this.save(job);
    this.wake();
  };
  dismiss = (id: string) => {
    this.engine.db.run(
      "UPDATE scheduled_attention SET dismissed=1 WHERE id=?",
      id,
    );
    this.engine.changed();
  };
  fix = async (id: string) => {
    const item = this.attention().find((a) => a.id === id);
    if (!item?.task_id)
      throw new AdeError(
        "invalid_state",
        "Link an isolated task before requesting a fix",
      );
    const job = this.job(item.job_id);
    if (["analyzing", "polling"].includes(job.status))
      throw new AdeError("busy", "Wait for scheduled analysis to finish");
    return this.engine.followUp(
      item.task_id,
      `Manually requested PR fix for ${job.url}. Review these changes and saved analysis critically. Implement only supporting changes within our claimed scope. Do not push, comment, create PRs or merge.\nChanges:\n${item.changes}\nAnalysis:\n${item.analysis || item.error}\nCodex refinement:\n${item.refinement || "Not requested"}`,
    );
  };
  start = () => {
    for (const job of this.jobs()) {
      if (job.status === "polling") {
        job.status = "idle";
        job.next_run_at = now();
        this.save(job);
      } else if (job.status === "analyzing") {
        job.status = "interrupted";
        job.error =
          "Analysis interrupted. Explicit retry required; no model was automatically restarted.";
        this.save(job);
      }
    }
    this.wake();
  };
  private wake = () => {
    if (this.stopped || this.running) return;
    if (this.timer) clearTimeout(this.timer);
    const jobs = this.jobs().filter(
      (j) =>
        (j.enabled || j.check_once) &&
        !["interrupted", "error"].includes(j.status),
    );
    if (!jobs.length) return;
    const delay = Math.max(
      0,
      Math.min(...jobs.map((j) => Date.parse(j.next_run_at))) - Date.now(),
    );
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.running = this.tick()
          .catch((e) => {
            this.engine.publish({ event: "changed", text: redact(String(e)) });
          })
          .finally(() => {
            this.running = undefined;
            this.wake();
          });
      },
      Math.min(delay, 2147483647),
    );
    this.timer.unref();
  };
  tick = async () => {
    for (const candidate of this.jobs().filter(
      (j) =>
        (j.enabled || j.check_once) &&
        Date.parse(j.next_run_at) <= Date.now() &&
        !["interrupted", "error"].includes(j.status),
    )) {
      if (this.controller.signal.aborted) return;
      const job = this.job(candidate.id);
      if (job.archived || (!job.enabled && !job.check_once)) continue;
      const controller = new AbortController();
      const signal = AbortSignal.any([
        this.controller.signal,
        controller.signal,
      ]);
      let finish = () => {};
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let release: (() => void) | undefined;
      try {
        release = this.engine.trackActivity(
          {
            id: `pr-watch:${job.id}`,
            kind: "pr_watch",
            task_id: job.task_id || undefined,
            label: `PR watch inspection ${job.url.replace("https://github.com/", "").replace("/pull/", " #")} is running`,
            stoppable: true,
          },
          async () => {
            job.enabled = false;
            job.check_once = false;
            this.save(job);
            controller.abort();
            if (this.engine.isExecuting(`utility:${job.id}`))
              this.engine.cancel(`utility:${job.id}`);
            await finished;
          },
        );
        job.status = "polling";
        this.save(job);
        const current = await this.monitor.inspect(job.url, signal);
        signal.throwIfAborted();
        if (this.job(job.id).archived) continue;
        job.last_checked_at = now();
        job.title = current.title;
        job.next_run_at = new Date(
          Date.now() + job.interval_minutes * 60000,
        ).toISOString();
        job.error = null;
        const previous = job.last_snapshot || {
          ...current,
          discussion: [],
          comments: [],
          reviews: [],
          checks: [],
          threads: [],
          mergeable: "UNKNOWN",
          reviewDecision: "",
        };
        const changes = job.last_snapshot
          ? changedPullRequest(previous, current).changes
          : ["Initial PR inspection"];
        job.changes = changes;
        const assessment = assessActivity(previous, current, changes);
        if (!changes.length && !job.pending_snapshot) {
          job.status = "idle";
          job.check_once = false;
          job.last_snapshot = current;
          job.analysis_method = "deterministic";
          this.save(job);
          continue;
        }
        if (!assessment.analyze) {
          if (
            assessment.action.summary ===
              "Review conversation is being assessed" &&
            job.conversation_action
          )
            assessment.action = job.conversation_action;
          job.action = assessment.action;
          job.attention_source = assessment.source;
          job.analysis_method = "deterministic";
        } else {
          job.pending_snapshot = current;
          job.status = "analyzing";
          this.save(job);
          const result = await this.engine.analyzeScheduled(
            job.task_id,
            reviewPrompt(current, job.action, changes),
            job.verify_codex,
            job.id,
            signal,
          );
          if (!result) {
            job.status = "pending";
            job.next_run_at = new Date(Date.now() + 60000).toISOString();
            this.save(job);
            continue;
          }
          if (this.job(job.id).archived) continue;
          job.action = ActionSchema.parse(result.refinement || result.analysis);
          job.action.severity = job.action.manualActionRequired
            ? "action_required"
            : job.action.severity === "action_required"
              ? "info"
              : job.action.severity;
          if (
            job.action.manualActionRequired &&
            job.action.conversationState === "neutral"
          )
            job.action.conversationState = "waiting_for_me";
          job.conversation_action = job.action;
          job.attention_source = "review";
          job.analysis_method = "utility_ai";
          if (job.action.manualActionRequired)
            this.record(
              job,
              result.analysis,
              result.refinement,
              null,
              job.action.summary,
            );
        }
        if (
          !job.action?.manualActionRequired &&
          assessment.ciPending &&
          current.state === "OPEN"
        )
          job.action = {
            ...job.action!,
            conversationState: "waiting_for_ci",
            summary: "CI running",
            reason: job.action?.reason
              ? `${job.action.reason} Waiting for checks to finish.`
              : "Waiting for checks to finish",
          };
        if (!job.action?.manualActionRequired)
          this.engine.db.run(
            "UPDATE scheduled_attention SET dismissed=1 WHERE job_id=?",
            job.id,
          );
        else if (!assessment.analyze)
          this.record(job, null, null, null, job.action.summary);
        job.last_snapshot = current;
        job.pending_snapshot = null;
        job.status = "idle";
        job.check_once = false;
        if (current.state !== "OPEN") {
          job.paused_before_archive = !job.enabled;
          job.enabled = false;
          job.archived = true;
        }
        this.save(job);
      } catch (error) {
        job.check_once = false;
        if (!release && error instanceof AdeError && error.kind === "busy") {
          job.status = "pending";
          job.error = null;
          job.next_run_at = new Date(Date.now() + 60000).toISOString();
          this.save(job);
          continue;
        }
        job.error = redact(
          error instanceof Error ? error.message : String(error),
        );
        if (job.pending_snapshot) {
          job.status = signal.aborted ? "interrupted" : "error";
          this.record(
            job,
            null,
            null,
            job.error,
            "PR conversation analysis unavailable",
          );
        } else {
          job.status = "idle";
          if (signal.aborted) job.error = null;
          job.next_run_at = new Date(
            Date.now() + job.interval_minutes * 60000,
          ).toISOString();
        }
        this.save(job);
      } finally {
        release?.();
        finish();
      }
    }
  };
  private record = (
    job: ScheduleJob,
    analysis: unknown,
    refinement: unknown,
    error: string | null,
    summary = "Actionable PR update",
  ) => {
    this.engine.db.run(
      "UPDATE scheduled_attention SET dismissed=1 WHERE job_id=?",
      job.id,
    );
    return this.engine.db.run(
      "INSERT INTO scheduled_attention(id,job_id,task_id,created_at,summary,changes,analysis,refinement,error) VALUES(?,?,?,?,?,?,?,?,?)",
      randomUUID(),
      job.id,
      job.task_id,
      now(),
      summary,
      JSON.stringify(job.changes),
      analysis ? JSON.stringify(analysis) : null,
      refinement ? JSON.stringify(refinement) : null,
      error,
    );
  };
  close = async () => {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.controller.abort();
    for (const job of this.jobs())
      if (
        job.status === "analyzing" &&
        this.engine.isActive(`utility:${job.id}`)
      )
        this.engine.cancel(`utility:${job.id}`);
    await this.running;
  };
}
