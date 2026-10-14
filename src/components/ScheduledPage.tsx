import { useState } from "react";
import { RefreshCw, ExternalLink } from "lucide-react";
import type { Snapshot } from "../lib/types";
import { rpc, errorMessage } from "../lib/api";
import { Button } from "./ui/button";
import { PrDetails, PrState, prTone } from "./PrDetails";

export const ScheduledAttention = ({
  snapshot,
  refresh,
  open,
}: {
  snapshot: Snapshot;
  refresh: () => Promise<void>;
  open: (id: string) => void;
}) => {
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState("");
  return (
    <section className="inbox-group">
      <h2>
        Needs attention <small>{snapshot.attention?.length || 0}</small>
      </h2>
      {snapshot.attention?.map((item) => {
        const job = snapshot.scheduled?.find((j) => j.id === item.job_id);
        return (
          <article className="pr-inbox-row" key={item.id}>
            <div className="pr-row-content">
              <strong>{job?.title || item.summary}</strong>
              <p className="pr-one-line">{item.summary}</p>
              {item.error && <p className="warning">{item.error}</p>}
            </div>
            <div className="row-actions">
              {job && (
                <Button size="sm" onClick={() => setSelected(job.id)}>
                  Review report
                </Button>
              )}
              {item.task_id && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => open(item.task_id!)}
                >
                  Original issue task
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void rpc("scheduled.dismiss", { id: item.id })
                    .then(refresh)
                    .catch((e) => setError(errorMessage(e)))
                }
              >
                Dismiss
              </Button>
            </div>
          </article>
        );
      })}
      {!snapshot.attention?.length && (
        <p className="empty-row">
          No saved review observations need attention.
        </p>
      )}
      {error && <p className="error-box">{error}</p>}
      {selected && snapshot.scheduled?.find((j) => j.id === selected) && (
        <PrDetails
          job={snapshot.scheduled.find((j) => j.id === selected)!}
          configuration={snapshot.settings.utility_ai}
          close={() => setSelected(undefined)}
        />
      )}
    </section>
  );
};

export const ScheduledPage = ({
  snapshot,
  refresh,
  open,
}: {
  snapshot: Snapshot;
  refresh: () => Promise<void>;
  open: (id: string) => void;
}) => {
  const [selected, setSelected] = useState<string>();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const jobs = snapshot.scheduled || [];
  const configuration = snapshot.settings.utility_ai;
  const action = async (method: string, params: unknown, key: string) => {
    setBusy(key);
    setError("");
    try {
      await rpc(method, params);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="page pr-inbox">
      <div className="page-title">
        <h1>Pull requests</h1>
        <span className="spacer" />
        <Button
          disabled={!!busy}
          onClick={() => void action("github.sync", {}, "refresh")}
        >
          <RefreshCw size={13} />
          {busy === "refresh" ? "Refreshing…" : "Refresh PR List"}
        </Button>
      </div>
      <p className="subtle">
        Manual only · Refresh retrieves GitHub metadata. Tracking does not start
        inspection or inference.
      </p>
      <p>
        Analyze PR uses{" "}
        {configuration.provider === "codex" ? "Codex" : "Antigravity"} ·{" "}
        {configuration.model || "official CLI default"} · {configuration.effort}{" "}
        for semantic review analysis when needed. It may consume subscription
        allowance; unchanged complete reports can be reused without AI.
      </p>
      {(error || snapshot.github?.error) && (
        <p className="error-box" role="alert">
          {error || snapshot.github?.error}
        </p>
      )}
      <form
        className="manual-watch"
        onSubmit={(e) => {
          e.preventDefault();
          void action(
            "scheduled.add",
            { url, task_id: null, interval_minutes: 60, verify_codex: false },
            "track",
          );
        }}
      >
        <label>
          PR URL
          <input
            aria-label="PR URL"
            type="url"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/owner/repository/pull/123"
          />
        </label>
        <Button type="submit" disabled={!!busy}>
          Track PR
        </Button>
      </form>
      <section className="inbox-group">
        <h2>
          Tracked pull requests <small>{jobs.length}</small>
        </h2>
        {jobs.map((job) => {
          const running = ["polling", "analyzing"].includes(job.status);
          return (
            <article className={`pr-inbox-row pr-${prTone(job)}`} key={job.id}>
              <div className="pr-row-content">
                <div className="pr-row-top">
                  <strong>
                    {job.url
                      .replace("https://github.com/", "")
                      .replace("/pull/", " #")}
                  </strong>
                  <PrState job={job} />
                </div>
                <button
                  className="pr-title pr-details-link"
                  onClick={() => setSelected(job.id)}
                >
                  {job.title || "Select to analyze this PR"}
                </button>
                <p className="pr-one-line">
                  {job.status === "analyzing"
                    ? "Assessing the review conversation."
                    : job.status === "polling"
                      ? "Retrieving complete GitHub context."
                      : job.error
                        ? "Analysis unavailable; previous report preserved."
                        : job.action?.summary || "No review analysis saved."}
                </p>
                <div className="pr-metadata">
                  <span>
                    {job.action?.outstandingRequests.length || 0} observations
                    to consider
                  </span>
                  <span>
                    Last analyzed{" "}
                    {job.last_analyzed_at
                      ? new Date(job.last_analyzed_at).toLocaleString()
                      : "never"}
                  </span>
                  <span>
                    {job.archived ? "Closed / merged" : "Manual analysis"}
                  </span>
                </div>
                {job.error && (
                  <p className="warning">
                    {errorMessage(job.error)} · Request analysis explicitly to
                    retry.
                  </p>
                )}
                {job.action?.reason && (
                  <details className="pr-row-details">
                    <summary>
                      {running ? "Previous saved decision" : "Why this state"}
                    </summary>
                    <p>{job.action.reason}</p>
                  </details>
                )}
              </div>
              <div className="row-actions">
                <Button
                  size="sm"
                  disabled={!!busy || running}
                  onClick={() => {
                    setSelected(job.id);
                    void action(
                      "scheduled.analyze",
                      { id: job.id, request_id: crypto.randomUUID() },
                      job.id,
                    );
                  }}
                >
                  {job.last_analyzed_at ? "Analyze Again" : "Analyze PR"}
                </Button>
                {running && (
                  <Button
                    size="sm"
                    onClick={() =>
                      void action("scheduled.cancel", { id: job.id }, job.id)
                    }
                  >
                    Cancel analysis
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelected(job.id)}
                >
                  Review report
                </Button>
                {job.task_id && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => open(job.task_id!)}
                  >
                    Original issue task
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void window.vibestar.openExternal(job.url)}
                >
                  <ExternalLink size={12} />
                  Open PR
                </Button>
              </div>
            </article>
          );
        })}
        {!jobs.length && (
          <p className="empty-row">
            Refresh PR List, then Track PR, or paste an existing PR URL. Nothing
            runs automatically.
          </p>
        )}
      </section>
      {!!snapshot.github?.pull_requests.filter(
        (pr) => !jobs.some((j) => j.url === pr.url),
      ).length && (
        <section className="inbox-group">
          <h2>Available pull requests</h2>
          {snapshot.github.pull_requests
            .filter((pr) => !jobs.some((j) => j.url === pr.url))
            .map((pr) => (
              <article className="pr-inbox-row" key={pr.url}>
                <div className="pr-row-content">
                  <strong>
                    {pr.repository} #{pr.number}
                  </strong>
                  <p>{pr.title}</p>
                </div>
                <Button
                  size="sm"
                  disabled={!!busy}
                  onClick={() =>
                    void action(
                      "scheduled.add",
                      {
                        url: pr.url,
                        task_id: pr.task_id,
                        interval_minutes: 60,
                        verify_codex: false,
                      },
                      pr.url,
                    )
                  }
                >
                  Track PR
                </Button>
              </article>
            ))}
        </section>
      )}
      {selected && jobs.find((j) => j.id === selected) && (
        <PrDetails
          job={jobs.find((j) => j.id === selected)!}
          configuration={configuration}
          close={() => setSelected(undefined)}
        />
      )}
    </div>
  );
};
