import { useEffect, useState } from "react";
import { ArrowUpRight, Copy, Play, X } from "lucide-react";
import { rpc, errorMessage } from "../../lib/api";
import type { CandidateDetail } from "./types";
import { Button } from "../../components/ui/button";
import { IssueMarkdown } from "./IssueMarkdown";
import { claimLabel } from "./ScanResults";

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
  const { candidate, sources } = detail;
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
        </div>
        <Button variant="ghost" size="icon" aria-label="Collapse issue details" onClick={close}>
          <X size={14} />
        </Button>
      </div>
      <div className="watch-details-scroll">
        <span className={`watch-claim ${candidate.claim_state}`}>
          {claimLabel(candidate.claim_state)}
        </span>
        {provisional && (
          <p className="warning">
            Provisional coverage. This scan did not replace the last complete baseline.
          </p>
        )}
        <p className="subtle">
          Checked {new Date(candidate.checked_at).toLocaleString()}. GitHub can change before you
          request assignment; unassigned does not guarantee availability.
        </p>
        <div className="watch-detail-actions">
          <Button
            size="sm"
            onClick={() =>
              void window.vibestar.openExternal(issue.url).catch((e) => setError(errorMessage(e)))
            }
          >
            <ArrowUpRight size={13} />
            Open on GitHub
          </Button>
          <Button
            size="sm"
            onClick={() =>
              void navigator.clipboard
                .writeText(issue.url)
                .then(() => setCopied(true))
                .catch((e) => setError(errorMessage(e)))
            }
          >
            <Copy size={13} />
            {copied ? "Copied" : "Copy URL"}
          </Button>
        </div>
        <dl className="watch-facts">
          <div>
            <dt>Labels</dt>
            <dd>{issue.labels.join(", ") || "None"}</dd>
          </div>
          <div>
            <dt>Assignees</dt>
            <dd>{issue.assignees.map((actor) => `@${actor}`).join(", ") || "Unassigned"}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{new Date(issue.created_at).toLocaleString()}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{new Date(issue.updated_at).toLocaleString()}</dd>
          </div>
        </dl>
        <section>
          <h3>Why it matches</h3>
          {candidate.semantic && candidate.semantic_state === "completed" ? (
            <>
              <p>{candidate.semantic.why_it_matches}</p>
              <p className="subtle">
                AI estimate · {candidate.semantic.technical_area} · {candidate.semantic.difficulty}{" "}
                difficulty
              </p>
            </>
          ) : (
            <p>No complete AI assessment. The status above comes from saved GitHub evidence.</p>
          )}
        </section>
        <details open>
          <summary>Eligibility and exclusion analysis</summary>
          <ul>
            {candidate.reasons.map((reason, index) => (
              <li key={index}>{reason}</li>
            ))}
          </ul>
          {!candidate.reasons.length && <p>No hard exclusion detected in the checked sources.</p>}
          <p>
            {claimLabel(candidate.claim_state)}. Claims and policy text remain interpretations
            unless marked as GitHub facts.
          </p>
        </details>
        {candidate.uncertainty.length > 0 && (
          <section className="watch-unknowns">
            <h3>Unknowns and limitations</h3>
            <ul>
              {candidate.uncertainty.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </section>
        )}
        <details open>
          <summary>Original issue description</summary>
          <IssueMarkdown text={issue.body} onError={setError} />
        </details>
        <details open>
          <summary>
            Claims and competing work ·{" "}
            {candidate.evidence.filter((item) => item.kind !== "contribution_policy").length}
          </summary>
          {candidate.evidence
            .filter((item) => item.kind !== "contribution_policy")
            .map((item, index) => {
              const source = sources.find((entry) => entry.key === item.source_key);
              return (
                <article className="watch-evidence" key={index}>
                  <strong>{item.kind.replaceAll("_", " ")}</strong>
                  <small>
                    {item.actor ? `@${item.actor}` : "GitHub evidence"} ·{" "}
                    {item.authority === "github_fact" ? "Retrieved fact" : "Text interpretation"}
                    {source?.created_at ? ` · ${new Date(source.created_at).toLocaleString()}` : ""}
                  </small>
                  <blockquote>{item.excerpt}</blockquote>
                  {source && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void window.vibestar
                          .openExternal(source.url)
                          .catch((e) => setError(errorMessage(e)))
                      }
                    >
                      Open source
                    </Button>
                  )}
                </article>
              );
            })}
          {!candidate.evidence.length && (
            <p>No claim evidence was available; inspect coverage and unknowns above.</p>
          )}
        </details>
        <details>
          <summary>
            Relevant original discussion ·{" "}
            {sources.filter((source) => source.kind === "comment").length} comments retained
          </summary>
          {sources
            .filter((source) => source.kind === "comment")
            .map((source) => (
              <article className="watch-evidence" key={source.key}>
                <strong>@{source.actor || "unknown"}</strong>
                <small>
                  {source.association || "Association unavailable"} ·{" "}
                  {source.created_at && new Date(source.created_at).toLocaleString()}
                </small>
                <IssueMarkdown text={source.text} onError={setError} />
              </article>
            ))}
        </details>
        <details>
          <summary>Contribution policy and source evidence</summary>
          {sources.map((source) => (
            <article className="watch-evidence" key={source.key}>
              <strong>{source.kind.replaceAll("_", " ")}</strong>
              <small>
                {source.complete ? "Retained source" : "Incomplete source"} ·{" "}
                {new Date(source.fetched_at).toLocaleString()}
              </small>
              {source.kind === "policy" && <IssueMarkdown text={source.text} onError={setError} />}
              <code title={source.hash}>{source.hash.slice(0, 16)}…</code>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void window.vibestar
                    .openExternal(source.url)
                    .catch((e) => setError(errorMessage(e)))
                }
              >
                View on GitHub
              </Button>
            </article>
          ))}
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
          onClick={() =>
            startTask(
              issue.url,
              `Issue Watch discovery for ${issue.repository}#${issue.number}.\n${candidate.semantic_state === "completed" ? candidate.semantic?.why_it_matches || "" : ""}\nClaimability: ${claimLabel(candidate.claim_state)}. Recheck GitHub and request assignment separately.`,
            )
          }
        >
          <Play size={13} />
          Start Vibestar Task
        </Button>
        <small>Opens the existing task form. You confirm creation there.</small>
        <div>
          <Button size="sm" disabled={busy} onClick={() => recheck(issue.id)}>
            Recheck eligibility
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void changeDismissal()}>
            {candidate.dismissed_at ? "Restore locally" : "Dismiss locally"}
          </Button>
        </div>
      </footer>
    </aside>
  );
};
