import { useState } from "react";
import { RefreshCw, Settings2, ExternalLink, Pause, Play } from "lucide-react";
import type { Snapshot } from "../lib/types";
import { rpc, errorMessage } from "../lib/api";
import { Button } from "./ui/button";
const ago = (value: string | null) =>
  value
    ? `${Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000))}m ago`
    : "not yet";
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
  return (
    <section className="inbox-group">
      <h2>
        Needs attention <small>{snapshot.attention?.length || 0}</small>
      </h2>
      {error && <p className="error-box">{error}</p>}
      {snapshot.attention?.map((item) => {
        const job = snapshot.scheduled?.find((j) => j.id === item.job_id);
        const reference = job?.url
          .replace("https://github.com/", "")
          .replace("/pull/", " #");
        return (
          <article className="pr-inbox-row attention-row" key={item.id}>
            <i className="attention-dot" />
            <div className="pr-row-content">
              <strong>{reference}</strong>
              {job?.title && <span className="pr-title">{job.title}</span>}
              <p>{item.summary}</p>
              <small>{ago(item.created_at)}</small>
              {job?.action?.recommendedNextAction && (
                <small>{job.action.recommendedNextAction}</small>
              )}
              {item.error && (
                <details>
                  <summary>Analysis unavailable</summary>
                  <p className="failure">{item.error}</p>
                </details>
              )}
            </div>
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
                  View PR <ExternalLink size={11} />
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
        <p className="empty-row">No PRs need your attention.</p>
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
            Codex verifies Antigravity review analysis
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
              <article className="pr-inbox-row" key={job.id}>
                <i className={`watch-dot ${job.enabled ? "enabled" : ""}`} />
                <div className="pr-row-content">
                  <strong>
                    {job.url
                      .replace("https://github.com/", "")
                      .replace("/pull/", " #")}
                  </strong>
                  {job.title && <span className="pr-title">{job.title}</span>}
                  <p>
                    {job.action?.summary ||
                      job.title ||
                      "Waiting for first check"}
                  </p>
                  <small>
                    {job.archived
                      ? "Watch archived"
                      : `Checked ${ago(job.last_checked_at)} · next ${Math.max(0, Math.ceil((Date.parse(job.next_run_at) - Date.now()) / 60000))}m`}
                    {["polling", "analyzing", "pending"].includes(job.status)
                      ? ` · ${job.status}`
                      : ""}
                  </small>
                  {job.error && (
                    <details>
                      <summary>Inspection error</summary>
                      <p className="failure">{job.error}</p>
                    </details>
                  )}
                </div>
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
                    aria-label={`View ${job.url}`}
                    onClick={() => void window.vibestar.openExternal(job.url)}
                  >
                    <ExternalLink size={12} />
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
              </article>
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
    </div>
  );
};
