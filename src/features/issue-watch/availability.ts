import type { WatchCandidate } from "../../../backend/issue-watch/contracts";

export const claimLabel = (state: string) =>
  ({
    candidate_for_claim_request: "Available to request",
    assigned: "Already assigned",
    possibly_claimed: "Possibly claimed",
    competing_pr_detected: "Competing PR",
    maintainer_approval_needed: "Approval needed",
    eligibility_uncertain: "Recheck needed",
    ineligible: "Not eligible",
  })[state] || state;

/** Incomplete or historical coverage cannot promote a saved positive claim. */
export const availabilityState = (
  candidate: Pick<WatchCandidate, "claim_state" | "classification" | "uncertainty" | "eligible">,
  provisional: boolean,
) => {
  if (candidate.classification === "not_rechecked") return "eligibility_uncertain";
  if (
    candidate.claim_state === "candidate_for_claim_request" &&
    (provisional || candidate.uncertainty.length > 0)
  )
    return "eligibility_uncertain";
  return candidate.claim_state;
};
