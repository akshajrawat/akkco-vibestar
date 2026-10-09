import { useState, type ReactNode } from "react";
import type { ScheduleJob } from "../../backend/scheduled/contracts";
import { RefreshCw, Settings2, ExternalLink, Pause, Play } from "lucide-react";
import type { Snapshot } from "../lib/types";
import { rpc, errorMessage } from "../lib/api";
import { Button } from "./ui/button";
import { PrDetails, PrState, prTone } from "./PrDetails";
const ago = (value: string | null) => {
  if (!value || !Number.isFinite(Date.parse(value))) return "not yet";
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(value)) / 60000),
  );
  return minutes < 1
    ? "just now"
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : `${Math.floor(minutes / 1440)}d ago`;
};
const WatchRow = ({
  job,
  details,
  children,
}: {
  job: ScheduleJob;
  details: () => void;
  children: ReactNode;
}) => {
  const state = job.action?.conversationState;
  const summary = ["analyzing", "polling", "pending"].includes(job.status)
    ? job.status === "analyzing"
      ? "Assessing the review conversation."
      : job.status === "polling"
        ? "Checking the latest discussion and CI state."
        : "Discussion analysis is queued."
    : job.error
      ? /restart|core stopped/i.test(job.error)
        ? "The execution core restarted during analysis. Retry explicitly to continue."
        : /cancel|interrupt/i.test(job.error)
          ? "Analysis stopped before a decision was saved. Retry explicitly to continue."
          : `Couldn't inspect this PR: ${errorMessage(job.error).slice(0, 200)}`
      : job.status === "analyzing"
        ? "Assessing the review conversation."
        : job.status === "polling"
          ? "Checking the latest discussion and CI state."
          : job.status === "pending"
            ? "Discussion analysis is queued."
            : state === "waiting_for_reviewer"
              ? "No action required from you. Waiting for reviewer feedback."
              : state === "approved"
                ? "Approved. No action required."
                : state === "waiting_for_ci"
                  ? "Checks are running. Waiting for CI."
                  : state === "merged"
                    ? "Merged. No action required."
                    : state === "closed"
                      ? "Closed. No action required."
                      : job.action?.summary ||
                        "Waiting for the first inspection.";
  const checks =
    job.pending_snapshot?.checks || job.last_snapshot?.checks || [];
  return (
    <article className={`pr-inbox-row pr-${prTone(job)}`}>
      <div className="pr-row-content">
        <div className="pr-row-heading">
          <button
            type="button"
            className="pr-details-link pr-reference"
            onClick={details}
          >
            {job.url.replace("https://github.com/", "").replace("/pull/", " #")}
          </button>
          <PrState job={job} />
          {job.analysis_method && (
            <span
              className="analysis-badge"
              title={
                job.analysis_method === "utility_ai"
                  ? "A local Utility AI run helped determine the conversation state"
                  : "GitHub inspection only; no model run"
              }
            >
              {job.analysis_method === "utility_ai"
                ? "AI used"
                : "Deterministic"}
            </span>
          )}
        </div>
        <button
          type="button"
          className="pr-title pr-details-link"
          title={job.title}
          onClick={details}
        >
          {job.title || "Pull request"}
        </button>
        <p className="pr-one-line" title={summary}>
          {summary}
        </p>
        <div className="pr-metadata">
          <span>Last checked {ago(job.last_checked_at)}</span>
          <span>
            {job.archived
              ? "Archived"
              : !job.enabled
                ? "Paused"
                : `Next ${Math.max(0, Math.ceil((Date.parse(job.next_run_at) - Date.now()) / 60000))}m`}
          </span>
          {job.action?.lastMeaningfulActivityAt && (
            <span>
              Last meaningful activity{" "}
              {ago(job.action.lastMeaningfulActivityAt)}
            </span>
          )}
        </div>
        <details className="pr-row-details">
          <summary>
            Why this state{" "}
            <span>
              ·{" "}
              {job.analysis_method === "utility_ai"
                ? "Utility AI"
                : job.analysis_method === "deterministic"
                  ? "No AI used"
                  : "Awaiting inspection"}
            </span>
          </summary>
          {job.error ? (
            <p className="failure">{errorMessage(job.error)}</p>
          ) : (
            <>
              <p>
                {job.action?.reason ||
                  "No additional explanation available yet."}
              </p>
              {job.action?.recommendedNextAction && (
                <p>{job.action.recommendedNextAction}</p>
              )}
              {job.action?.lastMeaningfulActor && (
                <small>
                  Last meaningful actor:{" "}
                  {job.action.lastMeaningfulActor === "me"
                    ? "you"
                    : job.action.lastMeaningfulActor}
                </small>
              )}
              {!!checks.length && (
                <small>
                  Checks: {checks.filter((c) => c.state === "SUCCESS").length}/
                  {checks.length} passed
                </small>
              )}
            </>
          )}
          <Button size="sm" variant="ghost" onClick={details}>
            Conversation, checks &amp; analysis
          </Button>
        </details>
      </div>
      {children}
    </article>
  );
};
export const ScheduledAttention = ({
  snapshot,
  refresh,
  open,
}: {
  snapshot: Snapshot;
  refresh: () => Promise<void>;
  open: (id: string) => void;
}) => {
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string>();
  return (
    <section className="inbox-group">
      <h2>
        Needs attention <small>{snapshot.attention?.length || 0}</small>
      </h2>
      {error && <p className="error-box">{error}</p>}
      {snapshot.attention?.map((item) => {
        const job = snapshot.scheduled?.find((j) => j.id === item.job_id);
        if (!job) return null;
        return (
          <WatchRow job={job} details={() => setSelected(job.id)} key={item.id}>
            <div className="row-actions">
              {job && !job.archived && (
                <Button
                  size="sm"
                  disabled={["polling", "analyzing"].includes(job.status)}
                  onClick={() =>
                    void rpc("scheduled.run", {
                      id: job.id,
                      retry: ["error", "interrupted"].includes(job.status),
                    })
                      .then(refresh)
                      .catch((e) => setError(errorMessage(e)))
                  }
                >
                  {["error", "interrupted"].includes(job.status)
                    ? "Retry analysis"
                    : "Check now"}
                </Button>
              )}
              {job && !job.archived && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={["polling", "analyzing"].includes(job.status)}
                  onClick={() =>
                    void rpc("scheduled.enabled", {
                      id: job.id,
                      enabled: !job.enabled,
                    })
                      .then(refresh)
                      .catch((e) => setError(errorMessage(e)))
                  }
                >
                  {job.enabled ? "Pause" : "Resume"}
                </Button>
              )}
              {item.task_id && (
                <Button size="sm" onClick={() => open(item.task_id!)}>
                  Open task
                </Button>
              )}
              {job && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void window.vibestar.openExternal(job.url)}
                >
                  Open PR <ExternalLink size={11} />
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
          </WatchRow>
        );
      })}
      {!snapshot.attention?.length && (
        <p className="empty-row">No PRs need your attention.</p>
      )}
      {selected && snapshot.scheduled?.find((j) => j.id === selected) && (
        <PrDetails
          job={snapshot.scheduled.find((j) => j.id === selected)!}
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
  const [config, setConfig] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [url, setUrl] = useState("");
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const settings = snapshot.github?.settings || {
    auto_watch: true,
    interval_minutes: 60,
    verify_codex: false,
  };
  const action = async (method: string, params: unknown, key = "settings") => {
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
  const jobs = snapshot.scheduled || [];
  return (
    <div className="page pr-inbox">
      <div className="page-title">
        <h1>Pull requests</h1>
        <span className="spacer" />
        <small>
          {snapshot.github?.last_sync
            ? `Synced ${ago(snapshot.github.last_sync)}`
            : "GitHub sync pending"}
        </small>
        <Button
          disabled={!!busy}
          onClick={() => void action("github.sync", {}, "sync")}
        >
          <RefreshCw size={13} />
          {busy === "sync" ? "Syncing…" : "Sync"}
        </Button>
        <Button
          aria-label="PR watch settings"
          variant="ghost"
          onClick={() => setConfig(!config)}
        >
          <Settings2 size={14} />
        </Button>
      </div>
      {(error || snapshot.github?.error) && (
        <p className="error-box" role="alert">
          {error || snapshot.github?.error}
        </p>
      )}
      {config && (
        <section className="watch-settings">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.auto_watch}
              onChange={(e) =>
                void action("github.configure", {
                  ...settings,
                  auto_watch: e.target.checked,
                })
              }
            />
            Automatically watch new PRs
          </label>
          <label>
            Default interval
            <select
              value={
                [60, 120].includes(settings.interval_minutes)
                  ? String(settings.interval_minutes)
                  : "custom"
              }
              onChange={(e) => {
                if (e.target.value === "custom")
                  void action("github.configure", {
                    ...settings,
                    interval_minutes: 180,
                  });
                else
                  void action("github.configure", {
                    ...settings,
                    interval_minutes: Number(e.target.value),
                  });
              }}
            >
              <option value="60">1 hour</option>
              <option value="120">2 hours</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          {![60, 120].includes(settings.interval_minutes) && (
            <label>
              Minutes
              <input
                type="number"
                min={5}
                max={10080}
                defaultValue={settings.interval_minutes}
                onBlur={(e) =>
                  void action("github.configure", {
                    ...settings,
                    interval_minutes: Number(e.target.value),
                  })
                }
              />
            </label>
          )}
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.verify_codex}
              onChange={(e) =>
                void action("github.configure", {
                  ...settings,
                  verify_codex: e.target.checked,
                })
              }
            />
            Optional Codex verification after Utility AI
          </label>
          <small>Defaults apply to newly discovered watches.</small>
        </section>
      )}
      <ScheduledAttention snapshot={snapshot} refresh={refresh} open={open} />
      {(["Watching", "Paused", "Recently completed"] as const).map((group) => {
        const rows = jobs.filter((j) =>
          group === "Recently completed"
            ? j.archived
            : !j.archived &&
              !snapshot.attention?.some((a) => a.job_id === j.id) &&
              (group === "Watching" ? j.enabled : !j.enabled),
        );
        return (
          <section className="inbox-group" key={group}>
            <h2>
              {group}
              <small>{rows.length}</small>
            </h2>
            {rows.map((job) => (
              <WatchRow
                job={job}
                details={() => setSelected(job.id)}
                key={job.id}
              >
                <div className="row-actions">
                  {job.task_id && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => open(job.task_id!)}
                    >
                      Open task
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Open PR ${job.url}`}
                    onClick={() => void window.vibestar.openExternal(job.url)}
                  >
                    <ExternalLink size={12} /> Open PR
                  </Button>
                  {!job.archived && (
                    <>
                      <Button
                        size="sm"
                        disabled={
                          !!busy ||
                          ["analyzing", "polling"].includes(job.status)
                        }
                        onClick={() =>
                          void action(
                            "scheduled.run",
                            {
                              id: job.id,
                              retry: ["error", "interrupted"].includes(
                                job.status,
                              ),
                            },
                            job.id,
                          )
                        }
                      >
                        {["error", "interrupted"].includes(job.status)
                          ? "Retry analysis"
                          : "Check now"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={
                          !!busy ||
                          ["analyzing", "polling"].includes(job.status)
                        }
                        onClick={() =>
                          void action(
                            "scheduled.enabled",
                            { id: job.id, enabled: !job.enabled },
                            job.id,
                          )
                        }
                      >
                        {job.enabled ? <Pause size={11} /> : <Play size={11} />}{" "}
                        {job.enabled ? "Pause" : "Resume"}
                      </Button>
                    </>
                  )}
                </div>
              </WatchRow>
            ))}
            {!rows.length && (
              <p className="empty-row">
                {group === "Watching"
                  ? "Your open authored PRs appear here after GitHub sync."
                  : "None"}
              </p>
            )}
          </section>
        );
      })}
      {!!snapshot.github?.pull_requests.filter(
        (pr) => pr.state === "OPEN" && !jobs.some((j) => j.url === pr.url),
      ).length && (
        <section className="inbox-group">
          <h2>Open pull requests</h2>
          {snapshot.github.pull_requests
            .filter(
              (pr) =>
                pr.state === "OPEN" && !jobs.some((j) => j.url === pr.url),
            )
            .map((pr) => (
              <div className="pr-inbox-row" key={pr.url}>
                <strong>
                  {pr.repository} #{pr.number}
                </strong>
                <span>{pr.title}</span>
                <Button
                  size="sm"
                  onClick={() =>
                    void action(
                      "scheduled.add",
                      {
                        url: pr.url,
                        task_id: pr.task_id,
                        interval_minutes: settings.interval_minutes,
                        verify_codex: settings.verify_codex,
                      },
                      pr.url,
                    )
                  }
                >
                  Watch
                </Button>
              </div>
            ))}
        </section>
      )}
      <details className="manual-watch">
        <summary>Advanced · track a PR manually</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(
              "scheduled.add",
              {
                url,
                task_id: task || null,
                interval_minutes: settings.interval_minutes,
                verify_codex: settings.verify_codex,
              },
              "manual",
            );
          }}
        >
          <label>
            PR URL
            <input
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/owner/repo/pull/123"
            />
          </label>
          <label>
            Link task
            <select value={task} onChange={(e) => setTask(e.target.value)}>
              <option value="">Watch without a task</option>
              {snapshot.tasks
                .filter((t) => t.worktree_path)
                .map((t) => (
                  <option value={t.id} key={t.id}>
                    #{t.issue_number} {t.claimed_scope || t.issue.title}
                  </option>
                ))}
            </select>
          </label>
          <Button type="submit" disabled={!!busy}>
            Watch PR
          </Button>
        </form>
      </details>
      <footer className="inbox-footer">
        Monitoring runs while Vibestar is open. Unchanged PRs use no model
        calls.
      </footer>
      {selected && jobs.find((j) => j.id === selected) && (
        <PrDetails
          job={jobs.find((j) => j.id === selected)!}
          close={() => setSelected(undefined)}
        />
      )}
    </div>
  );
};
