import { useState } from "react";
import { RefreshCw, ExternalLink, GitPullRequest, Search } from "lucide-react";
import type { ScheduleJob } from "../../backend/scheduled/contracts";
import type { Snapshot } from "../lib/types";
import { rpc, errorMessage } from "../lib/api";
import { Button } from "./ui/button";
import { PageHeader, EmptyState, ListSkeleton } from "./ui/PageHeader";
import { PrDetails, PrState, prTone } from "./PrDetails";

export const ScheduledAttention = ({
  snapshot,
  refresh,
  open,
  openRepair,
}: {
  snapshot: Snapshot;
  refresh: () => Promise<void>;
  open: (id: string) => void;
  openRepair?: (id: string) => void;
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
          repositories={snapshot.repositories}
          settings={snapshot.settings}
          repairs={snapshot.repairs}
          openRepair={openRepair}
          refresh={refresh}
        />
      )}
    </section>
  );
};

export const ScheduledPage = ({
  snapshot,
  refresh,
  open,
  openRepair,
  connectGitHub,
}: {
  snapshot: Snapshot;
  refresh: () => Promise<void>;
  open: (id: string) => void;
  openRepair?: (id: string) => void;
  connectGitHub?: () => void;
}) => {
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [repository, setRepository] = useState("");
  const [errorOperation, setErrorOperation] = useState("");
  const [status, setStatus] = useState("");
  const [review, setReview] = useState("");
  const jobs = snapshot.scheduled || [];
  const github = snapshot.github;
  const configuration = snapshot.settings.utility_ai;
  const discovered = github?.pull_requests || [];
  const rows = [
    ...discovered.map((pr) => ({
      pr,
      job: jobs.find((job) => job.url.toLowerCase() === pr.url.toLowerCase()),
      url: pr.url,
    })),
    ...jobs
      .filter(
        (job) =>
          !discovered.some(
            (pr) => pr.url.toLowerCase() === job.url.toLowerCase(),
          ),
      )
      .map((job) => ({ pr: undefined, job, url: job.url })),
  ]
    .map(({ pr, job, url }) => {
      const saved = job?.pending_snapshot || job?.last_snapshot;
      const report = snapshot.pr_reports?.find(
        (report) => report.job_id === job?.id,
      );
      return {
        pr,
        job,
        url,
        repository:
          pr?.repository ||
          url.replace("https://github.com/", "").split("/pull/")[0],
        number: pr?.number || url.split("/").at(-1),
        title: pr?.title || job?.title || saved?.title || "Pull request",
        state:
          pr?.state ||
          saved?.state?.toUpperCase() ||
          (job?.archived ? "ARCHIVED" : "UNKNOWN"),
        updated: pr?.updated_at || job?.last_checked_at,
        decision: saved?.reviewDecision || "UNKNOWN",
        outstanding:
          report?.outstanding ?? job?.action?.outstandingRequests.length ?? 0,
        questions: report?.unanswered_questions || 0,
        attention:
          !!job?.action?.manualActionRequired ||
          !!report?.outstanding ||
          !!report?.unanswered_questions,
        failedCI: saved?.checks.some((check) =>
          [
            "FAILURE",
            "ERROR",
            "TIMED_OUT",
            "ACTION_REQUIRED",
            "CANCELLED",
          ].includes(check.state.toUpperCase()),
        ),
        checksKnown: !!saved?.checks.length,
      };
    })
    .sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
  const filtered = rows.filter(
    (row) =>
      (!query ||
        `${row.title} ${row.repository} #${row.number} ${row.pr?.head_branch || ""}`
          .toLowerCase()
          .includes(query.toLowerCase())) &&
      (!repository || row.repository === repository) &&
      (!status || row.state === status) &&
      (!review ||
        (review === "attention" ? row.attention : row.decision === review)),
  );
  const updating = busy === "refresh" || !!github?.phase;
  const action = async (method: string, params: unknown, key: string) => {
    setBusy(key);
    setError("");
    try {
      await rpc(method, params);
      await refresh();
    } catch (e) {
      setErrorOperation(key === "refresh" ? "refresh" : "action");
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  };
  const openDiscovered = async (
    row: (typeof rows)[number],
    analyze = false,
  ) => {
    setBusy(row.url);
    setError("");
    try {
      const job =
        row.job ||
        (await rpc<ScheduleJob>("scheduled.add", {
          url: row.url,
          task_id: row.pr?.task_id || null,
          interval_minutes: 60,
          verify_codex: false,
        }));
      setSelected(job.id);
      await refresh();
      if (analyze) {
        await rpc("scheduled.analyze", {
          id: job.id,
          request_id: crypto.randomUUID(),
        });
        await refresh();
      }
    } catch (e) {
      setErrorOperation(analyze ? "analysis" : "review");
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  };
  const resetFilters = () => {
    setQuery("");
    setRepository("");
    setStatus("");
    setReview("");
  };
  const refreshButton = (
    <Button
      busy={updating}
      disabled={!!busy}
      onClick={() => void action("github.sync", {}, "refresh")}
    >
      {!updating && <RefreshCw size={14} />}
      {updating ? "Refreshing…" : "Refresh PR List"}
    </Button>
  );
  return (
    <div className="page pr-inbox">
      <PageHeader
        title="Pull requests"
        description="Your contributions and review conversations, together in one workspace."
        actions={refreshButton}
      />
      {(error || github?.error) && (
        <div className="error-box page-error" role="alert">
          <div>
            <strong>
              {!error || errorOperation === "refresh"
                ? "GitHub refresh unavailable"
                : errorOperation === "analysis"
                  ? "PR analysis unavailable"
                  : "Review workspace unavailable"}
            </strong>
            <p>{error || github?.error}</p>
            <small>Saved pull requests are preserved.</small>
          </div>
          {(!error || errorOperation === "refresh") && (
            <Button
              variant="outline"
              busy={updating}
              disabled={!!busy}
              onClick={() => void action("github.sync", {}, "refresh")}
            >
              Retry refresh
            </Button>
          )}
        </div>
      )}
      {updating && (
        <p className="operation-status" role="status">
          {github?.phase || "Retrieving GitHub metadata…"}
        </p>
      )}
      {!!rows.length && (
        <>
          <div
            className="metric-grid pr-overview"
            aria-label="Pull request overview"
          >
            {[
              ["Open", rows.filter((row) => row.state === "OPEN").length],
              ["Need attention", rows.filter((row) => row.attention).length],
              [
                "Known drafts",
                rows.filter((row) => row.pr?.draft === true).length,
              ],
              [
                "Updated in 24 hours",
                rows.filter(
                  (row) =>
                    row.updated &&
                    Date.now() - Date.parse(row.updated) < 86400000,
                ).length,
              ],
              ["Known failed CI", rows.filter((row) => row.failedCI).length],
            ].map(([label, value]) => (
              <div className="metric" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          <div className="list-filters" aria-label="Pull request filters">
            <label className="search-field">
              <Search size={15} />
              <input
                aria-label="Search pull requests"
                placeholder="Search title, repository or branch…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <select
              aria-label="Filter by repository"
              value={repository}
              onChange={(e) => setRepository(e.target.value)}
            >
              <option value="">All repositories</option>
              {[...new Set(rows.map((row) => row.repository))]
                .sort()
                .map((name) => (
                  <option key={name}>{name}</option>
                ))}
            </select>
            <select
              aria-label="Filter by status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">All statuses</option>
              <option value="OPEN">Open</option>
              <option value="CLOSED">Closed</option>
              <option value="MERGED">Merged</option>
              <option value="ARCHIVED">Archived</option>
              <option value="UNKNOWN">Unknown</option>
            </select>
            <select
              aria-label="Filter by review"
              value={review}
              onChange={(e) => setReview(e.target.value)}
            >
              <option value="">All reviews</option>
              <option value="attention">Need attention</option>
              <option value="APPROVED">Approved</option>
              <option value="CHANGES_REQUESTED">Changes requested</option>
              <option value="REVIEW_REQUIRED">Review required</option>
              <option value="UNKNOWN">Not inspected</option>
            </select>
          </div>
          <div className="list-caption">
            <span>
              {filtered.length} pull request{filtered.length === 1 ? "" : "s"}
            </span>
            <span>
              {github?.last_sync
                ? `Last refreshed ${new Date(github.last_sync).toLocaleString()}`
                : "Saved locally · Refresh for current metadata"}
            </span>
          </div>
        </>
      )}
      {updating && !rows.length ? (
        <ListSkeleton label="Loading pull requests" />
      ) : !rows.length ? (
        <EmptyState
          icon={<GitPullRequest size={26} />}
          title={
            github?.status?.connected === false
              ? "Connect your GitHub account"
              : github?.last_sync
                ? "You're all caught up"
                : "Your pull requests, ready when you are"
          }
          description={
            github?.status?.connected === false
              ? "Connect the official GitHub CLI to discover your repositories and pull requests."
              : github?.last_sync
                ? "No authored or linked pull requests were discovered. Refresh when you have a new contribution."
                : "Refresh to discover authored pull requests from GitHub. Review analysis starts only when you ask."
          }
          action={
            github?.status?.connected === false && connectGitHub ? (
              <Button variant="default" onClick={connectGitHub}>
                Open Providers
              </Button>
            ) : (
              <Button
                variant="default"
                busy={updating}
                disabled={!!busy}
                onClick={() => void action("github.sync", {}, "refresh")}
              >
                Discover pull requests
              </Button>
            )
          }
        />
      ) : !filtered.length ? (
        <EmptyState
          icon={<Search size={26} />}
          title="No matching pull requests"
          description="Try another search or clear your filters to see all saved contributions."
          action={<Button onClick={resetFilters}>Clear filters</Button>}
        />
      ) : (
        <section className="pr-list" aria-label="Pull requests">
          {filtered.map((row) => {
            const job = row.job;
            const running =
              !!job && ["polling", "analyzing"].includes(job.status);
            return (
              <article
                className={`pr-inbox-row pr-${job ? prTone(job) : "neutral"}`}
                key={row.url}
              >
                <div
                  className={`pr-list-icon ${row.state === "MERGED" ? "merged" : row.state === "CLOSED" ? "muted" : "success"}`}
                >
                  <GitPullRequest size={19} />
                </div>
                <div className="pr-row-content">
                  <div className="pr-row-top">
                    <span className="pr-reference">
                      {row.repository}{" "}
                      <span className="muted">#{row.number}</span>
                    </span>
                    <span className="pr-state">
                      {row.pr?.draft ? "Draft · " : ""}
                      {row.state === "UNKNOWN"
                        ? "Status not retrieved"
                        : row.state.toLowerCase()}
                    </span>
                    {job && <PrState job={job} />}
                  </div>
                  <button
                    className="pr-title pr-details-link"
                    disabled={!!busy}
                    onClick={() => void openDiscovered(row)}
                  >
                    {row.title}
                  </button>
                  <p className="pr-one-line">
                    {running
                      ? job.status === "analyzing"
                        ? "Assessing the review conversation."
                        : "Retrieving complete GitHub context."
                      : job?.action?.summary ||
                        "Open the review workspace to inspect or analyze this contribution."}
                  </p>
                  <div className="pr-metadata">
                    {row.pr?.head_branch && (
                      <span className="mono">{row.pr.head_branch}</span>
                    )}
                    <span>
                      {row.decision === "UNKNOWN"
                        ? "Review not inspected"
                        : row.decision.toLowerCase().replaceAll("_", " ")}
                    </span>
                    <span className={row.failedCI ? "failure" : ""}>
                      {row.failedCI
                        ? "CI needs attention"
                        : row.checksKnown
                          ? "Saved CI available"
                          : "CI not inspected"}
                    </span>
                    {row.updated && (
                      <span>
                        Updated {new Date(row.updated).toLocaleString()}
                      </span>
                    )}
                  </div>
                  {job && (
                    <div className="pr-metadata">
                      <span>{row.outstanding} observations to consider</span>
                      <span>{row.questions} unanswered questions</span>
                      <span>
                        Last analyzed{" "}
                        {job.last_analyzed_at
                          ? new Date(job.last_analyzed_at).toLocaleString()
                          : "never"}
                      </span>
                      <span>
                        {snapshot.repairs?.filter(
                          (repair) => repair.job_id === job.id,
                        ).length || 0}{" "}
                        repair sessions
                      </span>
                    </div>
                  )}
                  {job?.error && (
                    <p className="warning">
                      {errorMessage(job.error)} · Request analysis explicitly to
                      retry.
                    </p>
                  )}
                  {job?.action?.reason && (
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
                    busy={busy === row.url}
                    disabled={
                      !!busy ||
                      running ||
                      row.state === "CLOSED" ||
                      row.state === "MERGED" ||
                      row.state === "ARCHIVED"
                    }
                    onClick={() => void openDiscovered(row, true)}
                  >
                    {job?.last_analyzed_at ? "Analyze Again" : "Analyze PR"}
                  </Button>
                  {running && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!!busy}
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
                    disabled={!!busy}
                    onClick={() => void openDiscovered(row)}
                  >
                    Review report
                  </Button>
                  {(job?.task_id || row.pr?.task_id) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => open((job?.task_id || row.pr?.task_id)!)}
                    >
                      Original issue task
                    </Button>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Open PR #${row.number} on GitHub`}
                    onClick={() => void window.vibestar.openExternal(row.url)}
                  >
                    <ExternalLink size={14} />
                  </Button>
                </div>
              </article>
            );
          })}
        </section>
      )}
      <p className="page-footnote">
        Analyze PR uses{" "}
        {configuration.provider === "codex" ? "Codex" : "Antigravity"} ·{" "}
        {configuration.model || "official CLI default"} · {configuration.effort}
        . Analysis is explicit and may consume subscription allowance.
      </p>
      {selected && jobs.find((job) => job.id === selected) && (
        <PrDetails
          job={jobs.find((job) => job.id === selected)!}
          configuration={configuration}
          close={() => setSelected(undefined)}
          repositories={snapshot.repositories}
          settings={snapshot.settings}
          repairs={snapshot.repairs}
          openRepair={openRepair}
          refresh={refresh}
        />
      )}
    </div>
  );
};
