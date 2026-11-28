import { useState, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useWorkspace } from "../hooks/useWorkspace";
import { DEFAULT_VIBER_INSTRUCTIONS, type AgentProfile } from "../../core/vibers/contracts";
import { defaultAppearance } from "../../core/vibers/appearance";
import { ViberChat } from "../features/vibers/ViberChat";
import { CreateViberDialog } from "../features/vibers/CreateViberDialog";
import type { WorkspaceTool } from "../lib/types";
import { useProfiles } from "../features/vibers/useProfiles";
import { ViberWelcome } from "../features/vibers/ViberWelcome";
import { CommandPalette } from "./CommandPalette";
import { ResizeHandle } from "../components/shared/ResizeHandle";
import { collapsedSidebarWidth, NavigationSidebar } from "./NavigationSidebar";
import { usePaneSize } from "../hooks/usePaneSize";
import { TitleBar } from "./TitleBar";
import { DataMigration } from "./DataMigration";
import { notifications as notify } from "../lib/notifications";
import { GlobalNotifications } from "./GlobalNotifications";
import { ToolOverlay } from "./ToolOverlay";
import { ComputerPanel } from "../features/computer/ComputerPanel";
import { Button } from "../components/ui/button";
import { WorkspaceOverlay } from "../components/ui/WorkspaceOverlay";
import { errorMessage, rpc } from "../lib/api";
import { useComputer } from "../features/computer/useComputer";

const minSidebarWidth = 220;
const maxSidebarWidth = 400;
const defaultSidebarWidth = 340;

const initialSidebarWidth = () => {
  const previousWidth = Number(
    localStorage.getItem("vibestar.navigationWidth") ||
      localStorage.getItem("vibestar.sidebarWidth"),
  );

  // Previous defaults saved 238px or 300px even when never resized.
  return previousWidth && previousWidth !== 238 && previousWidth !== 300
    ? previousWidth
    : defaultSidebarWidth;
};

const subscribeToWindowResize = (onResize: () => void) => {
  window.addEventListener("resize", onResize);
  return () => window.removeEventListener("resize", onResize);
};

const getWindowWidth = () => window.innerWidth;

export const App = () => {
  const { snapshot, error, runtimeUnavailable, refresh, revision } = useWorkspace();

  const {
    profiles,
    previews,
    createdAtByProfile,
    error: profilesError,
    refresh: refreshProfiles,
  } = useProfiles(revision);

  const [selectedViber, setSelectedViber] = useState<string>(
    () => localStorage.getItem("vibestar.activeViber") || "",
  );

  const [computerOpen, setComputerOpen] = useState(false);
  const [runtimePhase, setRuntimePhase] = useState<string>();
  const [connectionRetry, setConnectionRetry] = useState<{ runtime: boolean; issue?: string }>();
  const snapshotReady = Boolean(snapshot);
  const migrationPending = Boolean(snapshot?.migration);
  const runtimeFailed = runtimePhase === "failed" || runtimeUnavailable;

  const runtimeBusy = Boolean(
    runtimePhase && runtimePhase !== "ready" && runtimePhase !== "failed",
  );

  const computerSupported = snapshot?.capabilities?.shared_computer === 1;
  const computerAvailable = computerSupported && snapshotReady && !migrationPending;

  const computer = useComputer(
    computerSupported,
    computerAvailable && !runtimeFailed && !runtimeBusy && !connectionRetry?.runtime,
    true,
  );

  const [computerWidth, setComputerWidth] = usePaneSize("sharedComputerWidth", () => 480, 340, 680);

  const dockerUnavailable =
    computer.status?.docker?.ready === false && !computer.status.reset_pending;

  const connectionIssue = runtimeFailed
    ? "Execution helper disconnected"
    : dockerUnavailable
      ? "Docker disconnected"
      : connectionRetry?.issue;

  const connectionBusy = Boolean(
    connectionRetry || runtimeBusy || (!runtimeFailed && computer.status?.status === "starting"),
  );

  const retryConnection = async () => {
    if (connectionBusy) {
      return;
    }

    setConnectionRetry({ runtime: runtimeFailed, issue: connectionIssue });
    try {
      if (runtimeFailed) {
        await window.vibestar.retryRuntime();
        await refresh();
        refreshProfiles();
      } else if (computerAvailable) {
        if (
          !computer.status?.reset_pending &&
          (computer.status?.status === "error" || computer.status?.status === "stopped")
        ) {
          await computer.retry();
        } else {
          await computer.refreshStatus();
        }
      } else {
        await refresh();
      }
    } catch (reason) {
      notify.error(errorMessage(reason), { id: runtimeFailed ? "runtime" : "connection-retry" });
    } finally {
      setConnectionRetry(undefined);
    }
  };

  const [newProfile, setNewProfile] = useState<AgentProfile>();
  const [renameOnly, setRenameOnly] = useState(false);
  const [deleteProfile, setDeleteProfile] = useState<AgentProfile>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const [pinnedIds, setPinnedIds] = useState<string[]>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem("vibestar.pinnedVibers") || "[]");
      return Array.isArray(stored)
        ? [...new Set(stored.filter((id): id is string => typeof id === "string"))]
        : [];
    } catch {
      return [];
    }
  });

  const savePins = (next: string[]) => {
    setPinnedIds(next);
    localStorage.setItem("vibestar.pinnedVibers", JSON.stringify(next));
  };

  const confirmDelete = async (profile: AgentProfile) => {
    setDeleting(true);
    setDeleteError("");
    try {
      await rpc("profile.delete", { profile_id: profile.id, confirmed: true });
      savePins(pinnedIds.filter((id) => id !== profile.id));
      refreshProfiles();
      setDeleteProfile(undefined);
    } catch (reason) {
      setDeleteError(errorMessage(reason));
    } finally {
      setDeleting(false);
    }
  };

  const createViber = () => {
    if (!snapshot) {
      return;
    }

    setRenameOnly(false);

    setNewProfile({
      id: crypto.randomUUID(),
      revision: 0,
      name: "",
      appearance: defaultAppearance(),
      description: "",
      instructions: DEFAULT_VIBER_INSTRUCTIONS,
      supported_access: ["read-only", "workspace-write"],
      execution: {
        ...snapshot.settings.codex_implementation,
        provider: snapshot.settings.codex_implementation.provider || "codex",
        access: "workspace-write",
        output: "conversation",
      },
    });
  };

  const [tool, openTool] = useState<WorkspaceTool>();
  const [palette, setPalette] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const sidebarToggle = useRef<HTMLButtonElement>(null);

  const toggleSidebar = useCallback(() => {
    setSidebar((value) => !value);
  }, []);

  const [sidebarWidth, setSidebarWidth] = usePaneSize(
    "navigationPaneWidth",
    initialSidebarWidth,
    minSidebarWidth,
    maxSidebarWidth,
  );

  const windowWidth = useSyncExternalStore(subscribeToWindowResize, getWindowWidth);

  useEffect(() => {
    if (runtimePhase && runtimePhase !== "ready") {
      notify.dismiss("workspace-error");
    } else if (error) {
      notify.error(error, { id: "workspace-error" });
    }
  }, [error, runtimePhase]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.isComposing) {
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPalette((v) => !v);
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        sidebarToggle.current?.focus();
        toggleSidebar();
      }
    };

    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [toggleSidebar]);

  const computerBoot = useMemo(
    () => ({
      snapshotReady,
      migrationPending,
      supported: computerSupported,
      status: computer.status,
      didStart: computer.didStart,
      retry: computer.retry,
    }),
    [
      snapshotReady,
      migrationPending,
      computerSupported,
      computer.status,
      computer.didStart,
      computer.retry,
    ],
  );

  const openViber = useCallback((profile: AgentProfile) => {
    setSelectedViber(profile.id);
    localStorage.setItem("vibestar.activeViber", profile.id);
  }, []);

  const chatProfile = profiles.find((p) => p.id === selectedViber) || profiles[0];

  const availableSidebarWidth = Math.max(
    minSidebarWidth,
    Math.min(maxSidebarWidth, Math.floor(windowWidth / 2), windowWidth - 260),
  );

  const visibleSidebarWidth = sidebar
    ? Math.min(sidebarWidth, availableSidebarWidth)
    : collapsedSidebarWidth;

  const maxComputerWidth = Math.max(340, Math.min(680, windowWidth - visibleSidebarWidth - 320));

  const visibleComputerWidth = Math.min(computerWidth, maxComputerWidth);

  return (
    <div className="desktop-shell flex flex-col">
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {snapshot?.migration && <DataMigration migration={snapshot.migration} refresh={refresh} />}
        <NavigationSidebar
          collapsed={!sidebar}
          toggleSidebar={toggleSidebar}
          toggleRef={sidebarToggle}
          width={visibleSidebarWidth}
          snapshot={snapshot}
          profiles={profiles}
          previews={previews}
          createdAtByProfile={createdAtByProfile}
          profilesError={profilesError}
          createViber={createViber}
          selectViber={openViber}
          selectedViber={chatProfile?.id}
          pinnedIds={pinnedIds}
          onViberAction={(action, profile) => {
            if (action === "pin") {
              savePins(
                pinnedIds.includes(profile.id)
                  ? pinnedIds.filter((id) => id !== profile.id)
                  : [...pinnedIds, profile.id],
              );
            } else if (action === "delete") {
              setDeleteError("");
              setDeleteProfile(profile);
            } else {
              setRenameOnly(action === "rename");
              setNewProfile(profile);
            }
          }}
          openTool={openTool}
          connection={{ issue: connectionIssue, busy: connectionBusy, retry: retryConnection }}
        />

        {sidebar && (
          <ResizeHandle
            className="navigation-resize-handle"
            label="Resize navigation pane"
            value={visibleSidebarWidth}
            onChange={setSidebarWidth}
            min={minSidebarWidth}
            max={availableSidebarWidth}
          />
        )}

        <div className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden">
          <GlobalNotifications
            preference={snapshot?.settings.notification_preference}
            onRuntimeStatus={setRuntimePhase}
            computer={computerBoot}
          />
          <TitleBar
            profile={chatProfile}
            computerOpen={computerOpen}
            onToggleComputer={() => setComputerOpen((open) => !open)}
          />
          <div className="flex flex-1 min-h-0 overflow-hidden">
            <main className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden">
              {snapshot?.warning && (
                <p
                  className="helper-warning text-accent-amber px-4 py-2 m-0 border-b border-b-border-default text-[12px] leading-[1.4]"
                  role="alert"
                >
                  {snapshot.warning}
                </p>
              )}

              {chatProfile ? (
                <ViberChat
                  key={chatProfile.id}
                  profile={chatProfile}
                  revision={revision}
                  computerSupported={computerSupported}
                  settings={snapshot?.settings}
                />
              ) : (
                <ViberWelcome
                  create={createViber}
                  disabled={!snapshot}
                  hasVibers={profiles.length > 0}
                />
              )}
            </main>

            {computerOpen && (
              <>
                <ResizeHandle
                  label="Resize computer panel"
                  value={visibleComputerWidth}
                  onChange={setComputerWidth}
                  min={340}
                  max={maxComputerWidth}
                  reverse
                />
                <div
                  className="min-h-0 shrink-0 max-w-[80vw]"
                  style={{ width: visibleComputerWidth }}
                >
                  <ComputerPanel
                    status={computer.status}
                    supported={computerSupported}
                    reset={computer.reset}
                  />
                </div>
              </>
            )}
          </div>
        </div>

        {tool && (
          <ToolOverlay
            key={tool}
            tool={tool}
            snapshot={snapshot}
            refresh={refresh}
            error={error}
            close={() => openTool(undefined)}
          />
        )}

        {newProfile && (
          <CreateViberDialog
            key={newProfile.id}
            profile={newProfile}
            renameOnly={renameOnly}
            close={() => {
              setNewProfile(undefined);
            }}
            saved={(created) => {
              refreshProfiles();
              if (!newProfile.revision) {
                openViber(created);
              }
            }}
          />
        )}

        {deleteProfile && (
          <WorkspaceOverlay
            label="Delete Viber"
            className="viber-delete-overlay"
            onClose={() => {
              if (!deleting) {
                setDeleteProfile(undefined);
              }
            }}
          >
            <h2>Delete {deleteProfile.name}?</h2>
            <p className="mt-2 text-ink-secondary">
              This removes the Viber and its private workspace.
            </p>
            {deleteError && (
              <p className="error" role="alert">
                {deleteError}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <Button disabled={deleting} onClick={() => setDeleteProfile(undefined)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                busy={deleting}
                onClick={() => void confirmDelete(deleteProfile)}
              >
                Delete Viber
              </Button>
            </div>
          </WorkspaceOverlay>
        )}

        {palette && (
          <CommandPalette
            close={() => setPalette(false)}
            actions={[
              {
                id: "create-viber",
                label: "Create Viber",
                detail: "AI employee",
                run: createViber,
              },
              ...profiles.map((p) => ({
                id: `viber-${p.id}`,
                label: `Chat with ${p.name}`,
                detail: p.description || "Viber",
                run: () => openViber(p),
              })),
              {
                id: "computer",
                label: "Computer",
                detail: "Shared workspace desktop",
                run: () => setComputerOpen(true),
              },
              {
                id: "repositories",
                label: "Repositories",
                detail: "Workspace checkouts",
                run: () => openTool("Repositories"),
              },
              {
                id: "providers",
                label: "Providers",
                detail: "Codex & Antigravity",
                run: () => openTool("Providers"),
              },
              {
                id: "usage",
                label: "AI Usage",
                detail: "Token and runtime metrics",
                run: () => openTool("Usage"),
              },
              {
                id: "settings",
                label: "Settings",
                detail: "System configuration",
                run: () => openTool("Settings"),
              },
            ]}
          />
        )}
      </div>
    </div>
  );
};
