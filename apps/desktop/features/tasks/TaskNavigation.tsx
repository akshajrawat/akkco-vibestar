import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, MoreHorizontal, FolderGit2 } from "lucide-react";
import type { Repository, Task, Snapshot } from "../../lib/types";
import { rpc, errorMessage } from "../../lib/api";
import { TaskCleanup } from "./TaskCleanup";
import { taskExecutionDuration, taskNavigationState } from "./taskNavigationState";
import { useTaskActivity } from "./useTaskActivity";

const savedCollapse = (section: string) => {
  try {
    return localStorage.getItem(`vibestar.sidebar.${section}Collapsed`) === "true";
  } catch {
    return false;
  }
};

const createdAge = (createdAt: string, now: number) => {
  const seconds = Math.floor((now - Date.parse(createdAt)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return;
  if (seconds < 60) return "<1m";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};

export const TaskNavigation = ({
  repositories,
  tasks,
  selected,
  open,
  onError,
  flowStates,
  revision = 0,
  query = "",
  renderHeader,
}: {
  repositories: Repository[];
  tasks: Task[];
  selected: string | null;
  open: (id: string) => void;
  onError?: (message: string) => void;
  flowStates?: Snapshot["flow_states"];
  revision?: number;
  query?: string;
  renderHeader?: (tasksToggle: ReactNode) => ReactNode;
}) => {
  const [tasksCollapsed, setTasksCollapsed] = useState(() => savedCollapse("tasks"));
  const [workingCollapsed, setWorkingCollapsed] = useState(() => savedCollapse("working"));
  const tasksId = useId();
  const workingId = useId();
  const activities = useTaskActivity(tasks, flowStates, revision);
  const [now, setNow] = useState(Date.now);

  const states = new Map(
    tasks.map((task) => [
      task.id,
      taskNavigationState(task, flowStates?.[task.id], activities[task.id]),
    ]),
  );

  const ticking = [...states.values()].some(
    (state) => state.active && state.activity?.intervals.some((interval) => !interval.end),
  );

  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

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

  // Paused/waiting flows remain protected by the existing lifecycle guard,
  // even though they no longer occupy the Working section.
  const running =
    !!task &&
    (flowStates?.[task.id]
      ? ["queued", "running", "pausing", "waiting", "paused"].includes(flowStates[task.id].status)
      : states.get(task.id)?.working);

  const search = query.trim().toLowerCase();

  const visible = tasks.filter((task) => {
    if (task.archived && !archived) return false;
    if (!search) return true;

    const repository = repositories.find((repository) => repository.id === task.repo_id);
    const state = states.get(task.id)!;

    return [
      task.goal || task.claimed_scope || task.issue?.title || "Viber task",
      repository
        ? `${repository.owner}/${repository.name}`
        : task.repo_id
          ? "Repository unavailable"
          : "Managed workspace",
      task.issue_number ? `Issue #${task.issue_number} Issue ${task.issue_number}` : "",
      state.label,
      state.status,
      state.status.replaceAll("_", " "),
      state.stage,
      state.taskLabel,
    ].some((value) => value?.toLowerCase().includes(search));
  });

  const normal = visible.filter((task) => !states.get(task.id)?.working);
  const working = visible.filter((task) => states.get(task.id)?.working);

  const toggle = (section: "tasks" | "working") => {
    const value = !(section === "tasks" ? tasksCollapsed : workingCollapsed);
    if (section === "tasks") setTasksCollapsed(value);
    else setWorkingCollapsed(value);
    try {
      localStorage.setItem(`vibestar.sidebar.${section}Collapsed`, String(value));
    } catch {
      // Keep collapse controls usable when local storage is unavailable.
    }
  };

  const row = (task: Task) => {
    const state = states.get(task.id)!;
    const repository = repositories.find((repo) => repo.id === task.repo_id);
    const title = task.goal || task.claimed_scope || task.issue?.title || "Viber task";
    const elapsed = taskExecutionDuration(state.activity, Math.max(now, Date.now()));
    const age = createdAge(task.created_at, Math.max(now, Date.now()));
    const branch = task.branch_name?.trim();

    return (
      <div key={task.id} className={`tree-task-entry${task.id === selected ? " selected" : ""}`}>
        <button
          className={`tree-task${task.id === selected ? " selected" : ""}`}
          aria-label={[
            task.issue_number ? `Issue #${task.issue_number} · ${title}` : title,
            repository?.name || (task.repo_id ? "Repository unavailable" : "Managed workspace"),
            state.label,
            state.stage,
            state.taskLabel,
            elapsed || (age ? `Created ${age} ago` : ""),
            task.archived ? "Archived" : "",
          ]
            .filter(Boolean)
            .join(" · ")}
          aria-current={task.id === selected ? "page" : undefined}
          onClick={() => open(task.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            context(task, event.currentTarget, event.clientX, event.clientY);
          }}
          onKeyDown={(event) => {
            if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
              event.preventDefault();
              context(task, event.currentTarget);
            }
          }}
          title={title}
        >
          <span className="sidebar-task-metadata">
            <span className="sidebar-task-repository">
              <FolderGit2 size={11} aria-hidden="true" />
              <span>
                {repository
                  ? repository.name
                  : task.repo_id
                    ? "Repository unavailable"
                    : "Managed workspace"}
              </span>
            </span>
            {age && (
              <time
                className="sidebar-task-age"
                dateTime={task.created_at}
                title={`Created ${new Date(task.created_at).toLocaleString()}`}
              >
                {age}
              </time>
            )}
          </span>
          <span className="sidebar-task-title">{title}</span>
          {branch && (
            <span className="sidebar-task-branch" title={branch}>
              {branch}
            </span>
          )}
        </button>
        <button
          className="tree-task-menu"
          aria-label={
            task.issue_number ? `Actions for task #${task.issue_number}` : `Actions for ${title}`
          }
          aria-haspopup="menu"
          aria-expanded={menu?.id === task.id}
          onClick={(event) => context(task, event.currentTarget)}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
    );
  };

  const tasksToggle = (
    <button
      className="sidebar-tasks-toggle"
      aria-label={`Tasks, ${normal.length}`}
      aria-expanded={!tasksCollapsed}
      aria-controls={tasksId}
      title={tasksCollapsed ? "Expand tasks" : "Collapse tasks"}
      onClick={() => toggle("tasks")}
    >
      <ChevronDown size={13} className={tasksCollapsed ? "collapsed" : ""} aria-hidden="true" />
    </button>
  );

  return (
    <>
      {renderHeader?.(tasksToggle)}
      <div className="sidebar-tasks">
        <section className="sidebar-task-section">
          {!renderHeader && tasksToggle}
          {search && !visible.length && (
            <p className="sidebar-empty" role="status">
              No tasks match your search.
            </p>
          )}
          <div id={tasksId} className="sidebar-task-list" hidden={tasksCollapsed}>
            {normal.map(row)}
            {!search && !visible.length && <p className="sidebar-empty">Your tasks appear here.</p>}
          </div>
          {tasks.some((task) => task.archived) && (
            <button className="tree-archive-toggle" onClick={() => setArchived(!archived)}>
              {archived ? "Hide archived tasks" : "Show archived tasks"}
            </button>
          )}
        </section>

        {working.length > 0 && (
          <section className="sidebar-working-section">
            <button
              className="sidebar-section-toggle"
              aria-label={`Working, ${working.length}`}
              aria-expanded={!workingCollapsed}
              aria-controls={workingId}
              onClick={() => toggle("working")}
            >
              <span>Working</span>
              <small>{working.length}</small>
              <ChevronDown
                size={13}
                className={workingCollapsed ? "collapsed" : ""}
                aria-hidden="true"
              />
            </button>
            <div id={workingId} className="sidebar-task-list" hidden={workingCollapsed}>
              {working.map(row)}
            </div>
          </section>
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
    </>
  );
};
