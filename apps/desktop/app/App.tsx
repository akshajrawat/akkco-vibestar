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
            openTool={openTool}
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
          {snapshot?.fresh_start && (
            <div
              className="fresh-start-notice bg-surface-app border-b border-b-border-default px-4 py-3 flex flex-col gap-1"
              role="status"
              aria-label="Fresh database notice"
            >
              <div className="flex items-center gap-2 font-medium text-[13px] text-ink-primary">
                <span className="w-2 h-2 rounded-full bg-accent-blue" aria-hidden="true" />
                Vibestar started with a fresh database
              </div>
              <p className="text-[12px] text-ink-muted m-0 leading-normal">
                {snapshot.fresh_start.message}
              </p>
            </div>
          )}
          {snapshot?.warning && (
            <p
              className="helper-warning text-accent-amber px-4 py-2 m-0 border-b border-b-border-default text-[12px] leading-[1.4]"
              role="alert"
            >
              {snapshot.warning}
            </p>
          )}

          {chatProfile ? (
            <ViberChat key={chatProfile.id} profile={chatProfile} revision={revision} />
          ) : (
            <ViberWelcome
              create={createViber}
              disabled={!snapshot}
              hasVibers={profiles.length > 0}
            />
          )}
        </main>

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
