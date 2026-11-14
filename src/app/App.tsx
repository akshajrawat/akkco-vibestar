import { useState, useCallback, useEffect, useRef, Activity } from "react";
import { X, Search, ListTodo, Bot, GitPullRequest, FolderGit2, Plug, Settings } from "lucide-react";
import type { Page } from "../lib/types";
import { useWorkspace, useDetail } from "../hooks/useWorkspace";
import { Overview } from "../features/tasks/Overview";
import { RepositoryPage } from "../features/repositories/RepositoryPage";
import { NewTask } from "../features/tasks/NewTask";
import { HistoricalTask } from "../features/flows/HistoricalTask";
import { FlowWorkspace } from "../features/flows/FlowWorkspace";
import { NewViberTask } from "../features/flows/NewViberTask";
import { ProfileLibrary } from "../features/flows/ProfileLibrary";
import { ProvidersPage } from "../features/providers/ProvidersPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { Button } from "../components/ui/button";
import { ListSkeleton, PageHeader } from "../components/ui/PageHeader";
import { CommandPalette } from "./CommandPalette";
import { ResizeHandle } from "../components/shared/ResizeHandle";
import { NavigationSidebar } from "./NavigationSidebar";
import { usePaneSize } from "../hooks/usePaneSize";
import {
  useTaskView,
  updateTaskView,
  openWorkspaceTool,
  workspaceSections,
  flowWorkspaceSections,
  type FlowWorkspaceSection,
  type SecondarySection,
} from "../lib/taskView";
import { rpc, errorMessage } from "../lib/api";
import { ScheduledPage } from "../features/pull-requests/ScheduledPage";
import { usePRWatch } from "../features/pull-requests/usePRWatch";
import { TitleBar } from "./TitleBar";
import { DataMigration } from "./DataMigration";
import { RepairWorkspace } from "../features/pull-requests/repair/RepairWorkspace";
import { IssueWatchPage } from "../features/issue-watch/IssueWatchPage";
import { UsageView } from "../features/usage/UsageView";
import { useWatchNotifications } from "../features/issue-watch/notifications";

const navigation = [
  ["Tasks", ListTodo],
  ["Vibers", Bot],
  ["Scheduled", GitPullRequest],
  ["Issue Watch", Search],
  ["Repositories", FolderGit2],
  ["Providers", Plug],
  ["Usage", Activity],
  ["Settings", Settings],
] as const;

export const App = () => {
  const { snapshot, error, setError, refresh, revision } = useWorkspace();
  usePRWatch(snapshot?.capabilities?.pr_quick_watch === true);
  const [page, setPage] = useState<Page>("Tasks");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newViberProfile, setNewViberProfile] = useState<string>();

  const [taskId, setTaskId] = useState<string | null>(() =>
    localStorage.getItem("vibestar.activeTask"),
  );

  const [palette, setPalette] = useState(false);

  const [repairId, setRepairId] = useState<string | null>(() =>
    localStorage.getItem("vibestar.activeRepair"),
  );

  const [newTask, setNewTask] = useState(false);
  const [issueTask, setIssueTask] = useState(false);
  const [newTaskRepository, setNewTaskRepository] = useState<string>();

  const [taskPrefill, setTaskPrefill] = useState<{
    url: string;
    notes: string;
  }>();

  const [watchId, setWatchId] = useState<string | null>(null);
  const notifications = useWatchNotifications(snapshot?.capabilities?.manual_issue_watch === true);
  const [sidebar, setSidebar] = useState(true);
  const sidebarToggle = useRef<HTMLButtonElement>(null);

  const toggleSidebar = useCallback(() => {
    setSidebar((value) => !value);
    requestAnimationFrame(() => sidebarToggle.current?.focus());
  }, []);

  const [sidebarWidth, setSidebarWidth] = usePaneSize("sidebarWidth", 238, 180, 380);
  const workspaceId = taskId || repairId;
  const activeView = useTaskView(workspaceId || "");
  const { detail, error: detailError } = useDetail(taskId, revision);
  const flowTask = !!taskId && detail?.task.id === taskId && !!detail.task.flow_id;
  const onError = useCallback((s: string) => setError(s), [setError]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPalette((v) => !v);
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      }
    };

    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [toggleSidebar]);

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
    if (p === "Settings") {
      setSettingsOpen(true);
      return;
    }

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

  const watchItems = snapshot?.pr_watch?.items || [];

  const count =
    watchItems.filter(
      (item) => item.lifecycle === "OPEN" && ["review", "unknown"].includes(item.status),
    ).length +
    (snapshot?.attention || []).filter(
      (attention) =>
        !watchItems.some(
          (item) =>
            item.url === snapshot?.scheduled?.find((job) => job.id === attention.job_id)?.url,
        ),
    ).length;

  const content =
    page === "Scheduled" && snapshot ? (
      <ScheduledPage
        snapshot={snapshot}
        connectGitHub={() => navigate("Providers")}
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
    ) : page === "Vibers" ? (
      <div className="viber-library-page">
        <ProfileLibrary
          revision={revision}
          chat={(profileId) => {
            setNewViberProfile(profileId);
            setNewTask(true);
          }}
          openInstance={(id, nodeId) => {
            updateTaskView(id, { flowSection: "chat", flowNode: nodeId });
            open(id);
          }}
        />
      </div>
    ) : page === "Usage" ? (
      <UsageView
        openRun={(row) => {
          const id = row.task_id || row.repair_id;
          if (!id) return;
          if (row.task_id) open(id);
          else openRepair(id);

          updateTaskView(id, {
            ...(row.task_id ? { flowSection: "logs" } : {}),
            secondaryOpen: true,
            secondarySection: "run-details",
            outputRun: row.id,
          });
        }}
      />
    ) : page === "Providers" ? (
      <ProvidersPage />
    ) : page === "Repositories" && snapshot ? (
      <RepositoryPage
        snapshot={snapshot}
        refresh={refresh}
        createTask={(id) => {
          setNewTaskRepository(id);
          setNewTask(true);
        }}
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
        detail.task.flow_id ? (
          <FlowWorkspace
            key={taskId}
            detail={detail}
            repository={snapshot?.repositories.find(
              (repository) => repository.id === detail.task.repo_id,
            )}
            revision={revision}
            onError={onError}
            back={() => setTaskId(null)}
          />
        ) : (
          <HistoricalTask key={taskId} detail={detail} back={() => setTaskId(null)} />
        )
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
        <PageHeader
          title={error ? "Execution environment unavailable" : "Connecting execution environment…"}
          description={
            error
              ? "Inspect the execution settings and reconnect the helper to load your saved workspace."
              : "Starting the local core and loading saved tasks, repositories and settings."
          }
          actions={<Button onClick={() => navigate("Settings")}>Open Settings</Button>}
        />
        {!error && <ListSkeleton label="Loading the saved workspace" />}
      </div>
    );

  return (
    <div className="desktop-shell">
      <div className="app-shell">
        {snapshot?.migration && <DataMigration migration={snapshot.migration} refresh={refresh} />}
        {sidebar && (
          <NavigationSidebar
            toggleSidebar={toggleSidebar}
            toggleRef={sidebarToggle}
            width={sidebarWidth}
            revision={revision}
            snapshot={snapshot}
            page={settingsOpen ? "Settings" : page}
            count={count}
            taskId={taskId}
            newTask={() => setNewTask(true)}
            navigate={navigate}
            open={open}
            onError={onError}
          />
        )}

        {sidebar && (
          <ResizeHandle
            label="Resize navigation pane"
            value={sidebarWidth}
            onChange={setSidebarWidth}
            min={180}
            max={380}
          />
        )}

        <main className="main-area">
          <TitleBar
            onPalette={() => setPalette(true)}
            onSidebar={sidebar ? undefined : toggleSidebar}
            toggleRef={sidebarToggle}
          />
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

          {notifications.notices.length > 0 && page !== "Issue Watch" && (
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

        {settingsOpen && (
          <SettingsPage
            settings={snapshot?.settings}
            root={snapshot?.root}
            diagnostics={snapshot?.persistence}
            snapshot={snapshot || undefined}
            refresh={refresh}
            close={() => setSettingsOpen(false)}
          />
        )}

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
                  void window.electronWindow.fullscreen().catch((e) => onError(errorMessage(e))),
              },
              {
                id: "window-maximize",
                label: "Window: Maximize / restore",
                run: () =>
                  void window.electronWindow.maximize().catch((e) => onError(errorMessage(e))),
              },
              ...(snapshot?.tasks || []).map((task) => ({
                id: `task-${task.id}`,
                label:
                  task.goal ||
                  `Open #${task.issue_number} · ${task.claimed_scope || task.issue?.title}`,
                detail: task.branch_name,
                run: () => open(task.id),
              })),
              ...(workspaceId
                ? [
                    {
                      id: "task-chat",
                      label: `${repairId ? "Repair" : "Task"}: Return to chat`,
                      run: () =>
                        updateTaskView(workspaceId, {
                          expandedTool: false,
                          ...(flowTask ? { flowSection: "chat" } : {}),
                        }),
                    },
                    ...Object.entries(flowTask ? flowWorkspaceSections : workspaceSections).map(
                      ([key, label]) => ({
                        id: `task-tool-${key}`,
                        label: `${repairId ? "Repair" : "Task"}: ${label}`,
                        run: () =>
                          flowTask
                            ? updateTaskView(workspaceId, {
                                flowSection: key as FlowWorkspaceSection,
                              })
                            : openWorkspaceTool(workspaceId, key as SecondarySection),
                      }),
                    ),
                    {
                      id: "task-terminal",
                      label: `${repairId ? "Repair" : "Task"}: Terminal`,
                      detail: "Ctrl+backtick",
                      run: () =>
                        updateTaskView(workspaceId, {
                          terminalDock: true,
                          dockTab: "Terminal",
                        }),
                    },
                    {
                      id: "task-problems",
                      label: `${repairId ? "Repair" : "Task"}: Problems`,
                      run: () =>
                        updateTaskView(workspaceId, {
                          terminalDock: true,
                          dockTab: "Problems",
                        }),
                    },
                    {
                      id: "dock",
                      label: "Toggle utility dock",
                      run: () =>
                        updateTaskView(workspaceId, {
                          terminalDock: !activeView.terminalDock,
                        }),
                    },
                    {
                      id: "open-directory",
                      label: "Open assigned task worktree",
                      run: () =>
                        void rpc("open.directory", {
                          id: workspaceId,
                          kind: repairId ? "repair" : "task",
                        }).catch((e) => onError(errorMessage(e))),
                    },
                  ]
                : []),
            ]}
          />
        )}

        {newTask && snapshot?.capabilities?.agent_flows === 1 && !issueTask && !taskPrefill ? (
          <NewViberTask
            repositories={snapshot.repositories}
            initialRepositoryId={newTaskRepository}
            initialProfileId={newViberProfile}
            close={() => {
              setNewTask(false);
              setNewTaskRepository(undefined);
              setNewViberProfile(undefined);
            }}
            created={async (id) => {
              await refresh();
              open(id);
              if (newViberProfile) updateTaskView(id, { flowSection: "chat" });
            }}
            issueTask={() => setIssueTask(true)}
          />
        ) : (
          newTask && (
            <NewTask
              initialRepositoryId={newTaskRepository}
              initialIssueUrl={taskPrefill?.url}
              initialNotes={taskPrefill?.notes}
              close={() => {
                setNewTask(false);
                setNewTaskRepository(undefined);
                setTaskPrefill(undefined);
                setIssueTask(false);
              }}
              created={async (id) => {
                await refresh();

                updateTaskView(id, {
                  secondaryOpen: window.innerWidth >= 1200,
                  secondarySection: "pipeline",
                });

                open(id);
              }}
            />
          )
        )}
      </div>
    </div>
  );
};
