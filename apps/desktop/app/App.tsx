import { useState, useCallback, useEffect, useRef, Activity } from "react";
import { Search, ListTodo, Bot, GitPullRequest, FolderGit2, Plug, Settings } from "lucide-react";
import type { Page } from "../lib/types";
import { useWorkspace, useDetail } from "../hooks/useWorkspace";
import { Overview } from "../features/tasks/Overview";
import { RepositoryPage } from "../features/repositories/RepositoryPage";
import { NewTask } from "../features/tasks/NewTask";
import { HistoricalTask } from "../features/flows/HistoricalTask";
import { FlowWorkspace } from "../features/flows/FlowWorkspace";
import { NewViberTask } from "../features/flows/NewViberTask";
import type { AgentProfile } from "../../core/flows/contracts";
import { ViberChat } from "../features/flows/ViberChat";
import { ProfileEditor } from "../features/flows/ProfileEditor";
import { useProfiles } from "../features/flows/useProfiles";
import { ViberWelcome } from "../features/flows/ViberWelcome";
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
import { notifications as notify } from "../lib/notifications";
import { GlobalNotifications } from "./GlobalNotifications";
import { useTaskNotifications } from "./useTaskNotifications";

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
  const { profiles, error: profilesError, refresh: refreshProfiles } = useProfiles(revision);
  const [selectedViber, setSelectedViber] = useState<string>();
  const [profileEditor, setProfileEditor] = useState<AgentProfile>();

  const createViber = () => {
    if (!snapshot) return;

    setProfileEditor({
      id: crypto.randomUUID(),
      revision: 0,
      name: "",
      description: "",
      instructions: "",
      supported_access: ["read-only", "workspace-write"],
      execution: {
        ...snapshot.settings.codex_implementation,
        provider: snapshot.settings.codex_implementation.provider || "codex",
        access: "workspace-write",
        output: "conversation",
      },
    });
  };

  const [page, setPage] = useState<Page>("Tasks");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [runtimePhase, setRuntimePhase] = useState<string>();

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
    if (runtimePhase && runtimePhase !== "ready") notify.dismiss("workspace-error");
    else if (error) notify.error(error, { id: "workspace-error" });
  }, [error, runtimePhase]);

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

  const open = useCallback((id: string) => {
    setRepairId(null);
    localStorage.removeItem("vibestar.activeRepair");
    setTaskId(id);
    setPage("Tasks");
    localStorage.setItem("vibestar.activeTask", id);
  }, []);

  useTaskNotifications(snapshot, open);

  const navigate = useCallback((p: Page) => {
    if (p === "Settings") {
      setSettingsOpen(true);
      return;
    }

    setPage(p);
    if (p === "Vibers") setSelectedViber(undefined);
    setWatchId(null);
    setTaskId(null);
    setRepairId(null);
    localStorage.removeItem("vibestar.activeRepair");
  }, []);

  useEffect(() => {
    if (page === "Issue Watch") return;
    for (const notice of notifications.notices) {
      notify.information(notice.text, {
        id: `scan:${notice.id}`,
        action: {
          label: "View results",
          run: () => {
            navigate("Issue Watch");
            setWatchId(notice.watchId);
          },
        },
      });

      notifications.dismiss(notice.id);
    }
  }, [notifications, navigate, page]);

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

  const openViber = (profile: AgentProfile) => {
    setSelectedViber(profile.id);
    setPage("Vibers");
  };

  const chatProfile = profiles.find((profile) => profile.id === selectedViber);

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
    ) : page === "Vibers" && chatProfile ? (
      <ViberChat
        key={chatProfile.id}
        profile={chatProfile}
        revision={revision}
        edit={setProfileEditor}
        openTask={(id) => {
          updateTaskView(id, { flowSection: "logs" });
          open(id);
        }}
      />
    ) : page === "Vibers" ? (
      <ViberWelcome create={createViber} disabled={!snapshot} hasVibers={profiles.length > 0} />
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
            profiles={profiles}
            profilesError={profilesError}
            createViber={createViber}
            selectViber={openViber}
            selectedViber={selectedViber}
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
          <GlobalNotifications
            preference={snapshot?.settings.notification_preference}
            onRuntimeStatus={setRuntimePhase}
          />
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

          {content}
        </main>

        <SettingsPage
          open={settingsOpen}
          settings={snapshot?.settings}
          root={snapshot?.root}
          diagnostics={snapshot?.persistence}
          snapshot={snapshot || undefined}
          refresh={refresh}
          close={() => setSettingsOpen(false)}
        />

        {profileEditor && (
          <ProfileEditor
            key={profileEditor.id}
            profile={profileEditor}
            close={() => setProfileEditor(undefined)}
            saved={refreshProfiles}
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
            close={() => {
              setNewTask(false);
              setNewTaskRepository(undefined);
            }}
            created={async (id) => {
              await refresh();
              open(id);
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
