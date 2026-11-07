import { useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  MoreHorizontal,
  CheckCircle2,
  XCircle,
  CircleSlash,
  Circle,
  AlertCircle,
} from "lucide-react";

import type { Repository, Task, Snapshot } from "../../lib/types";
import { activeStatuses } from "../../lib/types";
import { rpc, errorMessage } from "../../lib/api";
import { TaskCleanup } from "./TaskCleanup";

export const TaskNavigation = ({
  repositories,
  tasks,
  selected,
  open,
  onError,
  flowStates,
}: {
  repositories: Repository[];
  tasks: Task[];
  selected: string | null;
  open: (id: string) => void;
  onError?: (message: string) => void;
  flowStates?: Snapshot["flow_states"];
}) => {
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [archived, setArchived] = useState(false);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number }>();
  const [cleanup, setCleanup] = useState<string>();
  const [error, setError] = useState("");
  const origin = useRef<HTMLElement | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const task = tasks.find((task) => task.id === menu?.id);

  const close = () => {
    setMenu(undefined);
    origin.current?.focus();
  };

  useEffect(() => {
    if (!menu) return;
    surface.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();

    const dismiss = (e: MouseEvent) => {
      if (!surface.current?.contains(e.target as Node)) setMenu(undefined);
    };

    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [menu]);

  const report = (error: unknown) => {
    if (onError) onError(errorMessage(error));
    else setError(errorMessage(error));
  };

  const action = (operation: () => Promise<unknown>) => {
    close();
    void operation().catch(report);
  };

  const context = (task: Task, element: HTMLElement, x?: number, y?: number) => {
    const bounds = element.getBoundingClientRect();
    origin.current = element;

    setMenu({
      id: task.id,
      x: Math.max(8, Math.min(x ?? bounds.left + 12, window.innerWidth - 244)),
      y: Math.max(8, Math.min(y ?? bounds.bottom, window.innerHeight - 280)),
    });
  };

  const status = (task: Task) =>
    flowStates?.[task.id]
      ? `${flowStates[task.id].status} · checks ${flowStates[task.id].verification} · task ${task.status.replaceAll("_", " ")}`
      : task.final_review_verdict === "changes_requested"
        ? "Changes requested"
        : task.status === "awaiting_approval"
          ? "Review needed"
          : task.status.replaceAll("_", " ");

  const running =
    !!task &&
    (flowStates?.[task.id]
      ? ["queued", "running", "pausing", "waiting", "paused"].includes(flowStates[task.id].status)
      : activeStatuses.includes(task.status) || task.status === "queued");

  return (
    <div className="sidebar-tasks">
      {tasks.some((task) => !task.repo_id && (archived || !task.archived)) && (
        <section>
          <div className="tree-group-toggle">Your workspace</div>
          {tasks
            .filter((task) => !task.repo_id && (archived || !task.archived))
            .map((task) => (
              <div key={task.id} className="tree-task-entry">
                <button
                  className={`tree-task ${task.id === selected ? "selected" : ""}`}
                  aria-current={task.id === selected ? "page" : undefined}
                  onClick={() => open(task.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    context(task, event.currentTarget, event.clientX, event.clientY);
                  }}
                >
                  <span>
                    {task.goal || "Viber task"}
                    <small>{status(task)}</small>
                  </span>
                </button>
                <button
                  className="tree-task-menu"
                  aria-label={`Actions for ${task.goal || "Viber task"}`}
                  onClick={(event) => context(task, event.currentTarget)}
                >
                  <MoreHorizontal size={14} />
                </button>
              </div>
            ))}
        </section>
      )}
      {repositories
        .filter((repo) =>
          tasks.some((task) => task.repo_id === repo.id && (archived || !task.archived)),
        )
        .map((repo) => (
          <section key={repo.id}>
            <button
              className="tree-group-toggle"
              aria-expanded={!collapsed.has(repo.id)}
              onClick={() =>
                setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(repo.id)) next.delete(repo.id);
                  else next.add(repo.id);
                  return next;
                })
              }
            >
              {collapsed.has(repo.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              <span>
                {repo.owner}/{repo.name}
              </span>
            </button>

            {!collapsed.has(repo.id) &&
              tasks
                .filter((task) => task.repo_id === repo.id && (archived || !task.archived))
                .map((task) => (
                  <div className="tree-task-entry" key={task.id}>
                    <button
                      className={`tree-task ${task.id === selected ? "selected" : ""}`}
                      aria-current={task.id === selected ? "page" : undefined}
                      onClick={() => open(task.id)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        context(task, e.currentTarget, e.clientX, e.clientY);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                          e.preventDefault();
                          context(task, e.currentTarget);
                        }
                      }}
                      title={`${status(task)}\n${task.issue?.title || task.claimed_scope}\n${task.branch_name}`}
                    >
                      <span>
                        {task.issue_number && (
                          <>
                            <small>Issue #{task.issue_number} ·</small>{" "}
                          </>
                        )}
                        {task.goal || task.claimed_scope || task.issue?.title || "Entire issue"}
                      </span>

                      <span
                        className={`task-status-icon ${task.final_review_verdict === "changes_requested" ? "failed" : task.status}`}
                        aria-hidden="true"
                      >
                        {flowStates?.[task.id] ? (
                          ["failed", "needs_recovery"].includes(flowStates[task.id].status) ? (
                            <XCircle size={12} />
                          ) : ["waiting", "paused", "interrupted", "cancelled"].includes(
                              flowStates[task.id].status,
                            ) ? (
                            <AlertCircle size={12} />
                          ) : (
                            <Circle
                              size={9}
                              fill={
                                ["queued", "running", "pausing"].includes(
                                  flowStates[task.id].status,
                                )
                                  ? "currentColor"
                                  : "none"
                              }
                            />
                          )
                        ) : task.final_review_verdict === "changes_requested" ? (
                          <XCircle size={12} />
                        ) : ["ready_for_review", "completed"].includes(task.status) ? (
                          <CheckCircle2 size={12} />
                        ) : task.status === "failed" ? (
                          <XCircle size={12} />
                        ) : ["cancelled", "interrupted"].includes(task.status) ? (
                          <CircleSlash size={12} />
                        ) : [
                            "verification_blocked",
                            "awaiting_approval",
                            "reviewed_with_gaps",
                          ].includes(task.status) ? (
                          <AlertCircle size={12} />
                        ) : (
                          <Circle
                            size={9}
                            fill={activeStatuses.includes(task.status) ? "currentColor" : "none"}
                          />
                        )}
                      </span>

                      <span className="sr-only">
                        {" "}
                        · {status(task)}
                        {task.archived ? " · Archived" : ""}
                      </span>
                    </button>

                    <button
                      className="tree-task-menu"
                      aria-label={`Actions for task #${task.issue_number}`}
                      aria-haspopup="menu"
                      aria-expanded={menu?.id === task.id}
                      onClick={(e) => context(task, e.currentTarget)}
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  </div>
                ))}
          </section>
        ))}
      {!tasks.length && <p className="sidebar-empty">Your tasks appear here.</p>}
      {tasks.some((task) => task.archived) && (
        <button className="tree-archive-toggle" onClick={() => setArchived(!archived)}>
          {archived ? "Hide archived tasks" : "Show archived tasks"}
        </button>
      )}

      {error && (
        <p role="alert" className="failure">
          {error}
        </p>
      )}

      {task && menu && (
        <div
          ref={surface}
          className="task-context-menu"
          role="menu"
          aria-label={
            task.issue_number
              ? `Task #${task.issue_number} actions`
              : `${task.goal || "Viber task"} actions`
          }
          style={{ left: menu.x, top: menu.y }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            }

            if (e.key === "Tab") close();
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
              e.preventDefault();

              const items = [
                ...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
              ];

              const current = items.indexOf(document.activeElement as HTMLButtonElement);

              const next =
                e.key === "Home"
                  ? 0
                  : e.key === "End"
                    ? items.length - 1
                    : (current + (e.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;

              items[next]?.focus();
            }
          }}
        >
          <button
            role="menuitem"
            onClick={() => {
              close();
              open(task.id);
            }}
          >
            Open
          </button>

          <button
            role="menuitem"
            disabled={!task.worktree_path}
            onClick={() =>
              action(() =>
                rpc("editors.open", {
                  id: task.id,
                  kind: "task",
                  editor: "code",
                }),
              )
            }
          >
            Open in VS Code
          </button>

          <button
            role="menuitem"
            disabled={!task.issue_url}
            onClick={() => {
              const url = task.issue_url;
              if (url) action(() => navigator.clipboard.writeText(url));
            }}
          >
            Copy issue URL
          </button>

          <button
            role="menuitem"
            disabled={!task.branch_name}
            onClick={() => action(() => navigator.clipboard.writeText(task.branch_name))}
          >
            Copy task branch
          </button>

          <button
            role="menuitem"
            disabled={running || task.status === "preserved"}
            onClick={() =>
              action(() => rpc("task.archive", { id: task.id, archived: !task.archived }))
            }
          >
            {task.archived ? "Unarchive" : "Archive"}
          </button>

          <button
            role="menuitem"
            disabled={running}
            className="failure"
            onClick={() => {
              close();
              setCleanup(task.id);
            }}
          >
            Manage task…
          </button>
        </div>
      )}

      {cleanup && (
        <TaskCleanup
          id={cleanup}
          close={() => {
            setCleanup(undefined);
            origin.current?.focus();
          }}
          done={() => {
            setCleanup(undefined);
            origin.current?.focus();
          }}
        />
      )}
    </div>
  );
};
