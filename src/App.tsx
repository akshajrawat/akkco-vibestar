import { useState, useCallback, useEffect } from "react";
import {
  ListTodo,
  GitPullRequest,
  FolderGit2,
  Plug,
  Settings,
  Plus,
  X,
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
const navigation = [
  ["Tasks", ListTodo],
  ["Scheduled", GitPullRequest],
  ["Repositories", FolderGit2],
  ["Providers", Plug],
  ["Settings", Settings],
] as const;
export const App = () => {
  const { snapshot, error, setError, refresh, revision } = useWorkspace();
  const [page, setPage] = useState<Page>("Tasks");
  const [taskId, setTaskId] = useState<string | null>(() =>
    localStorage.getItem("vibestar.activeTask"),
  );
  const [palette, setPalette] = useState(false);
  const [newTask, setNewTask] = useState(false);
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
    setTaskId(id);
    setPage("Tasks");
    localStorage.setItem("vibestar.activeTask", id);
  };
  const navigate = (p: Page) => {
    setPage(p);
    setTaskId(null);
  };
  const count = snapshot?.attention?.length || 0;
  const content =
    page === "Scheduled" && snapshot ? (
      <ScheduledPage snapshot={snapshot} refresh={refresh} open={open} />
    ) : page === "Settings" ? (
      <SettingsPage
        settings={snapshot?.settings}
        root={snapshot?.root}
        refresh={refresh}
      />
    ) : page === "Providers" ? (
      <ProvidersPage />
    ) : page === "Repositories" && snapshot ? (
      <RepositoryPage snapshot={snapshot} refresh={refresh} />
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
            ? `#${detail.task.issue_number} · ${detail.task.claimed_scope || detail.task.issue.title}`
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
                <button onClick={() => navigate("Tasks")}>TASKS</button>
                <small>{snapshot?.tasks.length || 0}</small>
              </div>
              <TaskNavigation
                repositories={snapshot?.repositories || []}
                tasks={snapshot?.tasks || []}
                selected={taskId}
                open={open}
              />
              <nav className="sidebar-tools">
                {navigation
                  .filter(([label]) => label !== "Tasks")
                  .map(([label, Icon]) => (
                    <button
                      className={page === label ? "selected" : ""}
                      key={label}
                      aria-label={label === "Scheduled" ? "PR watch" : label}
                      onClick={() => navigate(label)}
                    >
                      <Icon size={14} />
                      {label === "Scheduled" ? "PR watch" : label}
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
                label: `Go to ${label === "Scheduled" ? "PR watch" : label}`,
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
                label: `Open #${task.issue_number} · ${task.claimed_scope || task.issue.title}`,
                detail: task.branch_name,
                run: () => open(task.id),
              })),
              ...(taskId
                ? [
                    ...[
                      "Chat",
                      "Plan",
                      "Changes",
                      "Tests",
                      "Terminal",
                      "Logs",
                    ].map((tab) => ({
                      id: `tab-${tab}`,
                      label: `Task: ${tab}`,
                      run: () =>
                        updateTaskView(
                          taskId,
                          ["Tests", "Terminal", "Logs"].includes(tab)
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
            close={() => setNewTask(false)}
            created={(id) => {
              open(id);
              void refresh();
            }}
          />
        )}
      </div>
    </div>
  );
};
