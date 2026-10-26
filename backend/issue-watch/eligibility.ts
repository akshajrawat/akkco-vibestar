import { now } from "../domain";
import type {
  ClaimEvidence,
  IssueSnapshot,
  WatchCandidate,
  WatchRules,
  WatchSource,
} from "./contracts";
import { issueKey } from "./rules";

export const hardExclusions = (
  issue: IssueSnapshot,
  rules: WatchRules,
  trackerKeys: Set<string>,
) => {
  const reasons: string[] = [];
  if (issue.pull_request) reasons.push("GitHub identified this item as a pull request.");
  if (issue.state !== "open") reasons.push("Issue is closed.");
  const labels = issue.labels.filter((label) =>
    rules.excluded_labels.includes(label.trim().toLowerCase()),
  );
  if (labels.length) reasons.push(`Excluded labels: ${labels.join(", ")}.`);
  const key = issueKey({ repository: issue.repository, number: issue.number });
  if (rules.excluded_issues.some((reference) => issueKey(reference) === key))
    reasons.push("Explicitly excluded issue.");
  if (trackerKeys.has(key))
    reasons.push("Referenced by a freshly verified excluded tracker, or is the tracker itself.");
  if (rules.unassigned_only && issue.assignees.length)
    reasons.push(`Assigned to ${issue.assignees.map((actor) => `@${actor}`).join(", ")}.`);
  return reasons;
};

export const assessClaims = (sources: WatchSource[]) => {
  const evidence: ClaimEvidence[] = [];
  const claims = new Set<string>();
  const grants = new Set<string>();
  const warnings: string[] = [];
  let wait = false;
  for (const source of sources
    .filter((item) => item.kind === "comment")
    .sort(
      (a, b) =>
        (a.created_at || "").localeCompare(b.created_at || "") || a.key.localeCompare(b.key),
    )) {
    if (!source.actor) continue;
    const actor = source.actor.toLowerCase();
    const text = source.text.trim();
    const add = (kind: ClaimEvidence["kind"]) =>
      evidence.push({
        kind,
        source_key: source.key,
        actor: source.actor,
        excerpt: text.slice(0, 4000),
        authority: "text_interpretation",
      });
    if (
      /\b(?:i (?:am|have|will|would like to|want to|can)|i'm|please assign (?:this (?:issue )?to )?me|can i)\b[^\n.!?]{0,100}\b(?:work(?:ing)?|assign|implement|fix|take)\b|\bplease assign (?:this (?:issue )?to )?me\b/i.test(
        text,
      )
    ) {
      claims.add(actor);
      add("claim_request");
      if (source.created_at !== source.updated_at)
        warnings.push("An edited claim needs manual interpretation; age does not expire it.");
    }
    if (
      /\b(?:i (?:am no longer|cannot|can't|will not|won't)|i'm no longer|withdraw(?:ing)? my claim|unassign me)\b/i.test(
        text,
      )
    ) {
      claims.delete(actor);
      grants.delete(actor);
      add("claim_withdrawal");
    }
    const grant = text.match(
      /@([\w-]+)[,\s]+(?:you (?:can|may)|please)\s+(?:work|take|start|proceed)|(?:assign(?:ed|ing) (?:this )?to)\s+@([\w-]+)/i,
    );
    if (["OWNER", "MEMBER", "COLLABORATOR"].includes(source.association || "")) {
      if (grant) {
        grants.add((grant[1] || grant[2]).toLowerCase());
        add("maintainer_grant");
      }
      if (
        /\b(?:please wait|do not start|don't start|wait for (?:approval|assignment)|needs? (?:maintainer )?approval)\b/i.test(
          text,
        )
      ) {
        wait = true;
        add("maintainer_wait");
      }
    } else if (grant)
      warnings.push(
        "An assignment instruction came from an actor without verified maintainer authority.",
      );
  }
  return {
    evidence,
    possible: claims.size > 0,
    confirmed: grants.size > 0,
    wait,
    warnings,
  };
};

export const initialCandidate = (
  issue: IssueSnapshot,
  rules: WatchRules,
  trackerKeys: Set<string>,
): WatchCandidate => {
  const reasons = hardExclusions(issue, rules, trackerKeys);
  return {
    issue,
    checked_at: now(),
    eligible: reasons.length === 0,
    claim_state: reasons.length
      ? rules.unassigned_only && issue.assignees.length
        ? "assigned"
        : "ineligible"
      : "eligibility_uncertain",
    reasons,
    uncertainty: [],
    evidence: [],
    source_keys: [],
    semantic_state: "not_needed",
    semantic: null,
    classification: reasons.length ? "excluded" : "manual_review",
    dismissed_at: null,
  };
};
export const applyContext = (
  candidate: WatchCandidate,
  sources: WatchSource[],
  evidence: ClaimEvidence[],
  warnings: string[],
) => {
  const claims = assessClaims(sources);
  candidate.source_keys = sources.map((source) => source.key);
  candidate.evidence = [...evidence, ...claims.evidence];
  candidate.uncertainty = [...warnings, ...claims.warnings];
  if (candidate.issue.assignees.length) {
    candidate.claim_state = "assigned";
  } else if (evidence.some((item) => item.kind === "open_pr")) {
    candidate.eligible = false;
    candidate.claim_state = "competing_pr_detected";
    candidate.reasons.push("Confirmed open competing PR with a closing reference.");
  } else if (claims.confirmed) {
    candidate.eligible = false;
    candidate.claim_state = "ineligible";
    candidate.reasons.push(
      "A retrieved maintainer grant indicates an active claim; recheck on GitHub before proceeding.",
    );
  } else if (claims.possible) candidate.claim_state = "possibly_claimed";
  else if (claims.wait) candidate.claim_state = "maintainer_approval_needed";
  else if (candidate.uncertainty.length) candidate.claim_state = "eligibility_uncertain";
  else candidate.claim_state = "candidate_for_claim_request";
  return candidate;
};
export const isMatch = (candidate: WatchCandidate) =>
  candidate.eligible &&
  candidate.claim_state === "candidate_for_claim_request" &&
  candidate.semantic_state !== "pending" &&
  candidate.semantic_state !== "unavailable" &&
  candidate.semantic_state !== "invalid" &&
  (!candidate.semantic || candidate.semantic.relevance === "match");
