import { useState } from "react";
import { Clock, RefreshCw, Plus } from "lucide-react";
import type { Snapshot } from "../lib/types";
import { rpc, errorMessage } from "../lib/api";
import { Button } from "./ui/button";
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
  const action = async (method: string, id: string) => {
    try {
      await rpc(method, { id });
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <section className="task-group">
      <h2>
        Needs attention · PR updates{" "}
        <span>{snapshot.attention?.length || 0}</span>
      </h2>
      {error && (
        <p role="alert" className="error-box">
          {error}
        </p>
      )}
      {snapshot.attention?.map((item) => {
        const job = snapshot.scheduled?.find((j) => j.id === item.job_id);
        return (
          <article className="scheduled-attention" key={item.id}>
            <div className="section-heading">
              <strong>{item.summary}</strong>
              <span className="subtle">
                {new Date(item.created_at).toLocaleString()}
              </span>
            </div>
            <code>{job?.url}</code>
            <ul>
              {(JSON.parse(item.changes) as string[]).map((change, i) => (
                <li key={i}>{change}</li>
              ))}
            </ul>
            {item.error && <p className="error-box">{item.error}</p>}
            {item.analysis && (
              <details>
                <summary>Antigravity action analysis</summary>
                <pre>{JSON.stringify(JSON.parse(item.analysis), null, 2)}</pre>
              </details>
            )}
            {item.refinement && (
              <details>
                <summary>Codex verification</summary>
                <pre>
                  {JSON.stringify(JSON.parse(item.refinement), null, 2)}
                </pre>
              </details>
            )}
            <div className="actions">
              {item.task_id && (
                <>
                  <Button
                    variant="secondary"
                    onClick={() => open(item.task_id!)}
                  >
                    Open task
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Run Codex implementation in the linked isolated worktree for ${job?.url}? Changes remain local for review.`,
                        )
                      )
                        void action("scheduled.fix", item.id);
                    }}
                  >
                    Fix with Codex
                  </Button>
                </>
              )}
              <Button
                variant="ghost"
                onClick={() => void action("scheduled.dismiss", item.id)}
              >
                Dismiss
              </Button>
            </div>
          </article>
        );
      })}
      {!snapshot.attention?.length && (
        <p className="empty-row">No PR updates require attention</p>
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
  const [url, setUrl] = useState("");
  const [task, setTask] = useState("");
  const [interval, setInterval] = useState("60");
  const [custom, setCustom] = useState(180);
  const [verify, setVerify] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [repo, setRepo] = useState("");
  const [prs, setPrs] = useState<
    { url: string; title: string; number: number }[]
  >([]);
  const action = async (method: string, params: unknown) => {
    setBusy(true);
    setError("");
    try {
      const result = await rpc(method, params);
      await refresh();
      return result;
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page">
      <div className="page-title">
        <div>
          <span className="eyebrow">LOCAL PR MONITOR</span>
          <h1>Scheduled</h1>
        </div>
        <span className="subtle">Automatic implementation: OFF</span>
      </div>
      <p className="subtle">
        Vibestar checks with gh first. Unchanged PRs consume no model calls.
        Analysis uses a linked task worktree and independent planning settings.
        Monitoring runs while Vibestar is open.
      </p>
      {error && (
        <p role="alert" className="error-box">
          {error}
        </p>
      )}
      <div className="scheduled-form">
        <label>
          Discover my open PRs
          <select value={repo} onChange={(e) => setRepo(e.target.value)}>
            <option value="">Select repository</option>
            {snapshot.repositories.map((r) => (
              <option key={r.id} value={`${r.owner}/${r.name}`}>
                {r.owner}/{r.name}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="secondary"
          disabled={!repo || busy}
          onClick={() =>
            void action("scheduled.discover", { repository: repo }).then(
              (rows) => {
                if (rows) setPrs(rows as typeof prs);
              },
            )
          }
        >
          <RefreshCw size={14} />
          Find open PRs
        </Button>
        {prs.map((pr) => (
          <button
            className="task-card"
            key={pr.url}
            onClick={() => setUrl(pr.url)}
          >
            #{pr.number} {pr.title}
          </button>
        ))}
        <label>
          PR URL
          <input
            placeholder="https://github.com/owner/repository/pull/123"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <div className="scheduled-fields">
          <label>
            Isolated task worktree
            <select value={task} onChange={(e) => setTask(e.target.value)}>
              <option value="">
                Track only · link a task to enable analysis
              </option>
              {snapshot.tasks
                .filter((t) => t.worktree_path)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {
                      snapshot.repositories.find((r) => r.id === t.repo_id)
                        ?.name
                    }{" "}
                    · {t.claimed_scope} · {t.branch_name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Interval
            <select
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
            >
              <option value="60">Every 1 hour</option>
              <option value="120">Every 2 hours</option>
              <option value="custom">Custom interval</option>
            </select>
          </label>
          {interval === "custom" && (
            <label>
              Minutes (5–10080)
              <input
                type="number"
                min={5}
                max={10080}
                value={custom}
                onChange={(e) => setCustom(Number(e.target.value))}
              />
            </label>
          )}
        </div>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={verify}
            onChange={(e) => setVerify(e.target.checked)}
          />
          Verify actionable updates with Codex after Antigravity
        </label>
        <Button
          disabled={busy || !url}
          onClick={() =>
            void action("scheduled.add", {
              url,
              task_id: task || null,
              interval_minutes:
                interval === "custom" ? custom : Number(interval),
              verify_codex: verify,
            }).then((result) => {
              if (result) setUrl("");
            })
          }
        >
          <Plus size={14} />
          Track PR
        </Button>
        <p className="subtle">
          First check saves a baseline. Models run only for subsequent new or
          edited comments, reviews, CI failures or merge conflicts. Merged and
          closed PRs produce local notifications.
        </p>
      </div>
      <section className="task-group">
        <h2>
          <Clock size={16} />
          Tracked PRs <span>{snapshot.scheduled?.length || 0}</span>
        </h2>
        {snapshot.scheduled?.map((job) => (
          <article key={job.id} className="scheduled-attention">
            <div className="section-heading">
              <code>{job.url}</code>
              <span>{job.enabled ? job.status : "paused"}</span>
            </div>
            <p className="subtle">
              Every {job.interval_minutes} min · next{" "}
              {new Date(job.next_run_at).toLocaleString()} · last checked{" "}
              {job.last_checked_at
                ? new Date(job.last_checked_at).toLocaleString()
                : "never"}{" "}
              · {job.verify_codex ? "AG + Codex" : "Antigravity only"}
            </p>
            <p className="subtle">
              {job.last_snapshot?.state} · {job.last_snapshot?.mergeable} ·{" "}
              {job.last_snapshot?.reviewDecision}
            </p>
            {job.error && <p className="error-box">{job.error}</p>}
            <div className="actions">
              <Button
                variant="secondary"
                disabled={busy || ["analyzing", "polling"].includes(job.status)}
                onClick={() =>
                  void action("scheduled.run", {
                    id: job.id,
                    retry: ["error", "interrupted"].includes(job.status),
                  })
                }
              >
                {["error", "interrupted"].includes(job.status)
                  ? "Retry analysis"
                  : "Check now"}
              </Button>
              <Button
                variant="ghost"
                disabled={busy || ["analyzing", "polling"].includes(job.status)}
                onClick={() =>
                  void action("scheduled.enabled", {
                    id: job.id,
                    enabled: !job.enabled,
                  })
                }
              >
                {job.enabled ? "Pause" : "Enable"}
              </Button>
              <Button
                variant="ghost"
                disabled={busy || ["analyzing", "polling"].includes(job.status)}
                onClick={() => {
                  if (
                    window.confirm(
                      "Remove this schedule and its PR notifications?",
                    )
                  )
                    void action("scheduled.remove", {
                      id: job.id,
                      confirmed: true,
                    });
                }}
              >
                Remove
              </Button>
            </div>
          </article>
        ))}
      </section>
      <ScheduledAttention snapshot={snapshot} refresh={refresh} open={open} />
    </div>
  );
};
