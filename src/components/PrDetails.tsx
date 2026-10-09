import { useEffect, useState } from "react";
import type { ScheduleJob } from "../../backend/scheduled/contracts";
import { discussionEntries } from "../../backend/scheduled/action";
import type { UsageRecord } from "../../backend/execution/usage";
import { rpc, duration, errorMessage, tokenUsage } from "../lib/api";
import { Button } from "./ui/button";
import { AgentResponse } from "./AgentResponse";
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
              : ["approved", "merged"].includes(
                    job.action?.conversationState || "",
                  )
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
                              ? "NO ACTION REQUIRED"
                              : "AWAITING CHECK";
  return (
    <span className={`pr-state ${prTone(job)}`}>
      {prTone(job) === "success" ? "✓" : state === "blocked" ? "×" : "●"}{" "}
      {label}
    </span>
  );
};
export const PrDetails = ({
  job,
  close,
}: {
  job: ScheduleJob;
  close: () => void;
}) => {
  const [tab, setTab] = useState("Conversation");
  const [usage, setUsage] = useState<UsageRecord[]>([]);
  const [error, setError] = useState("");
  const snapshot = job.pending_snapshot || job.last_snapshot;
  useEffect(() => {
    let alive = true;
    void rpc<UsageRecord[]>("usage.list", { job_id: job.id })
      .then((rows) => {
        if (alive) setUsage(rows);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [job.id, job.last_checked_at, job.status]);
  const action = job.action;
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
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
        }}
      >
        <div className="modal-heading">
          <div>
            <strong>
              {job.url
                .replace("https://github.com/", "")
                .replace("/pull/", " #")}
            </strong>
            <h2>{job.title || snapshot?.title || "Pull request"}</h2>
            <PrState job={job} />
          </div>
          <Button variant="ghost" aria-label="Close PR details" onClick={close}>
            ×
          </Button>
        </div>
        <div className="workspace-tabs">
          {["Conversation", "Checks", "Decision", "Vibestar analysis"].map(
            (name) => (
              <button
                type="button"
                key={name}
                className={name === tab ? "selected" : ""}
                onClick={() => setTab(name)}
              >
                {name}
              </button>
            ),
          )}
        </div>
        <div className="pr-details-content">
          {error && <p className="error-box">{error}</p>}
          {tab === "Conversation" && (
            <>
              {snapshot &&
                discussionEntries(snapshot).map((entry) => (
                  <article
                    key={entry.id}
                    className={`discussion-entry ${entry.resolved ? "resolved" : ""}`}
                  >
                    <header>
                      <strong>@{entry.author}</strong>
                      <small>
                        {entry.author.toLowerCase() ===
                        snapshot.authenticatedUser?.toLowerCase()
                          ? "You"
                          : entry.bot
                            ? "Bot"
                            : ["OWNER", "MEMBER", "COLLABORATOR"].includes(
                                  entry.authorAssociation || "",
                                )
                              ? "Maintainer / collaborator"
                              : "Reviewer"}{" "}
                        · {entry.type.replaceAll("_", " ")} ·{" "}
                        {entry.createdAt
                          ? new Date(entry.createdAt).toLocaleString()
                          : "Earlier activity"}
                        {entry.reviewState ? ` · ${entry.reviewState}` : ""}
                        {entry.resolved ? " · Resolved" : ""}
                      </small>
                    </header>
                    {entry.path && (
                      <code>
                        {entry.path}
                        {entry.line ? `:${entry.line}` : ""}
                      </code>
                    )}
                    <AgentResponse
                      text={entry.body || "No review description"}
                    />
                  </article>
                ))}
              {!snapshot || !discussionEntries(snapshot).length ? (
                <p className="empty-row">No discussion yet.</p>
              ) : null}
            </>
          )}
          {tab === "Checks" && (
            <>
              {snapshot?.checks.map((check) => (
                <div className="check-row" key={check.name}>
                  <strong>{check.name}</strong>
                  <span
                    className={
                      check.state === "SUCCESS"
                        ? "success"
                        : [
                              "FAILURE",
                              "ERROR",
                              "TIMED_OUT",
                              "CANCELLED",
                            ].includes(check.state)
                          ? "failure"
                          : "running"
                    }
                  >
                    {check.state.replaceAll("_", " ")}
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
                <p className="empty-row">No checks reported.</p>
              )}
            </>
          )}
          {(tab === "Decision" || tab === "Vibestar analysis") && (
            <>
              <h3>{action?.summary || "Waiting for inspection"}</h3>
              <p>{action?.reason}</p>
              {action?.recommendedNextAction && (
                <p>{action.recommendedNextAction}</p>
              )}
              {!!action?.outstandingRequests?.length && (
                <>
                  <h3>Outstanding requests</h3>
                  {action.outstandingRequests.map((r) => (
                    <p key={r.sourceId}>
                      <strong>@{r.author}</strong>: {r.request}
                      {r.path && <code>{r.path}</code>}
                    </p>
                  ))}
                </>
              )}
              {!!action?.alreadyAddressed?.length && (
                <>
                  <h3>Already addressed</h3>
                  {action.alreadyAddressed.map((text, i) => (
                    <p className="success" key={i}>
                      {text}
                    </p>
                  ))}
                </>
              )}
              {job.error && (
                <p className="warning-box">
                  Analysis unavailable: {errorMessage(job.error)}. The previous
                  decision and snapshot are preserved.
                </p>
              )}
            </>
          )}
          {tab === "Vibestar analysis" && (
            <>
              <p className="subtle">
                {job.analysis_method === "utility_ai"
                  ? "Utility AI was used for this decision."
                  : "No AI used for the latest inspection. Deterministic GitHub inspection only."}
              </p>
              {usage.map((row) => (
                <div className="pr-analysis-run" key={row.id}>
                  <strong>{row.purpose}</strong>
                  <p>
                    {row.provider} · {row.model || "CLI default"} · {row.effort}{" "}
                    · {duration(row.started_at, row.ended_at)} ·{" "}
                    <span
                      className={
                        row.status === "completed"
                          ? "success"
                          : row.status === "running"
                            ? "running"
                            : "failure"
                      }
                    >
                      {row.status}
                    </span>
                  </p>
                  <small>
                    {new Date(row.started_at).toLocaleString()} · Tokens:{" "}
                    {tokenUsage(row)}
                  </small>
                </div>
              ))}
              {!usage.length && (
                <p className="empty-row">No AI analysis runs for this PR.</p>
              )}
            </>
          )}
        </div>
        <div className="pr-details-footer">
          <Button onClick={() => void window.vibestar.openExternal(job.url)}>
            Open on GitHub
          </Button>
          <Button onClick={close}>Done</Button>
        </div>
      </section>
    </div>
  );
};
