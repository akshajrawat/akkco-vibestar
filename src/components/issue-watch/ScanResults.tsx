import type { CandidateSummary } from "../../../backend/issue-watch/contracts";

export const claimLabel = (state: CandidateSummary["claim_state"]) =>
  ({
    candidate_for_claim_request: "Candidate for claim request",
    possibly_claimed: "Possibly claimed",
    assigned: "Assigned",
    competing_pr_detected: "Competing PR found",
    maintainer_approval_needed: "Maintainer approval needed",
    eligibility_uncertain: "Eligibility uncertain",
    ineligible: "Ineligible",
  })[state] || state;
const groups = [
  [
    "Newly matching",
    ["new_issue", "newly_matching", "reentered", "criteria_changed"],
  ],
  ["Initial discoveries", ["initial_discovery"]],
  ["Existing matches", ["existing_match"]],
  ["Manual review needed", ["manual_review"]],
  ["No longer eligible", ["no_longer_eligible"]],
  ["Not rechecked / unknown", ["not_rechecked"]],
  ["Excluded / did not match", ["excluded"]],
] as const;
const lineage: Partial<Record<CandidateSummary["classification"], string>> = {
  new_issue: "Created after the previous complete scan",
  newly_matching: "Newly matching existing issue",
  reentered: "Reentered eligibility",
  criteria_changed: "Matching after criteria changed",
  initial_discovery: "Initial baseline discovery",
  existing_match: "Previously matching",
  not_rechecked: "Historical evidence · Not rechecked",
};
export const ScanResults = ({
  candidates,
  selected,
  onSelect,
  provisional,
  showDismissed,
}: {
  candidates: CandidateSummary[];
  selected: string;
  onSelect: (id: string) => void;
  provisional: boolean;
  showDismissed: boolean;
}) => {
  const visible = candidates.filter(
    (candidate) => showDismissed || !candidate.dismissed_at,
  );
  return (
    <div
      className="watch-results-list"
      role="listbox"
      aria-label="Discovery results"
      aria-activedescendant={selected ? `watch-result-${selected}` : undefined}
      onKeyDown={(event) => {
        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))
          return;
        const rows = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
            "button[role=option]",
          ),
        ];
        const index = rows.indexOf(event.target as HTMLButtonElement);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? rows.length - 1
              : Math.max(
                  0,
                  Math.min(
                    rows.length - 1,
                    index + (event.key === "ArrowUp" ? -1 : 1),
                  ),
                );
        if (rows[next]) {
          event.preventDefault();
          rows[next].focus();
          rows[next].click();
        }
      }}
    >
      {groups.map(([label, classifications]) => {
        const rows = visible.filter((candidate) =>
          (classifications as readonly string[]).includes(
            candidate.classification,
          ),
        );
        if (!rows.length) return null;
        return (
          <section
            role="group"
            aria-label={label}
            className="watch-result-group"
            key={label}
          >
            <h3>
              {label}
              <span>{rows.length}</span>
            </h3>
            {rows.map((candidate) => (
              <button
                key={candidate.issue.id}
                id={`watch-result-${candidate.issue.id}`}
                role="option"
                aria-selected={candidate.issue.id === selected}
                tabIndex={
                  candidate.issue.id === selected ||
                  (!selected && visible[0]?.issue.id === candidate.issue.id)
                    ? 0
                    : -1
                }
                className={`watch-result ${candidate.issue.id === selected ? "selected" : ""}`}
                onClick={() => onSelect(candidate.issue.id)}
              >
                <div className="watch-result-heading">
                  <span className="watch-issue-number">
                    #{candidate.issue.number}
                  </span>
                  <strong>{candidate.issue.title}</strong>
                  {candidate.dismissed_at && <small>Dismissed</small>}
                </div>
                <div className="watch-result-meta">
                  <span className={`watch-claim ${candidate.claim_state}`}>
                    {provisional && candidate.eligible ? "Provisional · " : ""}
                    {claimLabel(candidate.claim_state)}
                  </span>
                  <span>
                    {candidate.semantic_state === "completed"
                      ? `${candidate.semantic?.difficulty || "unknown"} · ${candidate.semantic?.technical_area || "unspecified"}`
                      : "GitHub evidence"}
                  </span>
                </div>
                <p>
                  {candidate.semantic_state === "completed"
                    ? candidate.semantic?.why_it_matches
                    : candidate.reasons[0] ||
                      candidate.uncertainty[0] ||
                      "No competing work detected in the checked sources; recheck before requesting assignment."}
                </p>
                <small
                  title={`Created ${candidate.issue.created_at} · Updated ${candidate.issue.updated_at}`}
                >
                  {lineage[candidate.classification] || candidate.reasons[0]} ·{" "}
                  {candidate.evidence_count} evidence items
                </small>
              </button>
            ))}
          </section>
        );
      })}
      {!visible.length && (
        <div className="watch-empty">
          <h3>No newly matching issues found in the checked candidate set.</h3>
          <p>
            Results appear after an explicit scan. This does not imply that no
            suitable issue exists in the repository.
          </p>
        </div>
      )}
    </div>
  );
};
