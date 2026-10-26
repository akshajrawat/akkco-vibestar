import { useEffect, useState } from "react";
import type { ScheduleJob } from "../../../backend/scheduled/contracts";
import { discussionEntries } from "../../../backend/scheduled/action";
import type { UsageRecord } from "../../../backend/execution/output/usage";
import { rpc, errorMessage } from "../../lib/api";
import { duration, tokenUsage } from "../../lib/format";
import { Button } from "../../components/ui/button";
import { AgentResponse } from "../chat/AgentResponse";
import { RunPrompt } from "../chat/RunPrompt";
import type { Run } from "../../lib/types";
import type { Settings, Repository } from "../../../backend/domain";
import type { RepairSession } from "../../../backend/review/repair/contracts";
import { SolveReview } from "./repair/SolveReview";
import { containDialogFocus, navigateTabs } from "../../lib/keyboard";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import type { PRAnalysisSession, ReviewAction } from "../../../backend/review/pr/contracts";
export const prTone = (job: ScheduleJob) =>
  ["analyzing", "polling", "pending"].includes(job.status)
    ? "running"
    : job.status === "interrupted"
      ? "warning"
      : job.error
        ? "failure"
        : ["analyzing", "polling", "pending"].includes(job.status)
          ? "running"
          : job.action?.conversationState === "blocked"
            ? "failure"
            : job.action?.manualActionRequired
              ? "warning"
              : ["approved", "merged"].includes(job.action?.conversationState || "")
                ? "success"
                : ["waiting_for_ci", "waiting_for_reviewer"].includes(
                      job.action?.conversationState || "",
                    ) || ["analyzing", "polling"].includes(job.status)
                  ? "running"
                  : "healthy";
export const PrState = ({ job }: { job: ScheduleJob }) => {
  const state = job.action?.conversationState;
  const label =
    job.status === "analyzing"
      ? "ANALYZING DISCUSSION"
      : job.status === "polling"
        ? "CHECKING PR"
        : job.status === "pending"
          ? "ANALYSIS QUEUED"
          : job.status === "interrupted"
            ? "ANALYSIS INTERRUPTED"
            : job.error
              ? "INSPECTION FAILED"
              : state === "blocked"
                ? job.attention_source === "ci"
                  ? "CI FAILED"
                  : "BLOCKED"
                : job.action?.manualActionRequired
                  ? "ACTION REQUIRED"
                  : state === "waiting_for_reviewer"
                    ? "WAITING FOR REVIEW"
                    : state === "waiting_for_ci"
                      ? "CI RUNNING"
                      : state === "approved"
                        ? "APPROVED"
                        : state === "merged"
                          ? "MERGED"
                          : state === "closed"
                            ? "CLOSED"
                            : job.last_checked_at
                              ? job.action
                                ? "NO ACTION REQUIRED"
                                : "GITHUB INSPECTED"
                              : "AWAITING CHECK";
  return (
    <span className={`pr-state ${prTone(job)}`}>
      {prTone(job) === "success" ? "✓" : state === "blocked" ? "×" : "●"} {label}
    </span>
  );
};
export const PrDetails = ({
  job,
  close,
  configuration,
  repositories = [],
  repairs = [],
  settings,
  openRepair,
  refresh,
}: {
  job: ScheduleJob;
  close: () => void;
  configuration?: Settings["utility_ai"];
  repositories?: Repository[];
  repairs?: RepairSession[];
  settings?: Settings;
  openRepair?: (id: string) => void;
  refresh?: () => Promise<void>;
}) => {
  const [tab, setTab] = useState("Overview");
  const [selected, setSelected] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [analyses, setAnalyses] = useState<PRAnalysisSession[]>([]);
  const [runs, setRuns] = useState<(Run & { analysis_id: string | null })[]>([]);
  const [usage, setUsage] = useState<UsageRecord[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [solve, setSolve] = useState(false);
  const dialog = useDialogFocus();
  const [raw, setRaw] = useState<{ text: string; truncated: boolean }>();
  const analysis = analyses.find((a) => a.id === selected) || analyses[0];
  const snapshot = analysis?.snapshot || job.pending_snapshot || job.last_snapshot;
  const report = analysis?.report;
  const running = ["polling", "analyzing"].includes(job.status);
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      rpc<{
        analyses: PRAnalysisSession[];
        runs: typeof runs;
        usage: UsageRecord[];
      }>("scheduled.detail", { id: job.id })
        .then((detail) => {
          if (alive) {
            setAnalyses(detail.analyses);
            setRuns(detail.runs);
            setUsage(detail.usage);
          }
        })
        .catch((e) => {
          if (alive) setError(errorMessage(e));
        });
    void refresh();
    const timer = running ? setInterval(() => void refresh(), 1000) : undefined;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [job.id, job.last_checked_at, job.last_analyzed_at, job.status, running]);
  useEffect(() => {
    if (tab === "Conversation" && sourceId)
      document.getElementById(`pr-source-${sourceId}`)?.scrollIntoView?.({ block: "nearest" });
  }, [tab, sourceId]);
  const act = async (method: string, params: unknown) => {
    setBusy(true);
    try {
      await rpc(method, params);
      setSelected("");
      setRaw(undefined);
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const showSource = (id: string) => {
    setSourceId(id);
    setTab("Conversation");
  };
  const renderAction = (action: ReviewAction, index: number) => (
    <article className="discussion-entry" key={action.id}>
      <header>
        <strong>
          {index + 1}. {action.classification.replaceAll("_", " ")}
        </strong>
        <small>
          @{action.reviewer} · {action.priority} priority · {action.confidence} confidence
        </small>
      </header>
      <blockquote>
        <AgentResponse text={action.originalText} />
      </blockquote>
      <p>{action.recommendedAction}</p>
      <p>
        <strong>Response:</strong> {action.responseState.replaceAll("_", " ")} ·{" "}
        <strong>Code:</strong> unverified
      </p>
      <p className="subtle">
        {action.threadResolved === null
          ? "Top-level discussion"
          : action.threadResolved
            ? "GitHub thread resolved; code correctness is unverified"
            : "GitHub thread unresolved"}
        {action.outdated ? " · Outdated diff lines" : ""}
      </p>
      {action.affectedFiles.map((path) => (
        <code key={path}>{path} </code>
      ))}
      <p>{action.evidence}</p>
      <p>
        Evidence:{" "}
        {action.evidenceIds.map((id) => (
          <button key={id} onClick={() => showSource(id)}>
            {id}{" "}
          </button>
        ))}
      </p>
      <div className="actions">
        <Button size="sm" onClick={() => showSource(action.sourceId)}>
          Original review
        </Button>
        {action.sourceUrl && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void window.vibestar.openExternal(action.sourceUrl!)}
          >
            GitHub source
          </Button>
        )}
      </div>
      <small>
        Action {action.id} · source {action.sourceId}
      </small>
      {!!action.authorReplyIds.length && (
        <p>
          Author replies:{" "}
          {action.authorReplyIds.map((id) => (
            <button key={id} onClick={() => showSource(id)}>
              {id}{" "}
            </button>
          ))}
        </p>
      )}
      {!!action.reviewerAcknowledgmentIds.length && (
        <p>
          Reviewer acknowledgments:{" "}
          {action.reviewerAcknowledgmentIds.map((id) => (
            <button key={id} onClick={() => showSource(id)}>
              {id}{" "}
            </button>
          ))}
        </p>
      )}
      {!!action.commitShas.length && (
        <p className="mono">
          Possible code evidence: {action.commitShas.join(", ")} · A commit is not verification.
        </p>
      )}
    </article>
  );
  const considerations =
    report?.actions.filter(
      (a) => !["positive_feedback", "informational"].includes(a.classification),
    ) || [];
  const outstanding = considerations.filter(
    (a) => a.responseState !== "answered" && !a.reviewerAcknowledgmentIds.length,
  );
  return (
    <div
      className="modal-backdrop pr-detail-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        className="pr-details"
        role="dialog"
        aria-modal="true"
        aria-label="Pull request details"
        ref={dialog}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
          containDialogFocus(e);
        }}
      >
        <div className="modal-heading">
          <div>
            <strong>{job.url.replace("https://github.com/", "").replace("/pull/", " #")}</strong>
            <h2>{snapshot?.title || job.title || "Pull request"}</h2>
            <PrState job={job} />
          </div>
          <Button variant="ghost" aria-label="Close PR details" onClick={close}>
            ×
          </Button>
        </div>
        <div
          className="workspace-tabs"
          role="tablist"
          aria-label="PR detail views"
          onKeyDown={navigateTabs}
        >
          {[
            "Overview",
            "Conversation",
            "Action items",
            "Checks",
            "Analysis history",
            "Repair sessions",
          ].map((name) => (
            <button
              type="button"
              role="tab"
              aria-selected={name === tab}
              tabIndex={name === tab ? 0 : -1}
              key={name}
              className={name === tab ? "selected" : ""}
              onClick={() => setTab(name)}
            >
              {{
                Conversation: "Full Conversation",
                "Action items": "Review Actions",
                Checks: "CI / Checks",
                "Analysis history": "Analysis History",
                "Repair sessions": "Repair Sessions",
              }[name] || name}
            </button>
          ))}
        </div>
        <div className="pr-details-content">
          {tab === "Repair sessions" && (
            <>
              <h3>Isolated review repair sessions</h3>
              {repairs
                .filter((repair) => repair.job_id === job.id)
                .map((repair) => (
                  <article className="discussion-entry" key={repair.id}>
                    <strong>
                      PR #{repair.identity.number} · {repair.status.replaceAll("_", " ")}
                    </strong>
                    <p>
                      {repair.actions.length} selected review items ·{" "}
                      {new Date(repair.created_at).toLocaleString()}
                    </p>
                    <code>{repair.workspace.worktree_path}</code>
                    <Button
                      disabled={!openRepair}
                      onClick={() => {
                        close();
                        openRepair?.(repair.id);
                      }}
                    >
                      Open repair workspace
                    </Button>
                  </article>
                ))}
              {!repairs.some((repair) => repair.job_id === job.id) && (
                <p className="empty-row">
                  No repairs yet. Analyze the PR, then select Solve Review.
                </p>
              )}
            </>
          )}
          {error && (
            <p className="error-box" role="alert">
              {error}
            </p>
          )}
          {analysis?.status === "running" && (
            <p className="running" role="status">
              {analysis.phase} · {analysis.configuration.provider} ·{" "}
              {analysis.configuration.model || "CLI default"} · {analysis.configuration.effort}
            </p>
          )}
          {analysis?.error && (
            <p className="warning-box">
              {analysis.phase}: {analysis.error}. Previous reports remain in Analysis history.
            </p>
          )}
          {report && !report.complete && (
            <p className="warning-box">
              Partial analysis. Every request has not been assessed. Inspect coverage warnings
              before acting.
            </p>
          )}
          {report?.warnings.map((warning, index) => (
            <p className="warning" key={index}>
              {warning}
            </p>
          ))}
          {!report &&
            snapshot?.coverage?.warnings.map((warning, index) => (
              <p className="warning" key={index}>
                {warning}
              </p>
            ))}
          {tab === "Overview" && (
            <>
              <h3>PR overview</h3>
              <dl className="repository-facts">
                <dt>Author</dt>
                <dd>{snapshot?.author ? "@" + snapshot.author : "Not inspected"}</dd>
                <dt>Authenticated viewer</dt>
                <dd>
                  {snapshot?.authenticatedUser ? "@" + snapshot.authenticatedUser : "Not inspected"}
                </dd>
                <dt>Head</dt>
                <dd>
                  {snapshot?.identity?.headRepository} · {snapshot?.identity?.headBranch}{" "}
                  <code>{snapshot?.headRefOid}</code>
                </dd>
                <dt>Base</dt>
                <dd>
                  {snapshot?.identity?.baseRepository} · {snapshot?.identity?.baseBranch}{" "}
                  <code>{snapshot?.baseRefOid}</code>
                </dd>
                <dt>Review / merge</dt>
                <dd>
                  {snapshot?.reviewDecision || "Unknown"} · {snapshot?.mergeable || "Unknown"}
                </dd>
                <dt>Latest discussion activity</dt>
                <dd>{(snapshot && discussionEntries(snapshot).at(-1)?.createdAt) || "Unknown"}</dd>
              </dl>
              <h3>{report?.summary || "No engineering report saved"}</h3>
              {report && (
                <details open={!report.complete || undefined}>
                  <summary>
                    Discussion coverage ·{" "}
                    {report.coverage.filter((entry) => entry.disposition !== "deferred").length}/
                    {snapshot ? discussionEntries(snapshot).length : report.coverage.length} sources
                    assessed
                  </summary>
                  {report.coverage.map((entry) => (
                    <p key={entry.sourceId}>
                      <button onClick={() => showSource(entry.sourceId)}>{entry.sourceId}</button> ·{" "}
                      {entry.disposition} · {entry.segmentIds.length} segments · {entry.reason}
                    </p>
                  ))}
                </details>
              )}
              <p>
                {report
                  ? `${considerations.length} observations require consideration; ${outstanding.length} remain unanswered or unacknowledged. Code correctness remains unverified.`
                  : "Click Analyze PR to retrieve fresh context and request semantic analysis when needed."}
              </p>
              {snapshot && (
                <details>
                  <summary>PR description</summary>
                  <AgentResponse text={snapshot.body || "No description"} />
                </details>
              )}
              <h3>Reviewer overview</h3>
              {snapshot?.reviews.map((review) => (
                <article className="discussion-entry" key={review.id}>
                  <header>
                    <strong>@{review.author || "unknown"}</strong>
                    <small>
                      {review.state} · {review.submitted_at}
                    </small>
                  </header>
                  <AgentResponse
                    text={review.body || "Empty review body; inspect associated inline comments."}
                  />
                  <Button size="sm" onClick={() => showSource(review.id)}>
                    Full discussion
                  </Button>
                </article>
              ))}
              <h3>Recommended next actions</h3>
              <p>
                Inspect each suggested change or question and its original source. Code changes need
                implementation and independent verification; explanations can be prepared locally.
                PR repair is available in a later milestone.
              </p>
            </>
          )}
          {tab === "Conversation" && (
            <>
              {snapshot &&
                discussionEntries(snapshot).map((entry) => (
                  <article
                    id={`pr-source-${entry.id}`}
                    className={`discussion-entry ${entry.resolved ? "resolved" : ""}`}
                    key={entry.id}
                  >
                    <header>
                      <strong>@{entry.author}</strong>
                      <small>
                        {entry.author.toLowerCase() === snapshot.authenticatedUser?.toLowerCase()
                          ? "You · "
                          : ""}
                        {entry.author.toLowerCase() === snapshot.author?.toLowerCase()
                          ? "PR author"
                          : entry.bot
                            ? "Bot"
                            : "Reviewer"}{" "}
                        · {entry.type.replaceAll("_", " ")} · {entry.createdAt}
                        {entry.updatedAt !== entry.createdAt ? ` · Edited ${entry.updatedAt}` : ""}
                        {entry.reviewState ? ` · ${entry.reviewState}` : ""}
                        {entry.resolved ? " · Thread resolved" : ""}
                      </small>
                    </header>
                    {entry.path && (
                      <code>
                        {entry.path}
                        {entry.startLine ? `:${entry.startLine}–` : ":"}
                        {entry.line || entry.originalLine || "outdated"}
                        {entry.outdated ? " · outdated" : ""}
                      </code>
                    )}
                    <AgentResponse text={entry.body || "No review description"} />
                    <small>
                      Source {entry.id}
                      {entry.threadId ? ` · Thread ${entry.threadId}` : ""}
                      {entry.inReplyToId ? ` · Reply to ${entry.inReplyToId}` : ""}
                    </small>
                    {entry.url && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void window.vibestar.openExternal(entry.url!)}
                      >
                        Original GitHub discussion
                      </Button>
                    )}
                  </article>
                ))}
              {(!snapshot || !discussionEntries(snapshot).length) && (
                <p className="empty-row">
                  No discussion saved. Analyze PR explicitly to retrieve it.
                </p>
              )}
            </>
          )}
          {tab === "Action items" && (
            <>
              <h3>Outstanding observations</h3>
              {outstanding.map(renderAction)}
              {!outstanding.length && (
                <p className="empty-row">
                  {report
                    ? "No outstanding observations recorded; inspect coverage and CI."
                    : "No analysis yet."}
                </p>
              )}
              <h3>Already addressed in discussion</h3>
              <p className="subtle">Answers and acknowledgments do not prove code was fixed.</p>
              {considerations
                .filter((a) => a.responseState === "answered" || a.reviewerAcknowledgmentIds.length)
                .map(renderAction)}
              <h3>Questions I should answer</h3>
              {considerations
                .filter((a) => a.classification === "question" && a.responseState !== "answered")
                .map(renderAction)}
              <h3>Positive feedback / information</h3>
              {report?.actions
                .filter((a) => ["positive_feedback", "informational"].includes(a.classification))
                .map(renderAction)}
            </>
          )}
          {tab === "Checks" && (
            <>
              <h3>CI / merge blockers</h3>
              <p>
                {snapshot?.mergeable || "Mergeability unknown"} · Check requiredness is not
                inferred.
              </p>
              {snapshot?.checks.map((check) => (
                <div className="check-row" key={check.id || check.name}>
                  <strong>{check.name}</strong>
                  <span
                    className={
                      check.state === "SUCCESS"
                        ? "success"
                        : ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"].includes(check.state)
                          ? "failure"
                          : "running"
                    }
                  >
                    {check.state}
                  </span>
                  {check.url && (
                    <Button
                      size="sm"
                      onClick={() =>
                        void window.vibestar
                          .openExternal(check.url)
                          .catch((e) => setError(errorMessage(e)))
                      }
                    >
                      Open check
                    </Button>
                  )}
                </div>
              ))}
              {!snapshot?.checks.length && (
                <p className="empty-row">
                  No check outcomes retrieved; this is not a claim that tests pass.
                </p>
              )}
              <h3>Changed-file context</h3>
              {snapshot?.files?.map((file) => (
                <details key={file.path}>
                  <summary>
                    <code>{file.path}</code> · {file.status}
                  </summary>
                  <pre>{file.patch || "Patch unavailable (binary or omitted by GitHub)."}</pre>
                </details>
              ))}
            </>
          )}
          {tab === "Analysis history" && (
            <>
              {analyses.map((session) => (
                <article className="pr-analysis-run" key={session.id}>
                  <Button
                    size="sm"
                    onClick={() => {
                      setSelected(session.id);
                      setTab("Overview");
                      setRaw(undefined);
                    }}
                  >
                    {new Date(session.started_at).toLocaleString()} · {session.status}
                  </Button>
                  <p>
                    {session.method === "utility_ai"
                      ? `${session.configuration.provider} · ${session.configuration.model || "CLI default"} · ${session.configuration.effort}`
                      : session.method === "reused"
                        ? "Saved complete analysis reused · No AI usage for this inspection"
                        : "GitHub inspection only · No AI usage"}
                  </p>
                  {session.changes?.map((change, index) => (
                    <p key={index}>{change}</p>
                  ))}
                  {session.error && <p className="warning">{session.error}</p>}
                </article>
              ))}
              {!analyses.length && (
                <p className="empty-row">
                  Legacy decisions remain below; no new analysis history yet.
                </p>
              )}
              <h3>Local model usage</h3>
              {usage.map((row) => (
                <article className="pr-analysis-run" key={row.id}>
                  <strong>{row.purpose}</strong>
                  <p>
                    {row.provider} · {row.model || "CLI default"} · {row.effort} ·{" "}
                    {duration(row.started_at, row.ended_at)} · {row.status}
                  </p>
                  <small>{tokenUsage(row)}</small>
                </article>
              ))}
              {!usage.length && <p className="empty-row">No model runs recorded for this PR.</p>}
              {runs.map((run) => (
                <article key={run.id}>
                  <RunPrompt run={run} />
                  <div className="actions">
                    {(["stdout", "stderr"] as const).map((stream) => (
                      <Button
                        size="sm"
                        key={stream}
                        onClick={() =>
                          void rpc<{ text: string; truncated: boolean }>("scheduled.logs", {
                            id: job.id,
                            run_id: run.id,
                            stream,
                          })
                            .then(setRaw)
                            .catch((e) => setError(errorMessage(e)))
                        }
                      >
                        Raw {stream}
                      </Button>
                    ))}
                  </div>
                </article>
              ))}
              {raw && (
                <>
                  <small>
                    {raw.truncated
                      ? "Last 1 MiB; complete redacted logs remain on disk."
                      : "Saved redacted provider output"}
                  </small>
                  <pre className="raw-log">{raw.text || "No output"}</pre>
                </>
              )}
              {job.action && (
                <details>
                  <summary>Legacy / inbox decision</summary>
                  <p>{job.action.summary}</p>
                  <p>{job.action.reason}</p>
                </details>
              )}
            </>
          )}
        </div>
        <div className="pr-details-footer">
          <small>
            {configuration
              ? `Analyze: ${configuration.provider} · ${configuration.model || "CLI default"} · ${configuration.effort}`
              : "Configured Utility AI"}
          </small>
          <Button
            disabled={busy || running}
            onClick={() =>
              void act("scheduled.analyze", {
                id: job.id,
                request_id: crypto.randomUUID(),
              })
            }
          >
            {job.last_analyzed_at ? "Analyze Again" : "Analyze PR"}
          </Button>
          {running && (
            <Button disabled={busy} onClick={() => void act("scheduled.cancel", { id: job.id })}>
              Cancel analysis
            </Button>
          )}
          <Button
            disabled={
              busy ||
              running ||
              !openRepair ||
              !settings ||
              !refresh ||
              !analysis?.report?.complete ||
              !outstanding.length
            }
            title="Select review observations and an isolated PR repair workspace"
            onClick={() => setSolve(true)}
          >
            Solve Review
          </Button>
          <Button onClick={() => void window.vibestar.openExternal(job.url)}>Open on GitHub</Button>
          <Button onClick={close}>Done</Button>
        </div>
      </section>
      {solve && analysis && settings && refresh && openRepair && (
        <SolveReview
          analysis={analysis}
          repositories={repositories}
          settings={settings}
          close={() => setSolve(false)}
          refresh={refresh}
          open={openRepair}
        />
      )}
    </div>
  );
};
