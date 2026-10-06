import { useState, useCallback, useEffect } from "react";
import {
  LayoutGrid,
  Clock,
  ListTodo,
  FolderGit2,
  GitCompareArrows,
  Plug,
  Settings,
  Plus,
  Workflow,
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
import { Status } from "./components/Status";
const navigation = [
  ["Overview", LayoutGrid],
  ["Tasks", ListTodo],
  ["Scheduled", Clock],
  ["Repositories", FolderGit2],
  ["Diffs", GitCompareArrows],
  ["Providers", Plug],
  ["Settings", Settings],
] as const;
export const App = () => {
  const { snapshot, error, setError, refresh, revision } = useWorkspace();
  const [page, setPage] = useState<Page>("Overview");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [sidebarWidth, setSidebarWidth] = usePaneSize(
    "sidebarWidth",
    230,
    180,
    380,
  );
  const activeView = useTaskView(taskId || "");
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "p"
      ) {
        event.preventDefault();
        setPalette((value) => !value);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const [newTask, setNewTask] = useState(false);
  const { detail, error: detailError } = useDetail(taskId, revision);
  const onError = useCallback((s: string) => setError(s), [setError]);
  const open = (id: string) => {
    setTaskId(id);
    setPage("Tasks");
  };
  const navigate = (p: Page) => {
    setPage(p);
    if (p !== "Diffs") setTaskId(null);
  };
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
    ) : taskId ? (
      detail ? (
        <TaskWorkspace
          key={taskId}
          detail={detail}
          repository={snapshot?.repositories.find(
            (r) => r.id === detail.task.repo_id,
          )}
          revision={revision}
          onError={onError}
          initialTab={page === "Diffs" ? "Changes" : "Chat"}
          back={() => setTaskId(null)}
        />
      ) : (
        <div className="empty-row">{detailError || "Loading task…"}</div>
      )
    ) : snapshot ? (
      page === "Repositories" ? (
        <RepositoryPage
          repositories={snapshot.repositories}
          refresh={refresh}
        />
      ) : page === "Diffs" ? (
        <div className="page">
          <div className="page-title">
            <h1>Task diffs</h1>
          </div>
          {snapshot.tasks
            .filter((t) => t.worktree_path)
            .map((t) => (
              <button
                className="task-card"
                key={t.id}
                onClick={() => setTaskId(t.id)}
              >
                <div>
                  <strong>{t.claimed_scope}</strong>
                  <code>{t.branch_name}</code>
                </div>
                <Status status={t.status} />
              </button>
            ))}
        </div>
      ) : (
        <Overview
          snapshot={snapshot}
          refresh={refresh}
          open={open}
          all={page === "Tasks"}
        />
      )
    ) : (
      <div className="page">
        <h1>Connect the local execution core</h1>
        <p>
          Open Settings to select your WSL distribution and install the helper.
        </p>
        <Button onClick={() => setPage("Settings")}>Open Settings</Button>
      </div>
    );
  return (
    <div className="desktop-shell">
      <TitleBar onPalette={() => setPalette(true)} />
      <div className="app-shell">
        <aside className="sidebar" style={{ width: sidebarWidth }}>
          <div className="brand">
            <Workflow size={23} />
            <div>
              akkco <strong>vibestar</strong>
              <small>AGENT DEVELOPMENT ENVIRONMENT</small>
            </div>
          </div>
          <Button
            className="new-task-button"
            variant="default"
            onClick={() => setNewTask(true)}
            disabled={!snapshot}
          >
            <Plus size={15} />
            New task
          </Button>
          <nav>
            {navigation.map(([label, Icon]) => (
              <button
                className={page === label ? "selected" : ""}
                key={label}
                onClick={() => navigate(label)}
              >
                <Icon size={16} />
                {label}
                {label === "Tasks" && (
                  <small>{snapshot?.tasks.length || 0}</small>
                )}
              </button>
            ))}
          </nav>
          <div className="sidebar-label">Open source</div>
          <TaskNavigation
            repositories={snapshot?.repositories || []}
            tasks={snapshot?.tasks || []}
            selected={taskId}
            open={open}
          />
          <div className="sidebar-footer">
            <span className="local-dot" />
            Local · {snapshot?.settings.concurrency || 2} task slots
            <small>{snapshot?.root || "Awaiting core"}</small>
          </div>
        </aside>
        <ResizeHandle
          label="Resize navigation pane"
          value={sidebarWidth}
          onChange={setSidebarWidth}
          min={180}
          max={380}
        />
        <main className="main-area">
          {error && (
            <div className="global-error">
              <span>{error}</span>
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
                detail: "Issue + claimed scope",
                run: () => setNewTask(true),
              },
              ...navigation.map(([label]) => ({
                id: label,
                label: `Go to ${label}`,
                run: () => navigate(label),
              })),
              {
                id: "refresh",
                label: "Refresh local workspace",
                run: () => void refresh(),
              },
              ...(snapshot?.tasks || []).map((task) => ({
                id: `task-${task.id}`,
                label: `Open #${task.issue_number} · ${task.claimed_scope}`,
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
                      run: () => updateTaskView(taskId, { tab }),
                    })),
                    {
                      id: "dock",
                      label: "Toggle task terminal dock",
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
