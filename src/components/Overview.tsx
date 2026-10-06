import { ArrowUpRight, GitBranch, FolderGit2 } from "lucide-react";
import type { Snapshot, Task } from "../lib/types";
import { activeStatuses, stages } from "../lib/types";
import { duration } from "../lib/api";
import { ScheduledAttention } from "./ScheduledPage";
import { Status } from "./Status";
export const Overview = ({
  snapshot,
  refresh,
  open,
  all = false,
}: {
  snapshot: Snapshot;
  refresh: () => Promise<void>;
  open: (id: string) => void;
  all?: boolean;
}) => {
  const groups: [string, (t: Task) => boolean][] = [
    [
      "Running",
      (t) => activeStatuses.includes(t.status) || t.status === "queued",
    ],
    [
      "Needs attention",
      (t) => t.status === "interrupted" || t.status === "cancelled",
    ],
    ["Ready for review", (t) => t.status === "ready_for_review"],
    ["Failed", (t) => t.status === "failed"],
    ["Completed", (t) => t.status === "completed"],
  ];
  return (
    <div className="page">
      <div className="page-title">
        <div>
          <span className="eyebrow">LOCAL OPEN SOURCE WORKSPACE</span>
          <h1>{all ? "Tasks" : "Overview"}</h1>
        </div>
        <span className="subtle">
          {snapshot.tasks.length} tasks · concurrency{" "}
          {snapshot.settings.concurrency}
        </span>
      </div>
      {!!snapshot.attention?.length && (
        <ScheduledAttention snapshot={snapshot} refresh={refresh} open={open} />
      )}
      {snapshot.tasks.length === 0 ? (
        <div className="empty">
          <FolderGit2 size={36} />
          <h2>Your contribution workspace</h2>
          <p>
            Register an upstream repository, then create a task for one claimed
            scope.
            <br />
            Each task gets its own branch, worktree, and three-stage agent
            pipeline.
          </p>
        </div>
      ) : (
        groups.map(([label, filter]) => {
          const tasks = snapshot.tasks.filter(filter);
          return (
            <section className="task-group" key={label}>
              <h2>
                {label}
                <span>{tasks.length}</span>
              </h2>
              {tasks.length === 0 ? (
                <p className="empty-row">No tasks</p>
              ) : (
                <div className="task-list">
                  {tasks.map((t) => {
                    const r = snapshot.repositories.find(
                      (r) => r.id === t.repo_id,
                    );
                    const config =
                      t.stage === 1
                        ? snapshot.settings.antigravity
                        : t.stage === 2
                          ? snapshot.settings.codex_plan
                          : snapshot.settings.codex_implementation;
                    return (
                      <button
                        className="task-card"
                        key={t.id}
                        onClick={() => open(t.id)}
                      >
                        <div>
                          <span className="repo-label">
                            {r?.owner}/{r?.name} <span>#{t.issue_number}</span>
                          </span>
                          <strong>{t.claimed_scope}</strong>
                          <div className="mono subtle">
                            <GitBranch size={12} />
                            {t.branch_name || "Worktree queued"}
                          </div>
                        </div>
                        <div className="task-meta">
                          <Status status={t.status} />
                          <span>{stages[t.stage]}</span>
                          <small>
                            {config.model || "CLI default"} ·{" "}
                            {duration(
                              t.created_at,
                              t.status === "ready_for_review" ||
                                t.status === "completed"
                                ? t.updated_at
                                : null,
                            )}
                          </small>
                        </div>
                        <ArrowUpRight size={15} />
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })
      )}
    </div>
  );
};
