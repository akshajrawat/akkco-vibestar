import { useState, useCallback, useEffect } from "react";
import {
  ListTodo,
  GitPullRequest,
  FolderGit2,
  Plug,
  Settings,
  Plus,
  X,
  Search,
  Activity,
} from "lucide-react";
import type { Page } from "./lib/types";
import { useWorkspace, useDetail } from "./lib/useWorkspace";
import { Overview } from "./components/Overview";
import { RepositoryPage } from "./components/RepositoryPage";
import { NewTask } from "./components/NewTask";
import { TaskWorkspace } from "./components/TaskWorkspace";
import { ProvidersPage } from "./components/ProvidersPage";
import { SettingsPage } from "./components/SettingsPage";
import { Button } from "./components/ui/button";
import { TaskNavigation } from "./components/TaskNavigation";
import { CommandPalette } from "./components/CommandPalette";
import { ResizeHandle } from "./components/ResizeHandle";
import { usePaneSize } from "./lib/usePaneSize";
import { useTaskView, updateTaskView } from "./lib/taskView";
import { rpc, errorMessage } from "./lib/api";
import { ScheduledPage } from "./components/ScheduledPage";
import { TitleBar } from "./components/TitleBar";
import { DataMigration } from "./components/DataMigration";
import { RepairWorkspace } from "./components/repair/RepairWorkspace";
import { IssueWatchPage } from "./components/issue-watch/IssueWatchPage";
import { UsageView } from "./components/UsageView";
import { useWatchNotifications } from "./lib/issue-watch/notifications";
const navigation = [
  ["Tasks", ListTodo],
  ["Scheduled", GitPullRequest],
  ["Issue Watch", Search],
  ["Repositories", FolderGit2],
  ["Providers", Plug],
  ["Usage", Activity],
  ["Settings", Settings],
] as const;
export const App = () => {
  const { snapshot, error, setError, refresh, revision } = useWorkspace();
  const [page, setPage] = useState<Page>("Tasks");
  const [taskId, setTaskId] = useState<string | null>(() =>
    localStorage.getItem("vibestar.activeTask"),
  );
  const [palette, setPalette] = useState(false);
  const [repairId, setRepairId] = useState<string | null>(() =>
    localStorage.getItem("vibestar.activeRepair"),
  );
  const [newTask, setNewTask] = useState(false);
  const [taskPrefill, setTaskPrefill] = useState<{
    url: string;
    notes: string;
  }>();
  const [watchId, setWatchId] = useState<string | null>(null);
  const notifications = useWatchNotifications(
    snapshot?.capabilities?.manual_issue_watch === true,
  );
  const [sidebar, setSidebar] = useState(true);
  const [sidebarWidth, setSidebarWidth] = usePaneSize(
    "sidebarWidth",
    238,
    180,
    380,
  );
  const activeView = useTaskView(taskId || "");
  const { detail, error: detailError } = useDetail(taskId, revision);
  const onError = useCallback((s: string) => setError(s), [setError]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "p"
      ) {
        e.preventDefault();
        setPalette((v) => !v);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebar((v) => !v);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    if (snapshot && taskId && !snapshot.tasks.some((t) => t.id === taskId)) {
      setTaskId(null);
      localStorage.removeItem("vibestar.activeTask");
    }
  }, [snapshot, taskId]);
  const open = (id: string) => {
    setRepairId(null);
    localStorage.removeItem("vibestar.activeRepair");
    setTaskId(id);
    setPage("Tasks");
    localStorage.setItem("vibestar.activeTask", id);
  };
  const navigate = (p: Page) => {
    setPage(p);
    setWatchId(null);
    setTaskId(null);
    setRepairId(null);
    localStorage.removeItem("vibestar.activeRepair");
  };
  const openRepair = (id: string) => {
    setTaskId(null);
    setRepairId(id);
    setPage("Tasks");
    localStorage.removeItem("vibestar.activeTask");
    localStorage.setItem("vibestar.activeRepair", id);
  };
  const count = snapshot?.attention?.length || 0;
  const content =
    page === "Scheduled" && snapshot ? (
      <ScheduledPage
        snapshot={snapshot}
        refresh={refresh}
        open={open}
        openRepair={openRepair}
      />
    ) : page === "Issue Watch" && snapshot ? (
      <IssueWatchPage
        snapshot={snapshot}
        initialWatchId={watchId}
        startTask={(url, notes) => {
          setTaskPrefill({ url, notes });
          setNewTask(true);
        }}
      />
    ) : page === "Usage" ? (
      <UsageView />
    ) : page === "Settings" ? (
      <SettingsPage
        settings={snapshot?.settings}
        root={snapshot?.root}
        diagnostics={snapshot?.persistence}
        refresh={refresh}
      />
    ) : page === "Providers" ? (
      <ProvidersPage />
    ) : page === "Repositories" && snapshot ? (
      <RepositoryPage
        snapshot={snapshot}
        refresh={refresh}
        createTask={() => setNewTask(true)}
      />
    ) : repairId ? (
      <RepairWorkspace
        key={repairId}
        id={repairId}
        revision={revision}
        refresh={refresh}
        back={() => navigate("Scheduled")}
        analyze={(jobId) => {
          navigate("Scheduled");
          void rpc("scheduled.analyze", {
            id: jobId,
            request_id: crypto.randomUUID(),
          })
            .then(refresh)
            .catch((e) => onError(errorMessage(e)));
        }}
      />
    ) : taskId ? (
      detail && detail.task.id === taskId ? (
        <TaskWorkspace
          key={taskId}
          detail={detail}
          repository={snapshot?.repositories.find(
            (r) => r.id === detail.task.repo_id,
          )}
          revision={revision}
          onError={onError}
          back={() => setTaskId(null)}
        />
      ) : (
        <p className="empty-row">{detailError || "Opening task…"}</p>
      )
    ) : snapshot ? (
      <Overview
        snapshot={snapshot}
        refresh={refresh}
        open={open}
        newTask={() => setNewTask(true)}
      />
    ) : (
      <div className="page">
        <h1>Connecting execution environment…</h1>
        {error && (
          <Button onClick={() => navigate("Settings")}>Open Settings</Button>
        )}
      </div>
    );
  return (
    <div className="desktop-shell">
      <TitleBar
        onPalette={() => setPalette(true)}
        onSidebar={() => setSidebar((v) => !v)}
        currentTask={
          detail && detail.task.id === taskId
            ? `#${detail.task.issue_number} · ${detail.task.claimed_scope || detail.task.issue?.title}`
            : undefined
        }
      />
      <div className="app-shell">
        {snapshot?.migration && (
          <DataMigration migration={snapshot.migration} refresh={refresh} />
        )}
        {sidebar && (
          <>
            <aside className="sidebar" style={{ width: sidebarWidth }}>
              <div className="brand">
                VIBESTAR <small>LOCAL</small>
              </div>
              <Button
                className="new-task-button"
                aria-label="New task"
                onClick={() => setNewTask(true)}
                disabled={!snapshot}
              >
                <Plus size={14} />
                New task
                <span className="spacer" />
                <kbd>＋</kbd>
              </Button>
              <div className="sidebar-label">
                <button onClick={() => navigate("Tasks")}>Tasks</button>
                <small>{snapshot?.tasks.length || 0}</small>
              </div>
              <TaskNavigation
                repositories={snapshot?.repositories || []}
                tasks={snapshot?.tasks || []}
                selected={taskId}
                open={open}
              />
              {!!snapshot?.repairs?.length && (
                <div className="repair-navigation">
                  <div className="sidebar-label">
                    PULL REQUESTS <small>{snapshot.repairs.length}</small>
                  </div>
                  {snapshot.repositories.map((repository) => {
                    const repairs =
                      snapshot.repairs?.filter(
                        (repair) => repair.repo_id === repository.id,
                      ) || [];
                    return repairs.length ? (
                      <div key={repository.id}>
                        <small className="repair-repository-label">
                          {repository.owner}/{repository.name}
                        </small>
                        {repairs.map((repair) => (
                          <button
                            key={repair.id}
                            className={repairId === repair.id ? "selected" : ""}
                            onClick={() => openRepair(repair.id)}
                          >
                            <GitPullRequest size={13} />
                            <span>
                              #{repair.identity.number} · Review repair
                            </span>
                            <small>{repair.status.replaceAll("_", " ")}</small>
                          </button>
                        ))}
                      </div>
                    ) : null;
                  })}
                </div>
              )}
              <nav className="sidebar-tools">
                {navigation
                  .filter(([label]) => label !== "Tasks")
                  .map(([label, Icon]) => (
                    <button
                      className={page === label ? "selected" : ""}
                      key={label}
                      aria-label={
                        label === "Scheduled" ? "Pull Requests" : label
                      }
                      onClick={() => navigate(label)}
                    >
                      <Icon size={14} />
                      {label === "Scheduled" ? "Pull Requests" : label}
                      {label === "Scheduled" && (
                        <small className={count ? "warning" : ""}>
                          {count
                            ? `${count} need attention`
                            : snapshot?.scheduled?.filter((j) => j.enabled)
                                .length || ""}
                        </small>
                      )}
                    </button>
                  ))}
              </nav>
              <div className="sidebar-footer">
                <span className="local-dot" />
                {snapshot?.github?.status?.connected
                  ? `@${snapshot.github.status.username}`
                  : "Local workspace"}
                <small>{snapshot?.settings.concurrency || 2} agent slots</small>
              </div>
            </aside>
            <ResizeHandle
              label="Resize navigation pane"
              value={sidebarWidth}
              onChange={setSidebarWidth}
              min={180}
              max={380}
            />
          </>
        )}
        <main className="main-area">
          {snapshot?.warning && (
            <p className="helper-warning" role="alert">
              {snapshot.warning}
            </p>
          )}
          {error && (
            <div className="global-error">
              <div>
                <strong>Couldn't complete the operation</strong>
                <details>
                  <summary>Technical details</summary>
                  <pre>{error}</pre>
                </details>
              </div>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Dismiss error"
                onClick={() => setError("")}
              >
                <X size={14} />
              </Button>
            </div>
          )}
          {notifications.notices.length > 0 && (
            <div
              className="watch-notifications"
              role="log"
              aria-live="polite"
              aria-label="Issue Watch notifications"
            >
              {notifications.notices.map((notice) => (
                <div key={notice.id}>
                  <Search size={16} />
                  <div>
                    <strong>{notice.text}</strong>
                    <small>Counts include dismissed results.</small>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        navigate("Issue Watch");
                        setWatchId(notice.watchId);
                        notifications.dismiss(notice.id);
                      }}
                    >
                      View results
                    </Button>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Dismiss scan notification"
                    onClick={() => notifications.dismiss(notice.id)}
                  >
                    <X size={14} />
                  </Button>
                </div>
              ))}
            </div>
          )}
          {content}
        </main>
        {palette && (
          <CommandPalette
            close={() => setPalette(false)}
            actions={[
              {
                id: "new-task",
                label: "New task",
                detail: "GitHub issue",
                run: () => setNewTask(true),
              },
              ...navigation.map(([label]) => ({
                id: label,
                label: `Go to ${label === "Scheduled" ? "Pull Requests" : label}`,
                run: () => navigate(label),
              })),
              {
                id: "refresh",
                label: "Refresh local workspace",
                run: () => void refresh(),
              },
              {
                id: "window-fullscreen",
                label: "Window: Toggle fullscreen",
                detail: "F11 · Escape to exit",
                run: () =>
                  void window.electronWindow
                    .fullscreen()
                    .catch((e) => onError(errorMessage(e))),
              },
              {
                id: "window-maximize",
                label: "Window: Maximize / restore",
                run: () =>
                  void window.electronWindow
                    .maximize()
                    .catch((e) => onError(errorMessage(e))),
              },
              ...(snapshot?.tasks || []).map((task) => ({
                id: `task-${task.id}`,
                label: `Open #${task.issue_number} · ${task.claimed_scope || task.issue?.title}`,
                detail: task.branch_name,
                run: () => open(task.id),
              })),
              ...(taskId
                ? [
                    ...[
                      "Chat",
                      "Plan",
                      "Usage",
                      "Agent Output",
                      "Tests",
                      "Terminal",
                      "Logs",
                    ].map((tab) => ({
                      id: `tab-${tab}`,
                      label: `Task: ${tab}`,
                      run: () =>
                        updateTaskView(
                          taskId,
                          [
                            "Tests",
                            "Terminal",
                            "Logs",
                            "Agent Output",
                          ].includes(tab)
                            ? { terminalDock: true, dockTab: tab }
                            : { tab },
                        ),
                    })),
                    {
                      id: "dock",
                      label: "Toggle utility dock",
                      run: () =>
                        updateTaskView(taskId, {
                          terminalDock: !activeView.terminalDock,
                        }),
                    },
                    {
                      id: "open-directory",
                      label: "Open assigned task worktree",
                      run: () =>
                        void rpc("open.directory", {
                          id: taskId,
                          kind: "task",
                        }).catch((e) => onError(errorMessage(e))),
                    },
                  ]
                : []),
            ]}
          />
        )}
        {newTask && (
          <NewTask
            initialIssueUrl={taskPrefill?.url}
            initialNotes={taskPrefill?.notes}
            close={() => {
              setNewTask(false);
              setTaskPrefill(undefined);
            }}
            created={async (id) => {
              await refresh();
              open(id);
            }}
          />
        )}
      </div>
    </div>
  );
};
