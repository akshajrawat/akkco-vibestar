import { randomUUID } from "node:crypto";

import { z } from "zod";

import { AdeError, now } from "../domain";
import type { Engine } from "../execution/engine";
import { GitHubClient } from "../github/client";
import { GitHubReadPool, IssueSearch } from "../github/issue-search";
import { Usage } from "../execution/output/usage";
import { readLogTail } from "../storage/logs";
import { IssueWatchStore } from "./store";
import { IssueWatchScanner } from "./scan";
import { IssueWatchSemantic } from "./semantic";
import { ScanInput, WatchSaveInput, WatchUpdateInput, type WatchScan } from "./contracts";
import { confirmConfiguration, digest, previewRules, repositoryName } from "./rules";

const watchInput = z.object({ watch_id: z.string().uuid() }).strict();
const scanOwner = watchInput.extend({ scan_id: z.string().uuid() }).strict();
const candidateOwner = scanOwner.extend({ issue_id: z.string().min(1).max(256) }).strict();

const page = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  before: z.string().max(100).optional(),
});

export const watchProviderSupport = {
  codex: {
    supported: true,
    reason:
      "Official Codex subscription CLI; selected model availability is checked before execution.",
  },
  antigravity: {
    supported: false,
    reason:
      "Antigravity's official consumer-plan FAQ does not support third-party application wrapping. Issue Watch does not invoke it; existing workflows remain available.",
    url: "https://www.antigravity.google/docs/faq/",
  },
};

export class IssueWatchService {
  readonly store: IssueWatchStore;

  private readonly pool = new GitHubReadPool();

  private readonly scanner: IssueWatchScanner;

  private readonly active = new Map<
    string,
    { controller: AbortController; promise: Promise<void>; scan: WatchScan }
  >();

  private readonly saving = new Map<
    string,
    { digest: string; controller: AbortController; promise: Promise<unknown> }
  >();

  private stopped = false;

  constructor(
    private readonly engine: Engine,
    private readonly client = new GitHubClient(engine.root),
  ) {
    this.store = new IssueWatchStore(engine.db);
    this.store.interrupt();

    this.scanner = new IssueWatchScanner(
      this.store,
      client,
      this.pool,
      this.changed,
      new IssueWatchSemantic(engine, this.store).screen,
    );
  }

  private changed = (scan?: WatchScan) =>
    this.engine.publish({
      event: !scan
        ? "issue-watch.changed"
        : scan.status === "running" || scan.status === "cancelling"
          ? "issue-watch.progress"
          : scan.status === "failed" || scan.status === "blocked"
            ? "issue-watch.failed"
            : "issue-watch.completed",
      watch_id: scan?.watch_id,
      scan_id: scan?.id,
      run_id: scan?.utility_run_id || undefined,
      data: scan
        ? {
            status: scan.status,
            phase: scan.phase,
            coverage: scan.coverage,
            summary: scan.summary,
          }
        : undefined,
    });

  private assertAvailable = () => {
    this.engine.assertAvailable();
    if (this.stopped) throw new AdeError("closed", "Issue Watch is shutting down.");
  };

  save = (input: unknown, update = false) => {
    this.assertAvailable();
    const editing = update ? WatchUpdateInput.parse(input) : null;
    const p = editing || WatchSaveInput.parse(input);
    const repository = repositoryName(p.repository);
    const preview = confirmConfiguration(repository, p.configuration);
    const requestDigest = digest({ ...p, repository, request_id: undefined });
    const existing = this.store.existingRequest(p.request_id, requestDigest, "revision");
    if (existing)
      return Promise.resolve({
        watch: this.store.get(existing.watch_id),
        revision: this.store.revision(existing.watch_id, existing.revision),
      });
    const pending = this.saving.get(p.request_id);
    if (pending) {
      if (pending.digest !== requestDigest)
        throw new AdeError("idempotency", "Pending request identity has different content.");
      return pending.promise;
    }

    const controller = new AbortController();

    const release = this.engine.trackActivity(
      {
        id: `issue-watch-save:${p.request_id}`,
        kind: "issue_watch",
        label: "Validating and saving Issue Watch",
        stoppable: true,
      },
      async () => {
        controller.abort();
        await this.saving.get(p.request_id)?.promise.catch(() => {});
      },
    );

    const promise = Promise.resolve()
      .then(async () => {
        const prior = editing ? this.store.get(editing.watch_id) : null;

        const resolved = await new IssueSearch(
          this.client,
          controller.signal,
          p.configuration.limits,
          this.pool,
        ).repository(repository, prior?.repository.id);

        controller.signal.throwIfAborted();

        const result = this.store.saveRevision({
          request_id: p.request_id,
          request_digest: requestDigest,
          name: p.name,
          repository: resolved,
          configuration: p.configuration,
          preview,
          ...(editing
            ? {
                watch_id: editing.watch_id,
                expected_revision: editing.expected_revision,
              }
            : {}),
        });

        this.changed();
        return result;
      })
      .finally(() => {
        this.saving.delete(p.request_id);
        release();
      });

    this.saving.set(p.request_id, {
      digest: requestDigest,
      controller,
      promise,
    });

    return promise;
  };

  launch = (
    input: unknown,
    intent: WatchScan["intent"] = "scan",
    parentId: string | null = null,
  ) => {
    this.assertAvailable();
    const p = ScanInput.parse(input);

    const requestDigest = digest({
      ...p,
      request_id: undefined,
      intent,
      parentId,
    });

    const existing = this.store.existingRequest(p.request_id, requestDigest, "scan");
    if (existing) return { operation_id: existing.scan_id!, scan_id: existing.scan_id! };
    const watch = this.store.get(p.watch_id);
    const revision = this.store.revision(watch.id, p.expected_revision);
    if (p.instruction_override) {
      const preview = previewRules({
        repository: watch.repository.full_name,
        prompt: p.instruction_override,
      });

      if (
        preview.explanation.length ||
        preview.ambiguities.length ||
        preview.rules.trackers.length ||
        preview.rules.excluded_issues.length ||
        preview.rules.excluded_labels.length ||
        preview.rules.unassigned_only
      )
        throw new AdeError(
          "ambiguous_rules",
          "This override changes or ambiguously describes hard rules. Preview and save a new watch revision before scanning.",
        );
    }

    if (parentId) {
      const parent = this.store.scan(watch.id, parentId);
      if (parent.revision !== p.expected_revision)
        throw new AdeError(
          "stale_revision",
          "Retry the saved revision or explicitly start a scan of the current revision.",
        );
      if (
        intent === "retry" &&
        !["failed", "blocked", "cancelled", "interrupted"].includes(parent.status)
      )
        throw new AdeError(
          "invalid_state",
          "Retry requires a failed, blocked, cancelled or interrupted attempt.",
        );
      if (intent === "continue" && parent.status !== "partial")
        throw new AdeError("invalid_state", "Continue requires a partial attempt.");
    }

    if (p.candidate_ids) {
      if (new Set(p.candidate_ids).size !== p.candidate_ids.length)
        throw new AdeError(
          "not_found",
          "Selected candidates must belong to this watch and saved attempt.",
        );
      for (const id of p.candidate_ids) this.store.savedCandidate(watch.id, id);
    }

    if (this.active.size >= 4)
      throw new AdeError(
        "busy",
        "Four Issue Watch scans are already active; retry explicitly when capacity is available.",
      );

    const scan: WatchScan = {
      id: randomUUID(),
      watch_id: watch.id,
      revision: p.expected_revision,
      parent_scan_id: parentId,
      intent: p.candidate_ids && intent === "scan" ? "recheck" : intent,
      status: "running",
      phase: "Collecting GitHub issues",
      started_at: now(),
      ended_at: null,
      semantic_attempts: 0,
      utility_run_id: null,
      instruction_override: p.instruction_override || null,
      candidate_ids: p.candidate_ids || null,
      coverage: {
        query: "",
        search_total: null,
        discovered: 0,
        checked: 0,
        excluded: 0,
        context_checked: 0,
        semantic_checked: 0,
        requests: 0,
        retained_bytes: 0,
        search_complete: false,
        exclusions_complete: false,
        evidence_complete: false,
        semantic_complete: false,
        warnings: [],
      },
      error: null,
      context_hash: null,
      summary: {},
    };

    const reservation = this.store.reserve(scan, p.request_id, requestDigest);
    if (!reservation.created)
      return {
        operation_id: reservation.scan.id,
        scan_id: reservation.scan.id,
      };
    if (!watchProviderSupport[revision.configuration.model.provider].supported) {
      scan.status = "blocked";
      scan.phase = "Unsupported provider";
      scan.ended_at = now();
      scan.error = watchProviderSupport[revision.configuration.model.provider].reason;
      this.store.finish(scan, [], watch.last_complete_scan_id);
      this.changed(scan);
      return { operation_id: scan.id, scan_id: scan.id };
    }

    const controller = new AbortController();

    const release = this.engine.trackActivity(
      {
        id: `issue-watch:${scan.id}`,
        kind: "issue_watch",
        label: `Issue Watch: ${watch.name}`,
        stoppable: true,
      },
      () => this.cancel(watch.id, scan.id).then(() => {}),
    );

    const promise = Promise.resolve()
      .then(() => this.scanner.run(scan, controller.signal))
      .catch((error: unknown) => {
        const saved = this.store.scan(scan.watch_id, scan.id);
        if (["running", "cancelling"].includes(saved.status))
          this.store.saveScan({
            ...saved,
            status: controller.signal.aborted ? "cancelled" : "failed",
            ended_at: now(),
            phase: "Stopped",
            error: String(error).slice(0, 4000),
          });
        this.changed(this.store.scan(scan.watch_id, scan.id));
      })
      .finally(() => {
        this.active.delete(scan.id);
        release();
      });

    this.active.set(scan.id, { controller, promise, scan });
    this.changed(scan);
    return { operation_id: scan.id, scan_id: scan.id };
  };

  cancel = async (watchId: string, scanId: string) => {
    const scan = this.store.scan(watchId, scanId);
    const active = this.active.get(scanId);
    if (!active || !["running", "cancelling"].includes(scan.status)) return scan;
    active.scan.status = "cancelling";
    active.scan.phase = "Cancelling";
    this.store.saveScan(active.scan);
    this.changed(active.scan);
    active.controller.abort();
    await active.promise;
    return this.store.scan(watchId, scanId);
  };

  call = async (method: string, input: unknown) => {
    switch (method) {
      case "previewRules":
        return previewRules(input);

      case "labels": {
        const p = z
          .object({ repository: z.string().min(1).max(500) })
          .strict()
          .parse(input);

        const repository = repositoryName(p.repository);

        const labels = await this.client.pages<unknown>(
          `repos/${repository}/labels`,
          AbortSignal.timeout(30000),
          10,
        );

        return z
          .array(z.object({ name: z.string().min(1).max(100) }))
          .max(1000)
          .parse(labels)
          .map((label) => label.name);
      }

      case "providerSupport":
        return watchProviderSupport;

      case "create":
        return this.save(input);

      case "update":
        return this.save(input, true);

      case "list": {
        const p = page
          .extend({ archived: z.boolean().default(false) })
          .strict()
          .parse(input);

        return this.store.list(p.archived, p.limit, p.before).map((watch) => {
          try {
            return {
              ...watch,
              revision: this.store.revision(watch.id),
              active: this.store.active(watch.id),
              latest: this.store.history(watch.id, 1)[0] || null,
              error: null,
            };
          } catch (error) {
            if (!(error instanceof AdeError && error.kind === "corrupt_record")) throw error;
            return {
              ...watch,
              revision: null,
              active: null,
              latest: null,
              error: error.message,
            };
          }
        });
      }

      case "detail": {
        const p = watchInput.parse(input);
        const watch = this.store.get(p.watch_id);
        return {
          watch,
          revision: this.store.revision(watch.id),
          active: this.store.active(watch.id),
          baseline: watch.last_complete_scan_id
            ? this.store.scan(watch.id, watch.last_complete_scan_id)
            : null,
          results: this.store.summaries(this.store.results(watch.id), watch.id),
          provider_support: watchProviderSupport,
        };
      }

      case "archive": {
        const p = watchInput
          .extend({
            expected_revision: z.number().int().positive(),
            archived: z.boolean(),
          })
          .strict()
          .parse(input);

        this.assertAvailable();
        const result = this.store.archive(p.watch_id, p.expected_revision, p.archived);
        this.changed();
        return result;
      }

      case "scan":
        return this.launch(input);

      case "retry":
      case "continue": {
        const p = scanOwner
          .extend({
            request_id: z.string().uuid(),
            candidate_ids: z.array(z.string().min(1).max(256)).min(1).max(200).optional(),
          })
          .strict()
          .parse(input);

        const parent = this.store.scan(p.watch_id, p.scan_id);
        if (method === "continue" && !p.candidate_ids)
          throw new AdeError(
            "invalid_input",
            "Confirm the candidate selection for this new Continue Analysis attempt.",
          );
        return this.launch(
          {
            watch_id: p.watch_id,
            expected_revision: parent.revision,
            request_id: p.request_id,
            ...(parent.instruction_override
              ? { instruction_override: parent.instruction_override }
              : {}),
            ...(parent.candidate_ids ? { candidate_ids: parent.candidate_ids } : {}),
            ...(p.candidate_ids ? { candidate_ids: p.candidate_ids } : {}),
          },
          method,
          parent.id,
        );
      }

      case "cancel": {
        const p = scanOwner.parse(input);
        return this.cancel(p.watch_id, p.scan_id);
      }

      case "scanHistory": {
        const p = watchInput.extend(page.shape).strict().parse(input);
        return this.store.history(p.watch_id, p.limit, p.before);
      }

      case "scanDetail": {
        const p = scanOwner.parse(input);
        return {
          scan: this.store.scan(p.watch_id, p.scan_id),
          candidates: this.store.summaries(
            this.store.candidates(p.watch_id, p.scan_id),
            p.watch_id,
          ),
          sources: this.store.sources(p.watch_id, p.scan_id).map((source) => {
            const { text, references, ...metadata } = source;
            return {
              ...metadata,
              body_bytes: Buffer.byteLength(text),
              reference_count: references.length,
            };
          }),
          run:
            this.engine.db.all(
              "SELECT * FROM utility_runs WHERE watch_id=? AND scan_id=? ORDER BY started_at DESC LIMIT 1",
              p.watch_id,
              p.scan_id,
            )[0] || null,
          usage: new Usage(this.engine.db)
            .list()
            .filter((row) => row.watch_id === p.watch_id && row.scan_id === p.scan_id),
        };
      }

      case "events":
      case "logs": {
        const p = scanOwner
          .extend({
            run_id: z.string().uuid(),
            before: z.number().int().nonnegative().optional(),
            after: z.number().int().nonnegative().optional(),
            search: z.string().max(256).optional(),
            stream: z.enum(["stdout", "stderr"]).default("stdout"),
          })
          .strict()
          .parse(input);

        this.store.scan(p.watch_id, p.scan_id);
        if (
          !this.engine.db.all(
            "SELECT id FROM utility_runs WHERE id=? AND scan_id=? AND watch_id=?",
            p.run_id,
            p.scan_id,
            p.watch_id,
          ).length
        )
          throw new AdeError("isolation", "Utility run does not belong to this watch and scan.");
        if (method === "logs")
          return readLogTail(this.engine.root, `issue-watch-${p.scan_id}`, p.run_id, p.stream, {
            before: p.before,
            after: p.after,
            search: p.search,
          });

        const rows = this.engine.db.all<{
          id: number;
          run_id: string;
          timestamp: string;
          kind: string;
          data: string;
          raw: string;
          stream: string;
        }>(
          `SELECT * FROM utility_events WHERE run_id=? AND id<? AND id>? AND (?='' OR instr(lower(data || raw),lower(?))>0) ORDER BY id ${p.after === undefined ? "DESC" : "ASC"} LIMIT 501`,
          p.run_id,
          p.before ?? Number.MAX_SAFE_INTEGER,
          p.after ?? 0,
          p.search || "",
          (p.search || "").toLowerCase(),
        );

        const events = rows.slice(0, 500);
        if (p.after === undefined) events.reverse();
        return {
          events: events.map((event) => ({ ...event, task_id: null })),
          context: [],
          more: rows.length > 500,
        };
      }

      case "candidateDetail": {
        const p = candidateOwner.parse(input);
        const candidate = this.store.candidate(p.watch_id, p.scan_id, p.issue_id);
        return {
          candidate: {
            ...candidate,
            dismissed_at: this.store.dispositions(p.watch_id).get(candidate.issue.id) ?? null,
          },
          sources: this.store
            .sources(p.watch_id, p.scan_id)
            .filter((source) => candidate.source_keys.includes(source.key)),
        };
      }

      case "sourceDetail": {
        const p = scanOwner
          .extend({ source_key: z.string().min(1).max(256) })
          .strict()
          .parse(input);

        const source = this.store
          .sources(p.watch_id, p.scan_id)
          .find((item) => item.key === p.source_key);

        if (!source) throw new AdeError("not_found", "Source does not belong to this scan.");
        return source;
      }

      case "dismissCandidate": {
        const p = watchInput
          .extend({
            issue_id: z.string().min(1).max(256),
            dismissed: z.boolean(),
          })
          .strict()
          .parse(input);

        this.assertAvailable();
        const result = this.store.dismiss(p.watch_id, p.issue_id, p.dismissed);
        this.changed();
        return result;
      }

      default:
        throw new AdeError("invalid_method", "Unknown Issue Watch operation.");
    }
  };

  close = async () => {
    this.stopped = true;
    for (const active of this.active.values()) active.controller.abort();
    for (const saving of this.saving.values()) saving.controller.abort();

    await Promise.allSettled(
      [...this.active.values()]
        .map((active) => active.promise)
        .concat([...this.saving.values()].map((saving) => saving.promise.then(() => {}))),
    );
  };
}
