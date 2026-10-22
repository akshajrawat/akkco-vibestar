import { now } from "../domain";
import type { GitHubClient } from "../github/client";
import {
  IssueSearch,
  CollectionLimit,
  issueQuery,
  verifyIssueIdentity,
  type GitHubReadPool,
} from "../github/issue-search";
import { contributionPolicy, issueContext } from "../github/issue-context";
import type {
  WatchCandidate,
  WatchRevision,
  WatchScan,
  WatchSource,
} from "./contracts";
import { applyContext, hardExclusions, initialCandidate } from "./eligibility";
import { digest, previewRules } from "./rules";
import { trackerExclusions } from "./tracker-exclusions";
import type { IssueWatchStore } from "./store";

export class IssueWatchScanner {
  constructor(
    private readonly store: IssueWatchStore,
    private readonly client: GitHubClient,
    private readonly pool: GitHubReadPool,
    private readonly changed: (scan: WatchScan) => void,
    private readonly screen: (
      scan: WatchScan,
      revision: WatchRevision,
      candidates: WatchCandidate[],
      sources: WatchSource[],
      signal: AbortSignal,
    ) => Promise<void>,
  ) {}
  run = async (scan: WatchScan, signal: AbortSignal) => {
    const watch = this.store.get(scan.watch_id);
    const revision = this.store.revision(watch.id, scan.revision);
    const { rules, limits } = revision.configuration;
    const reader = new IssueSearch(this.client, signal, limits, this.pool);
    const candidates: WatchCandidate[] = [];
    const sources = new Map<string, WatchSource>();
    const save = (source: WatchSource) => {
      sources.set(source.key, source);
      this.store.saveSource(scan, source);
    };
    const progress = (phase: string) => {
      signal.throwIfAborted();
      scan.phase = phase;
      scan.coverage.requests = reader.requests;
      scan.coverage.retained_bytes = reader.bytes;
      this.store.saveScan(scan);
      this.changed(scan);
    };
    const warn = (message: string) => {
      if (scan.coverage.warnings.length < 1000)
        scan.coverage.warnings.push(message.slice(0, 2000));
    };
    try {
      const repository = await reader.repository(
        watch.repository.full_name,
        watch.repository.id,
      );
      const known = new Map(
        this.store
          .results(watch.id, true)
          .map((candidate) => [candidate.issue.id, candidate]),
      );
      if (scan.parent_scan_id)
        for (const candidate of this.store.candidates(
          watch.id,
          scan.parent_scan_id,
        ))
          known.set(candidate.issue.id, candidate);
      if (scan.candidate_ids)
        for (const id of scan.candidate_ids)
          known.set(id, this.store.savedCandidate(watch.id, id));
      const identities = new Map<string, { id: string; number: number }>();
      scan.coverage.query = issueQuery(repository, rules);
      if (scan.candidate_ids) {
        for (const id of scan.candidate_ids) {
          const candidate = known.get(id);
          if (!candidate)
            throw new Error(
              "Selected candidate has no saved identity in this watch.",
            );
          identities.set(id, { id, number: candidate.issue.number });
        }
        warn(
          "Scoped recheck: other watch candidates are not rechecked and the full baseline is preserved.",
        );
      } else {
        for (const candidate of known.values())
          identities.set(candidate.issue.id, {
            id: candidate.issue.id,
            number: candidate.issue.number,
          });
        const discovery = await reader.discover(
          repository,
          scan.coverage.query,
        );
        scan.coverage.search_total = discovery.total;
        scan.coverage.search_complete = discovery.complete;
        for (const warning of discovery.warnings) warn(warning);
        scan.coverage.discovered = discovery.identities.length;
        for (const identity of discovery.identities)
          identities.set(identity.id, identity);
      }
      if (identities.size > limits.max_candidates) {
        scan.coverage.search_complete = false;
        warn(
          "Known-result rechecks and discovery exceed the candidate budget; omitted results are unknown.",
        );
      }
      progress("Verifying current issue metadata");
      for (const identity of [...identities.values()].slice(
        0,
        limits.max_candidates,
      )) {
        try {
          const issue = await reader.issue(repository, identity.number);
          verifyIssueIdentity(issue, identity);
          const candidate = initialCandidate(issue, rules, new Set());
          candidates.push(candidate);
          this.store.saveCandidate(scan, candidate);
          scan.coverage.checked++;
        } catch (error) {
          signal.throwIfAborted();
          scan.coverage.search_complete = false;
          warn(
            `Issue #${identity.number} could not be verified: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      scan.coverage.excluded = candidates.filter(
        (candidate) => !candidate.eligible,
      ).length;
      progress("Verifying tracker exclusions");
      let exclusions: Set<string>;
      try {
        exclusions = await trackerExclusions(
          reader,
          rules,
          save,
          rules.trackers.length && watch.last_complete_scan_id
            ? this.store.sources(watch.id, watch.last_complete_scan_id, true)
            : [],
        );
        if (repository.full_name !== watch.repository.full_name)
          for (const key of [...exclusions]) {
            if (key.startsWith(`${watch.repository.full_name}#`))
              exclusions.add(
                key.replace(watch.repository.full_name, repository.full_name),
              );
          }
        scan.coverage.exclusions_complete = true;
      } catch (error) {
        signal.throwIfAborted();
        scan.status = "blocked";
        scan.error =
          `Required tracker verification failed: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            4000,
          );
        for (const candidate of candidates)
          if (candidate.eligible) {
            candidate.claim_state = "eligibility_uncertain";
            candidate.uncertainty.push(
              "Required tracker is unverified. No new candidate is fully eligible.",
            );
          }
        return;
      }
      for (const candidate of candidates) {
        const reasons = hardExclusions(candidate.issue, rules, exclusions);
        if (reasons.length) {
          candidate.eligible = false;
          candidate.reasons = reasons;
          if (candidate.claim_state !== "assigned")
            candidate.claim_state = "ineligible";
        }
      }
      scan.coverage.excluded = candidates.filter(
        (candidate) => !candidate.eligible,
      ).length;
      const selected = candidates.filter((candidate) => candidate.eligible);
      progress("Collecting claim, PR and contribution evidence");
      const policy = selected.length
        ? await contributionPolicy(reader, repository, save)
        : { complete: true, warnings: [], source_keys: [] };
      scan.coverage.evidence_complete = policy.complete;
      for (const warning of policy.warnings) warn(warning);
      for (const [index, candidate] of selected.entries()) {
        if (index >= limits.max_context_candidates) {
          candidate.uncertainty.push(
            "Detailed context candidate limit reached; discussion was not checked.",
          );
          scan.coverage.evidence_complete = false;
          continue;
        }
        const context = await issueContext(reader, candidate.issue, save);
        scan.coverage.context_checked++;
        if (!context.complete) scan.coverage.evidence_complete = false;
        applyContext(candidate, context.sources, context.evidence, [
          ...context.warnings,
          ...policy.warnings,
        ]);
        candidate.source_keys.push(...policy.source_keys);
        for (const key of policy.source_keys) {
          const source = sources.get(key)!;
          candidate.evidence.push({
            kind: "contribution_policy",
            source_key: key,
            actor: null,
            excerpt: source.text.slice(0, 4000),
            authority: "text_interpretation",
          });
          if (
            candidate.claim_state === "candidate_for_claim_request" &&
            /(?:request|ask)[^\n.]{0,70}assign|assign[^\n.]{0,70}before (?:start|work)|wait for[^\n.]{0,70}(?:approval|maintainer)/i.test(
              source.text,
            )
          )
            candidate.claim_state = "maintainer_approval_needed";
        }
        try {
          const current = await reader.issue(
            repository,
            candidate.issue.number,
          );
          verifyIssueIdentity(current, {
            id: candidate.issue.id,
            number: candidate.issue.number,
          });
          if (digest(current) !== digest(candidate.issue)) {
            candidate.issue = current;
            candidate.uncertainty.push(
              "Issue changed during collection; previous discussion/context may be stale.",
            );
            candidate.claim_state = "eligibility_uncertain";
            scan.coverage.evidence_complete = false;
          }
        } catch {
          signal.throwIfAborted();
          candidate.uncertainty.push(
            "Current issue could not be revalidated after discussion retrieval.",
          );
          candidate.claim_state = "eligibility_uncertain";
          scan.coverage.evidence_complete = false;
        }
        this.store.saveCandidate(scan, candidate);
        progress(
          `Checked context ${scan.coverage.context_checked}/${Math.min(selected.length, limits.max_context_candidates)}`,
        );
      }
      const semanticNeeded = Boolean(
        previewRules({
          repository: repository.full_name,
          prompt: revision.configuration.prompt,
        }).preferences.replace(/[\s.,;]+/g, "") || scan.instruction_override,
      );
      const semanticCandidates = candidates.filter(
        (candidate) =>
          candidate.eligible && candidate.source_keys.length && semanticNeeded,
      );
      for (const candidate of semanticCandidates)
        candidate.semantic_state = "pending";
      scan.coverage.semantic_complete = semanticCandidates.length === 0;
      if (semanticCandidates.length) {
        progress("Preparing semantic screening");
        await this.screen(
          scan,
          revision,
          semanticCandidates,
          [...sources.values()],
          signal,
        );
      }
      signal.throwIfAborted();
      progress("Rechecking eligibility before saving");
      for (const candidate of candidates.filter(
        (item) => item.eligible && item.source_keys.length,
      )) {
        try {
          const current = await reader.issue(
            repository,
            candidate.issue.number,
          );
          verifyIssueIdentity(current, {
            id: candidate.issue.id,
            number: candidate.issue.number,
          });
          if (digest(current) !== digest(candidate.issue)) {
            candidate.issue = current;
            candidate.claim_state = "eligibility_uncertain";
            candidate.uncertainty.push(
              "Issue changed during screening; saved semantic/discussion evidence may be stale. Recheck explicitly.",
            );
            scan.coverage.evidence_complete = false;
            if (candidate.semantic_state === "completed") {
              candidate.semantic_state = "unavailable";
              scan.coverage.semantic_complete = false;
            }
          }
          candidate.checked_at = now();
        } catch {
          signal.throwIfAborted();
          candidate.claim_state = "eligibility_uncertain";
          candidate.uncertainty.push(
            "Final eligibility recheck was unavailable; no complete coverage is claimed.",
          );
          scan.coverage.evidence_complete = false;
        }
      }
      progress("Validating hard rules");
      for (const candidate of candidates) {
        const reasons = hardExclusions(candidate.issue, rules, exclusions);
        if (reasons.length) {
          candidate.eligible = false;
          candidate.reasons = reasons;
          if (candidate.claim_state !== "assigned")
            candidate.claim_state = "ineligible";
        }
      }
      scan.coverage.excluded = candidates.filter(
        (candidate) =>
          hardExclusions(candidate.issue, rules, exclusions).length > 0 ||
          (!candidate.eligible &&
            ["ineligible", "competing_pr_detected"].includes(
              candidate.claim_state,
            )),
      ).length;
      const checked = new Set(
        candidates.map((candidate) => candidate.issue.id),
      );
      for (const old of known.values())
        if (!checked.has(old.issue.id)) {
          candidates.push({
            ...old,
            classification: "not_rechecked",
            uncertainty: [
              ...old.uncertainty,
              "Not rechecked in this attempt; previous evidence is historical.",
            ],
            source_keys: [],
          });
          scan.coverage.search_complete = false;
        }
      scan.status =
        scan.coverage.search_complete &&
        scan.coverage.exclusions_complete &&
        scan.coverage.evidence_complete &&
        scan.coverage.semantic_complete
          ? "completed"
          : "partial";
    } catch (error) {
      scan.status = signal.aborted
        ? "cancelled"
        : error instanceof CollectionLimit
          ? "partial"
          : "failed";
      scan.error = signal.aborted
        ? "Cancelled. Collected evidence was retained; baseline unchanged."
        : (error instanceof Error ? error.message : String(error)).slice(
            0,
            4000,
          );
    } finally {
      if (signal.aborted) scan.status = "cancelled";
      scan.phase =
        scan.status === "completed"
          ? "Complete"
          : scan.status[0].toUpperCase() + scan.status.slice(1);
      scan.ended_at = now();
      scan.coverage.requests = reader.requests;
      scan.coverage.retained_bytes = reader.bytes;
      this.store.finish(scan, candidates, watch.last_complete_scan_id);
      this.changed(scan);
    }
  };
}
