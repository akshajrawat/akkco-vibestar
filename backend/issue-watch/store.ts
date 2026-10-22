import { randomUUID } from "node:crypto";
import { AdeError, now } from "../domain";
import type { Database } from "../storage/database";
import {
  CandidateSchema,
  ScanSchema,
  SourceSchema,
  WatchRevisionSchema,
  WatchSchema,
  type RepositoryIdentity,
  type WatchConfiguration,
  type WatchScan,
  type WatchSource,
  type WatchCandidate,
  type CandidateSummary,
} from "./contracts";
import { digest, type previewRules } from "./rules";
import { isMatch } from "./eligibility";

export class IssueWatchStore {
  constructor(private readonly db: Database) {}
  private decode = <T>(
    table: string,
    id: string,
    data: string,
    parse: (value: unknown) => T,
    identity?: string,
  ) =>
    this.db.records.decode(
      { table, id, column: "data", source: data, identity },
      parse,
    );
  list = (archived = false, limit = 100, before?: string) =>
    this.db.records.list(
      "issue_watches",
      this.db.all<{ id: string; data: string }>(
        `SELECT id,data FROM issue_watches WHERE archived=? ${before ? "AND id<?" : ""} ORDER BY id DESC LIMIT ?`,
        Number(archived),
        ...(before ? [before] : []),
        limit,
      ),
      WatchSchema.parse,
      "id",
    );
  get = (id: string) => {
    const row = this.db.all<{ data: string }>(
      "SELECT data FROM issue_watches WHERE id=?",
      id,
    )[0];
    if (!row) throw new AdeError("not_found", "Issue Watch not found.");
    return this.decode("issue_watches", id, row.data, WatchSchema.parse, "id");
  };
  revision = (
    watchId: string,
    revision = this.get(watchId).current_revision,
  ) => {
    const row = this.db.all<{ data: string }>(
      "SELECT data FROM issue_watch_revisions WHERE watch_id=? AND revision=?",
      watchId,
      revision,
    )[0];
    if (!row)
      throw new AdeError("not_found", "Issue Watch revision not found.");
    const value = this.decode(
      "issue_watch_revisions",
      `${watchId}:${revision}`,
      row.data,
      WatchRevisionSchema.parse,
    );
    if (value.watch_id !== watchId || value.revision !== revision)
      throw new AdeError(
        "corrupt_record",
        "Saved watch revision ownership is inconsistent.",
      );
    return value;
  };
  private saveWatch = (watch: ReturnType<IssueWatchStore["get"]>) => {
    const value = WatchSchema.parse(watch);
    this.db.run(
      "INSERT INTO issue_watches VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,repository_full_name=excluded.repository_full_name,current_revision=excluded.current_revision,archived=excluded.archived,updated_at=excluded.updated_at,last_complete_scan_id=excluded.last_complete_scan_id,data=excluded.data",
      value.id,
      value.name,
      value.repository.id,
      value.repository.full_name,
      value.current_revision,
      Number(value.archived),
      value.created_at,
      value.updated_at,
      value.last_complete_scan_id,
      JSON.stringify(value),
    );
  };
  existingRequest = (
    requestId: string,
    requestDigest: string,
    kind: "revision" | "scan",
  ) => {
    const revision = this.db.all<{
      watch_id: string;
      revision: number;
      request_digest: string;
    }>(
      "SELECT watch_id,revision,request_digest FROM issue_watch_revisions WHERE request_id=?",
      requestId,
    )[0];
    const scan = this.db.all<{
      id: string;
      watch_id: string;
      request_digest: string;
    }>(
      "SELECT id,watch_id,request_digest FROM issue_watch_scans WHERE request_id=?",
      requestId,
    )[0];
    const row = kind === "revision" ? revision : scan;
    if ((revision || scan) && (!row || row.request_digest !== requestDigest))
      throw new AdeError(
        "idempotency",
        "This request identity already belongs to a different operation or payload.",
      );
    return row
      ? {
          watch_id: row.watch_id,
          revision: revision?.revision,
          scan_id: scan?.id,
        }
      : null;
  };
  saveRevision = (input: {
    request_id: string;
    request_digest: string;
    name: string;
    repository: RepositoryIdentity;
    configuration: WatchConfiguration;
    preview: ReturnType<typeof previewRules>;
    watch_id?: string;
    expected_revision?: number;
  }) =>
    this.db.transaction(() => {
      const existing = this.existingRequest(
        input.request_id,
        input.request_digest,
        "revision",
      );
      if (existing)
        return {
          watch: this.get(existing.watch_id),
          revision: this.revision(existing.watch_id, existing.revision),
        };
      const previous = input.watch_id ? this.get(input.watch_id) : null;
      if (
        previous &&
        (previous.current_revision !== input.expected_revision ||
          previous.repository.id !== input.repository.id)
      )
        throw new AdeError(
          "stale_revision",
          "Watch changed or repository identity differs. Reload the editor.",
        );
      if (previous && this.active(previous.id))
        throw new AdeError(
          "busy",
          "Cancel the active scan before editing this watch.",
        );
      const time = now();
      const watch = previous
        ? {
            ...previous,
            name: input.name,
            repository: input.repository,
            current_revision: previous.current_revision + 1,
            updated_at: time,
          }
        : {
            id: randomUUID(),
            name: input.name,
            repository: input.repository,
            current_revision: 1,
            archived: false,
            created_at: time,
            updated_at: time,
            last_complete_scan_id: null,
          };
      const revision = WatchRevisionSchema.parse({
        watch_id: watch.id,
        revision: watch.current_revision,
        created_at: time,
        rules_digest: digest(input.configuration.rules),
        configuration: input.configuration,
        explanation: input.preview.explanation,
      });
      this.saveWatch(watch);
      this.db.run(
        "INSERT INTO issue_watch_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        watch.id,
        revision.revision,
        input.request_id,
        input.request_digest,
        time,
        revision.rules_digest,
        1,
        revision.configuration.model.provider,
        revision.configuration.model.model,
        revision.configuration.model.effort,
        revision.configuration.model.timeout_secs,
        JSON.stringify(revision),
      );
      return { watch, revision };
    });
  archive = (watchId: string, expectedRevision: number, archived: boolean) => {
    const watch = this.get(watchId);
    if (watch.current_revision !== expectedRevision)
      throw new AdeError(
        "stale_revision",
        "Reload this watch before archiving it.",
      );
    if (this.active(watchId))
      throw new AdeError(
        "busy",
        "Cancel the active scan before archiving this watch.",
      );
    this.saveWatch({ ...watch, archived, updated_at: now() });
    return this.get(watchId);
  };
  scan = (watchId: string, id: string) => {
    const row = this.db.all<{
      data: string;
      status: WatchScan["status"];
      ended_at: string | null;
    }>(
      "SELECT data,status,ended_at FROM issue_watch_scans WHERE watch_id=? AND id=?",
      watchId,
      id,
    )[0];
    if (!row)
      throw new AdeError("not_found", "Scan does not belong to this watch.");
    const scan = this.decode(
      "issue_watch_scans",
      id,
      row.data,
      ScanSchema.parse,
      "id",
    );
    if (scan.watch_id !== watchId)
      throw new AdeError(
        "corrupt_record",
        "Saved scan ownership is inconsistent.",
      );
    return { ...scan, status: row.status, ended_at: row.ended_at };
  };
  history = (watchId: string, limit = 50, before?: string) => {
    this.get(watchId);
    const cursor = before ? this.scan(watchId, before) : null;
    return this.db.records.list(
      "issue_watch_scans",
      this.db.all<{ id: string; data: string }>(
        `SELECT id,data FROM issue_watch_scans WHERE watch_id=? ${cursor ? "AND (started_at<? OR (started_at=? AND rowid<(SELECT rowid FROM issue_watch_scans WHERE id=? AND watch_id=?)))" : ""} ORDER BY started_at DESC,rowid DESC LIMIT ?`,
        watchId,
        ...(cursor
          ? [cursor.started_at, cursor.started_at, cursor.id, watchId]
          : []),
        limit,
      ),
      ScanSchema.parse,
      "id",
    );
  };
  active = (watchId: string) => {
    const row = this.db.all<{ id: string }>(
      "SELECT id FROM issue_watch_scans WHERE watch_id=? AND status IN('running','cancelling')",
      watchId,
    )[0];
    return row ? this.scan(watchId, row.id) : null;
  };
  reserve = (scan: WatchScan, requestId: string, requestDigest: string) =>
    this.db.transaction(() => {
      const existing = this.existingRequest(requestId, requestDigest, "scan");
      if (existing)
        return {
          scan: this.scan(existing.watch_id, existing.scan_id!),
          created: false,
        };
      const watch = this.get(scan.watch_id);
      if (watch.current_revision !== scan.revision)
        throw new AdeError(
          "stale_revision",
          "Reload this watch before scanning.",
        );
      if (watch.archived)
        throw new AdeError(
          "invalid_state",
          "Restore this watch before scanning.",
        );
      if (this.active(watch.id))
        throw new AdeError("busy", "This watch already has an active scan.");
      if (scan.parent_scan_id) this.scan(watch.id, scan.parent_scan_id);
      this.db.run(
        "INSERT INTO issue_watch_scans VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        scan.id,
        scan.watch_id,
        scan.revision,
        requestId,
        requestDigest,
        scan.parent_scan_id,
        scan.intent,
        scan.status,
        scan.phase,
        scan.started_at,
        scan.ended_at,
        scan.semantic_attempts,
        scan.utility_run_id,
        JSON.stringify(ScanSchema.parse(scan)),
      );
      return { scan, created: true };
    });
  saveScan = (scan: WatchScan) => {
    const previous = this.scan(scan.watch_id, scan.id);
    scan.utility_run_id ||= previous.utility_run_id;
    const value = ScanSchema.parse(scan);
    this.db.run(
      "UPDATE issue_watch_scans SET status=?,phase=?,ended_at=?,semantic_attempts=?,utility_run_id=?,data=? WHERE id=? AND watch_id=?",
      value.status,
      value.phase,
      value.ended_at,
      value.semantic_attempts,
      value.utility_run_id,
      JSON.stringify(value),
      value.id,
      value.watch_id,
    );
  };
  reserveSemantic = (scan: WatchScan, contextHash: string) =>
    this.db.transaction(() => {
      const saved = this.scan(scan.watch_id, scan.id);
      if (
        saved.status !== "running" ||
        saved.semantic_attempts !== 0 ||
        saved.utility_run_id
      )
        throw new AdeError(
          "invocation_budget",
          "This scan has no unused semantic invocation slot. Continue or retry requires a new explicit attempt.",
        );
      scan.semantic_attempts = 1;
      scan.context_hash = contextHash;
      scan.phase = "AI screening";
      this.saveScan(scan);
    });
  saveSource = (scan: WatchScan, source: WatchSource) => {
    const value = SourceSchema.parse(source);
    this.db.run(
      "INSERT INTO issue_watch_sources VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(scan_id,source_key) DO UPDATE SET revision_digest=excluded.revision_digest,complete=excluded.complete,data=excluded.data",
      scan.id,
      value.key,
      value.kind,
      value.url,
      value.hash,
      value.fetched_at,
      Number(value.complete),
      JSON.stringify(value),
    );
  };
  sources = (watchId: string, scanId: string, strict = false) => {
    this.scan(watchId, scanId);
    if (strict)
      return this.db
        .all<{ id: string; data: string }>(
          "SELECT source_key id,data FROM issue_watch_sources WHERE scan_id=? ORDER BY rowid",
          scanId,
        )
        .map((row) =>
          this.decode(
            "issue_watch_sources",
            `${scanId}:${row.id}`,
            row.data,
            SourceSchema.parse,
          ),
        );
    return this.db.records.list(
      "issue_watch_sources",
      this.db.all<{ id: string; data: string }>(
        "SELECT source_key id,data FROM issue_watch_sources WHERE scan_id=? ORDER BY rowid",
        scanId,
      ),
      SourceSchema.parse,
    );
  };
  saveCandidate = (scan: WatchScan, candidate: WatchCandidate) => {
    const value = CandidateSchema.parse(candidate);
    this.db.run(
      "INSERT INTO issue_watch_candidates VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(scan_id,issue_id) DO UPDATE SET claim_state=excluded.claim_state,semantic_state=excluded.semantic_state,checked_at=excluded.checked_at,data=excluded.data",
      scan.id,
      value.issue.id,
      value.issue.repository_id,
      value.issue.number,
      value.claim_state,
      value.semantic_state,
      value.checked_at,
      JSON.stringify(value),
    );
  };
  candidates = (watchId: string, scanId: string) => {
    this.scan(watchId, scanId);
    return this.db.records.list(
      "issue_watch_candidates",
      this.db.all<{ id: string; data: string }>(
        "SELECT issue_id id,data FROM issue_watch_candidates WHERE scan_id=? ORDER BY number",
        scanId,
      ),
      CandidateSchema.parse,
    );
  };
  candidate = (watchId: string, scanId: string, issueId: string) => {
    this.scan(watchId, scanId);
    const row = this.db.all<{ data: string }>(
      "SELECT data FROM issue_watch_candidates WHERE scan_id=? AND issue_id=?",
      scanId,
      issueId,
    )[0];
    if (!row)
      throw new AdeError(
        "not_found",
        "Candidate does not belong to this scan.",
      );
    const value = this.decode(
      "issue_watch_candidates",
      `${scanId}:${issueId}`,
      row.data,
      CandidateSchema.parse,
    );
    if (
      value.issue.id !== issueId ||
      value.issue.repository_id !== this.get(watchId).repository.id
    )
      throw new AdeError(
        "corrupt_record",
        "Candidate identity is inconsistent.",
      );
    return value;
  };
  private candidateLocation = (watchId: string, issueId: string) => {
    this.get(watchId);
    const row = this.db.all<{ scan_id: string }>(
      "SELECT c.scan_id FROM issue_watch_candidates c JOIN issue_watch_scans s ON s.id=c.scan_id WHERE s.watch_id=? AND c.issue_id=? ORDER BY s.started_at DESC,s.rowid DESC LIMIT 1",
      watchId,
      issueId,
    )[0];
    if (!row)
      throw new AdeError(
        "not_found",
        "Candidate has no saved identity in this watch.",
      );
    return row.scan_id;
  };
  savedCandidate = (watchId: string, issueId: string) =>
    this.candidate(watchId, this.candidateLocation(watchId, issueId), issueId);
  dispositions = (watchId: string) =>
    new Map(
      this.db
        .all<{ issue_id: string; dismissed_at: string | null }>(
          "SELECT issue_id,dismissed_at FROM issue_watch_results WHERE watch_id=?",
          watchId,
        )
        .map((row) => [row.issue_id, row.dismissed_at]),
    );
  summaries = (
    candidates: WatchCandidate[],
    watchId: string,
  ): CandidateSummary[] => {
    const dispositions = this.dispositions(watchId);
    return candidates.map((candidate) => {
      const { issue: snapshot, evidence, source_keys, ...rest } = candidate;
      const { body, ...issue } = snapshot;
      return {
        ...rest,
        dismissed_at: dispositions.get(issue.id) ?? null,
        issue,
        body_bytes: Buffer.byteLength(body),
        evidence_count: evidence.length,
        source_count: source_keys.length,
      };
    });
  };
  results = (watchId: string, strict = false) => {
    this.get(watchId);
    return this.db
      .all<{ id: string; data: string }>(
        "SELECT r.issue_id id,r.data FROM issue_watch_results r JOIN issue_watch_scans s ON s.id=r.last_evaluated_scan_id WHERE r.watch_id=? AND s.status='completed' ORDER BY r.last_seen DESC",
        watchId,
      )
      .flatMap((row) => {
        const decode = strict
          ? this.db.records.decode
          : this.db.records.tryDecode;
        const candidate = decode(
          {
            table: "issue_watch_results",
            id: `${watchId}:${row.id}`,
            column: "data",
            source: row.data,
          },
          (value) => {
            const parsed = CandidateSchema.parse(value);
            if (parsed.issue.id !== row.id)
              throw new Error("Saved result identity is inconsistent.");
            return parsed;
          },
        );
        return candidate ? [candidate] : [];
      });
  };
  dismiss = (watchId: string, issueId: string, dismissed: boolean) => {
    const sourceScan = this.candidateLocation(watchId, issueId);
    const row = this.db.all<{ data: string }>(
      "SELECT data FROM issue_watch_results WHERE watch_id=? AND issue_id=?",
      watchId,
      issueId,
    )[0];
    const candidate = row
      ? this.decode(
          "issue_watch_results",
          `${watchId}:${issueId}`,
          row.data,
          CandidateSchema.parse,
        )
      : this.candidate(watchId, sourceScan, issueId);
    candidate.dismissed_at = dismissed ? now() : null;
    if (!row) {
      candidate.eligible = false;
      candidate.claim_state = "eligibility_uncertain";
      candidate.classification = "not_rechecked";
      candidate.uncertainty.push(
        "Local disposition for a provisional candidate; no complete baseline evaluation.",
      );
      this.db.run(
        "INSERT INTO issue_watch_results VALUES(?,?,?,?,?,?,?,?,?)",
        watchId,
        issueId,
        sourceScan,
        null,
        "not_rechecked",
        candidate.dismissed_at,
        now(),
        now(),
        JSON.stringify(candidate),
      );
      return candidate;
    }
    this.db.run(
      "UPDATE issue_watch_results SET dismissed_at=?,data=? WHERE watch_id=? AND issue_id=?",
      candidate.dismissed_at,
      JSON.stringify(candidate),
      watchId,
      issueId,
    );
    return candidate;
  };
  compare = (scan: WatchScan, candidates: WatchCandidate[]) => {
    const watch = this.get(scan.watch_id);
    const previous = new Map(
      this.results(watch.id, true).map((candidate) => [
        candidate.issue.id,
        candidate,
      ]),
    );
    const dispositions = this.dispositions(watch.id);
    const baseline = watch.last_complete_scan_id
      ? this.scan(watch.id, watch.last_complete_scan_id)
      : null;
    for (const candidate of candidates) {
      const old = previous.get(candidate.issue.id);
      if (candidate.classification === "not_rechecked") continue;
      const matchedBefore = this.db.all<{
        last_complete_match_scan_id: string | null;
      }>(
        "SELECT last_complete_match_scan_id FROM issue_watch_results WHERE watch_id=? AND issue_id=?",
        watch.id,
        candidate.issue.id,
      )[0]?.last_complete_match_scan_id;
      candidate.dismissed_at = dispositions.get(candidate.issue.id) ?? null;
      candidate.classification = !candidate.eligible
        ? matchedBefore
          ? "no_longer_eligible"
          : "excluded"
        : !isMatch(candidate)
          ? "manual_review"
          : !baseline
            ? "initial_discovery"
            : baseline.revision !== scan.revision
              ? "criteria_changed"
              : old && isMatch(old)
                ? "existing_match"
                : matchedBefore
                  ? "reentered"
                  : candidate.issue.created_at >
                      (baseline.ended_at || baseline.started_at)
                    ? "new_issue"
                    : "newly_matching";
      if (candidate.classification === "newly_matching" && !old)
        candidate.reasons.push(
          "Newly discovered match; prior eligibility is unknown.",
        );
      if (candidate.classification === "newly_matching" && old) {
        const removed = old.issue.labels.filter(
          (label) =>
            !candidate.issue.labels.some(
              (current) => current.toLowerCase() === label.toLowerCase(),
            ),
        );
        if (removed.length)
          candidate.reasons.push(
            `Previously observed labels removed: ${removed.join(", ")}.`,
          );
        if (old.reasons.some((reason) => reason.includes("excluded tracker")))
          candidate.reasons.push(
            "Previously observed tracker membership no longer excludes this issue in the current verified source set.",
          );
      }
    }
    return candidates;
  };
  finish = (
    scan: WatchScan,
    candidates: WatchCandidate[],
    expectedBaseline: string | null,
  ) =>
    this.db.transaction(() => {
      const watch = this.get(scan.watch_id);
      if (
        watch.current_revision !== scan.revision ||
        watch.last_complete_scan_id !== expectedBaseline
      )
        throw new AdeError(
          "stale_revision",
          "Watch revision or baseline changed before completion.",
        );
      for (const candidate of this.compare(scan, candidates))
        this.saveCandidate(scan, candidate);
      scan.summary = {};
      for (const candidate of candidates)
        scan.summary[candidate.classification] =
          (scan.summary[candidate.classification] || 0) + 1;
      this.saveScan(scan);
      if (scan.status !== "completed") return;
      for (const candidate of candidates) {
        const old = this.db.all<{
          first_seen: string;
          last_complete_match_scan_id: string | null;
        }>(
          "SELECT first_seen,last_complete_match_scan_id FROM issue_watch_results WHERE watch_id=? AND issue_id=?",
          watch.id,
          candidate.issue.id,
        )[0];
        this.db.run(
          "INSERT INTO issue_watch_results VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(watch_id,issue_id) DO UPDATE SET last_evaluated_scan_id=excluded.last_evaluated_scan_id,last_complete_match_scan_id=excluded.last_complete_match_scan_id,classification=excluded.classification,dismissed_at=excluded.dismissed_at,last_seen=excluded.last_seen,data=excluded.data",
          watch.id,
          candidate.issue.id,
          scan.id,
          isMatch(candidate)
            ? scan.id
            : old?.last_complete_match_scan_id || null,
          candidate.classification,
          candidate.dismissed_at,
          old?.first_seen || scan.started_at,
          scan.ended_at!,
          JSON.stringify(candidate),
        );
      }
      this.saveWatch({
        ...watch,
        updated_at: now(),
        last_complete_scan_id: scan.id,
      });
    });
  interrupt = () => {
    for (const row of this.db.all<{ id: string; watch_id: string }>(
      "SELECT id,watch_id FROM issue_watch_scans WHERE status IN('running','cancelling')",
    )) {
      try {
        const scan = this.scan(row.watch_id, row.id);
        this.saveScan({
          ...scan,
          status: "interrupted",
          phase: "Interrupted",
          ended_at: now(),
          error:
            "Core stopped before completion. Collected evidence is retained; retry requires an explicit action.",
        });
      } catch (error) {
        if (!(error instanceof AdeError && error.kind === "corrupt_record"))
          throw error;
        this.db.run(
          "UPDATE issue_watch_scans SET status='interrupted',ended_at=? WHERE id=?",
          now(),
          row.id,
        );
      }
    }
  };
}
