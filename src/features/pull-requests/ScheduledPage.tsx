import { useEffect, useRef, useState } from "react";
import {
  RefreshCw,
  ExternalLink,
  GitPullRequest,
  GitMerge,
  GitPullRequestClosed,
  Search,
  CheckCheck,
  LoaderCircle,
  Square,
} from "lucide-react";

import type { ScheduleJob } from "../../../backend/scheduled/contracts";
import type { Settings } from "../../../backend/domain";
import type { Snapshot } from "../../lib/types";
import { rpc, errorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Select } from "../../components/ui/Select";
import { PageHeader, EmptyState, ListSkeleton } from "../../components/ui/PageHeader";
import { PrDetails } from "./PrDetails";
import { ReviewModelPicker } from "./ReviewModelPicker";
import { prReviewStatus, prWatchStatus } from "./status";
import { WatchProgress } from "./WatchProgress";
import { duration } from "../../lib/format";

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
                <Button size="sm" variant="ghost" onClick={() => open(item.task_id!)}>
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
        <p className="empty-row">No saved review observations need attention.</p>
      )}
      {error && <p className="error-box">{error}</p>}
      {selected && snapshot.scheduled?.find((j) => j.id === selected) && (
        <PrDetails
          job={snapshot.scheduled.find((j) => j.id === selected)!}
          configuration={snapshot.settings.review_ai || snapshot.settings.utility_ai}
          watch={snapshot.pr_watch?.items.find(
            (item) => item.url === snapshot.scheduled?.find((job) => job.id === selected)?.url,
          )}
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
  const [modelOverride, setModelOverride] = useState<Settings["utility_ai"]>();
  const checking = useRef(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [repository, setRepository] = useState("");
  const [errorOperation, setErrorOperation] = useState("");
  const [status, setStatus] = useState("OPEN");
  const [review, setReview] = useState("");
  const jobs = snapshot.scheduled || [];
  const github = snapshot.github;

  const configuration =
    modelOverride || snapshot.settings.review_ai || snapshot.settings.utility_ai;

  const discovered = github?.pull_requests || [];

  const rows = [
    ...discovered.map((pr) => ({
      pr,
      job: jobs.find((job) => job.url.toLowerCase() === pr.url.toLowerCase()),
      url: pr.url,
    })),
    ...jobs
      .filter((job) => !discovered.some((pr) => pr.url.toLowerCase() === job.url.toLowerCase()))
      .map((job) => ({ pr: undefined, job, url: job.url })),
  ]
    .map(({ pr, job, url }) => {
      const saved = job?.pending_snapshot || job?.last_snapshot;
      const report = snapshot.pr_reports?.find((report) => report.job_id === job?.id);

      const savedIsNewer =
        saved &&
        !pr?.access_error &&
        (!pr ||
          (!!job?.last_checked_at &&
            Date.parse(job.last_checked_at) >= Date.parse(pr.refreshed_at || pr.updated_at)));

      const savedWatchItem = snapshot.pr_watch?.items.find(
        (item) => item.url.toLowerCase() === url.toLowerCase(),
      );

      const watchStale =
        savedWatchItem?.checked_at &&
        pr &&
        (pr.access_error ||
          Date.parse(pr.updated_at) > Date.parse(savedWatchItem.checked_at) ||
          (savedWatchItem.head_sha && pr.head_sha && savedWatchItem.head_sha !== pr.head_sha));

      const watchItem =
        savedWatchItem && watchStale
          ? {
              ...savedWatchItem,
              status: "unknown" as const,
              reason: "PR changed or became unavailable; recheck its conversation.",
            }
          : savedWatchItem;

      const watchIsNewer =
        watchItem?.checked_at &&
        (!pr || Date.parse(watchItem.checked_at) >= Date.parse(pr.refreshed_at || pr.updated_at));

      const lifecycle =
        (watchIsNewer ? watchItem.lifecycle : undefined) ||
        (savedIsNewer ? saved.state.toUpperCase() : pr?.state) ||
        saved?.state?.toUpperCase() ||
        (job?.archived ? "ARCHIVED" : "UNKNOWN");

      return {
        pr,
        job,
        watchItem,
        url,
        repository: pr?.repository || url.replace("https://github.com/", "").split("/pull/")[0],
        number: pr?.number || url.split("/").at(-1),
        title: pr?.title || job?.title || saved?.title || "Pull request",
        state: lifecycle,
        updated: pr?.updated_at || job?.last_checked_at,
        decision: saved?.reviewDecision || "UNKNOWN",
        outstanding: report?.outstanding ?? job?.action?.outstandingRequests.length ?? 0,
        questions: report?.unanswered_questions || 0,
        attention:
          lifecycle === "OPEN" &&
          (watchItem
            ? ["review", "unknown"].includes(watchItem.status)
            : !!job?.action?.manualActionRequired ||
              !!report?.outstanding ||
              !!report?.unanswered_questions),
        failedCI: saved?.checks.some((check) =>
          ["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED"].includes(
            check.state.toUpperCase(),
          ),
        ),
        checksKnown: !!saved?.checks.length,
        actionState: report?.action_state || "Not analyzed",
        analyzedHead: report?.analyzed_head,
        phase: report?.phase,
        startedAt: report?.started_at,
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
      (!review || (review === "attention" ? row.attention : row.decision === review)),
  );

  const watch = snapshot.pr_watch;
  const activeBatch = watch && ["running", "cancelling"].includes(watch.status) ? watch : undefined;

  const runningChecks =
    !!activeBatch || jobs.some((job) => ["analyzing", "polling"].includes(job.status));

  const [clock, setClock] = useState(() => Date.now());

  useEffect(() => {
    if (!runningChecks) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [runningChecks]);

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

  const openDiscovered = async (row: (typeof rows)[number], analyze = false) => {
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
          configuration: {
            provider: configuration.provider,
            config: {
              model: configuration.model,
              effort: configuration.effort,
              timeout_secs: configuration.timeout_secs,
            },
          },
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
    setStatus("OPEN");
    setReview("");
  };

  const checkOpen = async () => {
    if (checking.current || activeBatch) return;
    checking.current = true;
    setBusy("check-open");
    setError("");
    try {
      await rpc("pr.watch.start", {
        request_id: crypto.randomUUID(),
        trigger: "recheck",
        configuration: {
          provider: configuration.provider,
          config: {
            model: configuration.model,
            effort: configuration.effort,
            timeout_secs: configuration.timeout_secs,
          },
        },
      });

      await refresh();
    } catch (failure) {
      setErrorOperation("analysis");
      setError(errorMessage(failure));
    } finally {
      checking.current = false;
      setBusy("");
    }
  };

  const refreshButton = (
    <Button
      busy={updating}
      disabled={!!busy}
      onClick={() => void action("github.pullRequests.refresh", {}, "refresh")}
    >
      {!updating && <RefreshCw size={14} />}
      {updating ? "Refreshing…" : "Refresh PR List"}
    </Button>
  );

  return (
    <div className="page pr-inbox">
      <PageHeader
        title="Pull requests"
        description="Review conversations and keep your contributions moving."
        actions={
          <>
            <ReviewModelPicker
              value={configuration}
              onChange={setModelOverride}
              reset={() => setModelOverride(undefined)}
            />
            {refreshButton}
            {!activeBatch && (
              <Button
                variant="default"
                busy={busy === "check-open" || !!activeBatch}
                disabled={!!busy || !!activeBatch}
                onClick={() => void checkOpen()}
              >
                {!activeBatch && busy !== "check-open" && <CheckCheck size={15} />}
                {activeBatch ? "Checking open PRs…" : "Recheck open PRs"}
              </Button>
            )}
          </>
        }
      />

      {watch && (
        <WatchProgress
          watch={watch}
          clock={clock}
          stopping={watch.status === "cancelling" || busy === "stop-watch"}
          stop={() => void action("pr.watch.cancel", {}, "stop-watch")}
        />
      )}

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
              onClick={() => void action("github.pullRequests.refresh", {}, "refresh")}
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

            <Select
              label="Filter by repository"
              value={repository}
              searchable
              onChange={setRepository}
              options={[
                { value: "", label: "All repositories" },
                ...[...new Set(rows.map((row) => row.repository))]
                  .sort()
                  .map((value) => ({ value, label: value })),
              ]}
            />

            <Select
              label="Filter by status"
              value={status}
              onChange={setStatus}
              options={[
                ...[
                  ["OPEN", "Open"],
                  ["MERGED", "Merged"],
                  ["CLOSED", "Closed"],
                ].map(([value, label]) => ({
                  value,
                  label: `${label} (${rows.filter((row) => row.state === value).length})`,
                })),
                { value: "", label: `All statuses (${rows.length})` },
              ]}
            />

            <Select
              label="Filter by review"
              value={review}
              onChange={setReview}
              options={[
                { value: "", label: "All reviews" },
                { value: "attention", label: "Need attention" },
                { value: "APPROVED", label: "Approved" },
                { value: "CHANGES_REQUESTED", label: "Changes requested" },
                { value: "REVIEW_REQUIRED", label: "Review required" },
                { value: "UNKNOWN", label: "Not inspected" },
              ]}
            />
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
                onClick={() => void action("github.pullRequests.refresh", {}, "refresh")}
              >
                Discover pull requests
              </Button>
            )
          }
        />
      ) : !filtered.length ? (
        <EmptyState
          icon={<Search size={26} />}
          title={
            status === "OPEN" && !query && !repository && !review
              ? "No open pull requests"
              : "No matching pull requests"
          }
          description={
            status === "OPEN" && !query && !repository && !review
              ? "Use the status filter to view merged and closed contributions."
              : "Try another search or clear your filters."
          }
          action={
            status === "OPEN" && !query && !repository && !review ? (
              <Button onClick={() => setStatus("")}>View all pull requests</Button>
            ) : (
              <Button onClick={resetFilters}>Clear filters</Button>
            )
          }
        />
      ) : (
        <section className="pr-list" aria-label="Pull requests">
          {filtered.map((row) => {
            const job = row.job;

            const running =
              row.watchItem?.status === "checking" ||
              (!!job && ["polling", "analyzing"].includes(job.status));

            const terminalState = ["CLOSED", "MERGED", "ARCHIVED"].includes(row.state);
            const watchItem = row.watchItem;

            const state =
              !terminalState && watchItem
                ? prWatchStatus(watchItem)
                : prReviewStatus(job, row.state, row.actionState);

            const Icon =
              row.state === "MERGED"
                ? GitMerge
                : row.state === "CLOSED"
                  ? GitPullRequestClosed
                  : GitPullRequest;

            return (
              <article className={`pr-inbox-row pr-${state.tone}`} key={row.url}>
                <div className={`pr-list-icon ${row.state.toLowerCase()}`}>
                  <Icon size={18} />
                </div>
                <div className="pr-row-content">
                  <div className="pr-row-top">
                    <button
                      className="pr-title pr-details-link"
                      disabled={!!busy}
                      onClick={() => void openDiscovered(row)}
                    >
                      {row.title}
                    </button>
                    {row.pr?.draft && <span className="pr-draft">Draft</span>}
                  </div>
                  <div className="pr-metadata">
                    <span className="pr-reference">
                      {row.repository} #{row.number}
                    </span>
                    {row.pr?.head_branch && (
                      <span className="mono pr-branch">{row.pr.head_branch}</span>
                    )}
                    {row.updated && (
                      <span>Updated {new Date(row.updated).toLocaleDateString()}</span>
                    )}
                  </div>
                  <div className="pr-review-line">
                    <span className={`pr-review-state ${state.tone}`}>
                      {running && <LoaderCircle size={12} className="spinning" />}
                      {running
                        ? watchItem?.status === "checking"
                          ? watchItem.reason
                          : row.phase || state.label
                        : state.label}
                    </span>
                    {running && row.startedAt && (
                      <span>{duration(row.startedAt, new Date(clock).toISOString())} elapsed</span>
                    )}
                    {!terminalState && watchItem && !running && (
                      <span className="pr-summary">{watchItem.reason}</span>
                    )}
                    {!terminalState && !watchItem && !running && job?.action?.summary && (
                      <span className="pr-summary">{job.action.summary}</span>
                    )}
                    {!terminalState && !watchItem && row.failedCI && (
                      <span className="failure">CI needs attention</span>
                    )}
                    {!terminalState && !watchItem && (row.outstanding > 0 || row.questions > 0) && (
                      <span>
                        {row.outstanding > 0 ? `${row.outstanding} observations` : ""}
                        {row.outstanding && row.questions ? " · " : ""}
                        {row.questions > 0 ? `${row.questions} unanswered questions` : ""}
                      </span>
                    )}
                  </div>
                  {!terminalState && !watchItem && job?.error && (
                    <p className="warning">
                      {errorMessage(job.error)} ·{" "}
                      {/Run exceeded \d+s timeout/.test(job.error)
                        ? "Increase the time limit in the review model picker, then check again."
                        : "Request analysis explicitly to retry."}
                    </p>
                  )}

                  {row.pr?.access_error && (
                    <p className="warning">
                      GitHub state unavailable: {row.pr.access_error}
                      {row.pr.last_known_state
                        ? ` · Last known ${row.pr.last_known_state.toLowerCase()}`
                        : ""}
                    </p>
                  )}
                </div>

                <div className="row-actions">
                  {!terminalState && !watchItem && !running && !activeBatch && (
                    <Button
                      size="sm"
                      busy={busy === row.url}
                      disabled={!!busy || running || !!activeBatch}
                      onClick={() => void openDiscovered(row, true)}
                    >
                      {job?.last_analyzed_at ? "Analyze again" : "Analyze review"}
                    </Button>
                  )}

                  {!terminalState &&
                    watchItem &&
                    ["review", "unknown"].includes(watchItem.status) && (
                      <Button
                        size="sm"
                        onClick={() =>
                          void window.vibestar.openExternal(watchItem.source_urls[0] || row.url)
                        }
                      >
                        Review on GitHub
                      </Button>
                    )}

                  {running && job && !activeBatch && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Stop checking PR #${row.number}`}
                      disabled={!!busy}
                      onClick={() => void action("scheduled.cancel", { id: job.id }, job.id)}
                    >
                      <Square size={12} />
                      Stop
                    </Button>
                  )}

                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!!busy}
                    onClick={() => void openDiscovered(row)}
                  >
                    View report
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

      {selected && jobs.find((job) => job.id === selected) && (
        <PrDetails
          job={jobs.find((job) => job.id === selected)!}
          configuration={configuration}
          watch={snapshot.pr_watch?.items.find(
            (item) => item.url === jobs.find((job) => job.id === selected)?.url,
          )}
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
