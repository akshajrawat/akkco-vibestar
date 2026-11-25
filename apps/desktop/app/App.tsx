import { useState, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useWorkspace } from "../hooks/useWorkspace";
import { DEFAULT_VIBER_INSTRUCTIONS, type AgentProfile } from "../../core/vibers/contracts";
import { randomAppearance } from "../../core/vibers/appearance";
import { ViberChat } from "../features/vibers/ViberChat";
import { CreateViberDialog } from "../features/vibers/CreateViberDialog";
import type { WorkspaceTool } from "../lib/types";
import { useProfiles } from "../features/vibers/useProfiles";
import { ViberWelcome } from "../features/vibers/ViberWelcome";
import { CommandPalette } from "./CommandPalette";
import { ResizeHandle } from "../components/shared/ResizeHandle";
import { NavigationSidebar } from "./NavigationSidebar";
import { usePaneSize } from "../hooks/usePaneSize";
import { TitleBar } from "./TitleBar";
import { DataMigration } from "./DataMigration";
import { notifications as notify } from "../lib/notifications";
import { GlobalNotifications } from "./GlobalNotifications";
import { ToolOverlay } from "./ToolOverlay";
import { ComputerPanel } from "../features/computer/ComputerPanel";
import { useComputer } from "../features/computer/useComputer";

const minSidebarWidth = 200;
const maxSidebarWidth = 320;

const initialSidebarWidth = () => {
  const previousWidth = Number(localStorage.getItem("vibestar.sidebarWidth"));
  // The previous sidebar saved 238px even when it had never been resized.
  return previousWidth && previousWidth !== 238 ? previousWidth : 300;
};

const subscribeToWindowResize = (onResize: () => void) => {
  window.addEventListener("resize", onResize);
  return () => window.removeEventListener("resize", onResize);
};

const getWindowWidth = () => window.innerWidth;

export const App = () => {
  const { snapshot, error, refresh, revision } = useWorkspace();

  const {
    profiles,
    previews,
    error: profilesError,
    refresh: refreshProfiles,
  } = useProfiles(revision);

  const [selectedViber, setSelectedViber] = useState<string>(
    () => localStorage.getItem("vibestar.activeViber") || "",
  );

  const [computerOpen, setComputerOpen] = useState(false);
  const computerSupported = snapshot?.capabilities?.shared_computer === 1;
  const computer = useComputer(computerSupported, computerOpen);
  const [computerWidth, setComputerWidth] = usePaneSize("sharedComputerWidth", () => 480, 340, 680);
  const [executionSettings, setExecutionSettings] = useState(false);

  const [newProfile, setNewProfile] = useState<AgentProfile>();

  const createViber = () => {
    if (!snapshot) {
      return;
    }

    setNewProfile({
      id: crypto.randomUUID(),
      revision: 0,
      name: "",
      appearance: randomAppearance(),
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

  const [runtimePhase, setRuntimePhase] = useState<string>();
  const [tool, openTool] = useState<WorkspaceTool>();
  const [palette, setPalette] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const sidebarToggle = useRef<HTMLButtonElement>(null);

  const toggleSidebar = useCallback(() => {
    setSidebar((value) => !value);
    requestAnimationFrame(() => sidebarToggle.current?.focus());
  }, []);

  const [sidebarWidth, setSidebarWidth] = usePaneSize(
    "navigationWidth",
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
        toggleSidebar();
      }
    };

    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [toggleSidebar]);

  const openExecutionSettings = () => {
    setExecutionSettings(true);
    openTool("Settings");
  };

  const openViber = useCallback((profile: AgentProfile) => {
    setSelectedViber(profile.id);
    localStorage.setItem("vibestar.activeViber", profile.id);
  }, []);

  const chatProfile = profiles.find((p) => p.id === selectedViber) || profiles[0];

  const availableSidebarWidth = Math.max(
    minSidebarWidth,
    Math.min(maxSidebarWidth, Math.floor(windowWidth / 2), windowWidth - 260),
  );

  const visibleSidebarWidth = Math.min(sidebarWidth, availableSidebarWidth);

  const maxComputerWidth = Math.max(
    340,
    Math.min(680, windowWidth - (sidebar ? visibleSidebarWidth : 0) - 320),
  );

  const visibleComputerWidth = Math.min(computerWidth, maxComputerWidth);

  return (
    <div className="desktop-shell flex flex-col">
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {snapshot?.migration && <DataMigration migration={snapshot.migration} refresh={refresh} />}
        {sidebar && (
          <NavigationSidebar
            toggleSidebar={toggleSidebar}
            toggleRef={sidebarToggle}
            width={visibleSidebarWidth}
            snapshot={snapshot}
            profiles={profiles}
            previews={previews}
            profilesError={profilesError}
            createViber={createViber}
            selectViber={openViber}
            selectedViber={chatProfile?.id}
            openTool={(value) => {
              setExecutionSettings(false);
              openTool(value);
            }}
            computerOpen={computerOpen}
            toggleComputer={() => setComputerOpen((open) => !open)}
          />
        )}

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

        <main className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden">
          <GlobalNotifications
            preference={snapshot?.settings.notification_preference}
            onRuntimeStatus={setRuntimePhase}
          />
          <TitleBar
            profile={chatProfile}
            onSidebar={sidebar ? undefined : toggleSidebar}
            toggleRef={sidebarToggle}
          />
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
            <div className="min-h-0 shrink-0 max-w-[80vw]" style={{ width: visibleComputerWidth }}>
              <ComputerPanel
                supported={computerSupported}
                status={computer.status}
                refresh={computer.refresh}
                hide={() => setComputerOpen(false)}
                settings={openExecutionSettings}
              />
            </div>
          </>
        )}

        {tool && (
          <ToolOverlay
            key={tool}
            tool={tool}
            snapshot={snapshot}
            executionSettings={executionSettings}
            refresh={refresh}
            error={error}
            close={() => openTool(undefined)}
          />
        )}

        {newProfile && (
          <CreateViberDialog
            key={newProfile.id}
            profile={newProfile}
            close={() => {
              setNewProfile(undefined);
            }}
            saved={(created) => {
              refreshProfiles();
              openViber(created);
            }}
          />
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
                run: () => {
                  setExecutionSettings(false);
                  openTool("Settings");
                },
              },
            ]}
          />
        )}
      </div>
    </div>
  );
};
