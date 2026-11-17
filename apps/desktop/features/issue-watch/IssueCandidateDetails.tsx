import { useEffect, useState } from "react";
import { Copy, Play, X } from "lucide-react";

import { rpc, errorMessage } from "../../lib/api";
import type { CandidateDetail } from "./types";
import { Button } from "../../components/ui/button";
import { availabilityState, claimLabel } from "./availability";
import { IssueGitHubLink, verifiedIssueUrl } from "./IssueGitHubLink";

export const IssueCandidateDetails = ({
  watchId,
  scanId,
  issueId,
  revision,
  provisional,
  startTask,
  recheck,
  dismissed,
  close,
}: {
  watchId: string;
  scanId: string;
  issueId: string;
  revision: string;
  provisional: boolean;
  startTask: (url: string, notes: string) => void;
  recheck: (id: string) => void;
  dismissed: () => void;
  close: () => void;
}) => {
  const [detail, setDetail] = useState<CandidateDetail | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError("");
    setCopied(false);

    void rpc<CandidateDetail>("issueWatch.candidateDetail", {
      watch_id: watchId,
      scan_id: scanId,
      issue_id: issueId,
    })
      .then((value) => {
        if (alive) setDetail(value);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });

    return () => {
      alive = false;
    };
  }, [watchId, scanId, issueId, revision]);

  if (!detail)
    return (
      <aside className="watch-candidate-details">
        <p role="status">{error || "Loading saved issue…"}</p>
      </aside>
    );
  const { candidate } = detail;
  const claim = availabilityState(candidate, provisional);
  const issue = candidate.issue;

  const changeDismissal = async () => {
    setBusy(true);
    setError("");
    try {
      await rpc("issueWatch.dismissCandidate", {
        watch_id: watchId,
        issue_id: issue.id,
        dismissed: !candidate.dismissed_at,
      });

      dismissed();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="watch-candidate-details" aria-label="Selected issue details">
      <div className="watch-details-heading">
        <div>
          <small>
            {issue.repository} · #{issue.number}
          </small>
          <h2>{issue.title}</h2>
          <IssueGitHubLink issue={issue} onError={setError} />
        </div>

        <Button variant="ghost" size="icon" aria-label="Collapse issue details" onClick={close}>
          <X size={14} />
        </Button>
      </div>

      <div className="watch-details-scroll">
        <section className="watch-availability">
          <h3>Availability</h3>
          <span className={`watch-claim ${claim}`}>{claimLabel(claim)}</span>
          <p className="subtle">
            {claim === "candidate_for_claim_request"
              ? "No assignment or competing work found in the checked sources. Request assignment on GitHub."
              : candidate.reasons[0] ||
                candidate.uncertainty[0] ||
                "Recheck the issue before requesting assignment."}
          </p>
          {provisional && (
            <p className="warning">Incomplete scan. Availability needs rechecking.</p>
          )}
          <small>Checked {new Date(candidate.checked_at).toLocaleString()}</small>
          <p className="subtle">Availability can change after this check.</p>
        </section>
        <div className="watch-detail-actions">
          <Button size="sm" disabled={busy} onClick={() => recheck(issue.id)}>
            Recheck eligibility
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void navigator.clipboard
                .writeText(issue.url)
                .then(() => setCopied(true))
                .catch((e) => setError(errorMessage(e)))
            }
          >
            <Copy size={13} /> {copied ? "Copied" : "Copy URL"}
          </Button>
        </div>
        <details>
          <summary>Why this status</summary>
          <ul>
            {[...candidate.reasons, ...candidate.uncertainty].map((reason, index) => (
              <li key={index}>{reason}</li>
            ))}
          </ul>
          {!candidate.reasons.length && !candidate.uncertainty.length && (
            <p>No exclusions or competing work detected in the checked sources.</p>
          )}
          <p className="subtle">
            {candidate.evidence.length} saved evidence items. Full scan coverage is available in the
            Coverage tab.
          </p>
        </details>

        {error && (
          <p className="error-box" role="alert">
            {error}
          </p>
        )}
      </div>

      <footer className="watch-details-footer">
        <Button
          variant="default"
          title="Open the task form and confirm creation there"
          disabled={!verifiedIssueUrl(issue)}
          onClick={() =>
            startTask(
              issue.url,
              `Issue Watch discovery for ${issue.repository}#${issue.number}.\n${candidate.semantic_state === "completed" ? candidate.semantic?.why_it_matches || "" : ""}\nClaimability: ${claimLabel(claim)}. Recheck GitHub and request assignment separately.`,
            )
          }
        >
          <Play size={13} />
          Create task
        </Button>
        <div>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void changeDismissal()}>
            {candidate.dismissed_at ? "Restore locally" : "Dismiss locally"}
          </Button>
        </div>
      </footer>
    </aside>
  );
};
