import { useState, useCallback, useEffect, useRef } from "react";
import type { Page } from "../lib/types";
import { useWorkspace } from "../hooks/useWorkspace";
import { RepositoryPage } from "../features/repositories/RepositoryPage";
import type { AgentProfile } from "../../core/vibers/contracts";
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
import { TitleBar } from "./TitleBar";
import { DataMigration } from "./DataMigration";
import { UsageView } from "../features/usage/UsageView";
import { notifications as notify } from "../lib/notifications";
import { GlobalNotifications } from "./GlobalNotifications";

export const App = () => {
  const { snapshot, error, refresh, revision } = useWorkspace();
  const { profiles, error: profilesError, refresh: refreshProfiles } = useProfiles(revision);

  const [selectedViber, setSelectedViber] = useState<string>(
    () => localStorage.getItem("vibestar.activeViber") || "",
  );

  const [computerOpen, setComputerOpen] = useState(
    () => localStorage.getItem("vibestar.computerOpen") !== "false",
  );

  const toggleComputer = () =>
    setComputerOpen((open) => {
      localStorage.setItem("vibestar.computerOpen", String(!open));
      return !open;
    });

  const [profileEditor, setProfileEditor] = useState<AgentProfile>();

  const createViber = () => {
    if (!snapshot) {
      return;
    }

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

  const [page, setPage] = useState<Page>("Vibers");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [runtimePhase, setRuntimePhase] = useState<string>();
  const [palette, setPalette] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const sidebarToggle = useRef<HTMLButtonElement>(null);

  const toggleSidebar = useCallback(() => {
    setSidebar((value) => !value);
    requestAnimationFrame(() => sidebarToggle.current?.focus());
  }, []);

  const [sidebarWidth, setSidebarWidth] = usePaneSize("sidebarWidth", 238, 180, 380);

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
    setPage("Vibers");
  }, []);

  const navigate = useCallback((target: Page) => {
    if (target === "Settings") {
      setSettingsOpen(true);
    } else {
      setPage(target);
    }
  }, []);

  const chatProfile = profiles.find((p) => p.id === selectedViber) || profiles[0];

  const content =
    page === "Vibers" && chatProfile ? (
      <ViberChat
        key={chatProfile.id}
        profile={chatProfile}
        computerOpen={computerOpen}
        hideComputer={toggleComputer}
        revision={revision}
        edit={setProfileEditor}
      />
    ) : page === "Vibers" ? (
      <ViberWelcome create={createViber} disabled={!snapshot} hasVibers={profiles.length > 0} />
    ) : page === "Usage" ? (
      <UsageView />
    ) : page === "Providers" ? (
      <ProvidersPage />
    ) : page === "Repositories" && snapshot ? (
      <RepositoryPage snapshot={snapshot} refresh={refresh} />
    ) : (
      <div className="page">
        <PageHeader
          title={error ? "Execution environment unavailable" : "Connecting execution environment…"}
          description={
            error
              ? "Inspect the execution settings and reconnect the helper to load your saved workspace."
              : "Starting the local core and loading saved vibers, repositories and settings."
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
            page={page}
            profiles={profiles}
            profilesError={profilesError}
            createViber={createViber}
            selectViber={openViber}
            selectedViber={selectedViber}
            navigate={navigate}
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
            onComputer={page === "Vibers" && chatProfile ? toggleComputer : undefined}
            computerOpen={computerOpen}
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
                run: () => navigate("Repositories"),
              },
              {
                id: "providers",
                label: "Providers",
                detail: "Codex & Antigravity",
                run: () => navigate("Providers"),
              },
              {
                id: "usage",
                label: "AI Usage",
                detail: "Token and runtime metrics",
                run: () => navigate("Usage"),
              },
              {
                id: "settings",
                label: "Settings",
                detail: "System configuration",
                run: () => setSettingsOpen(true),
              },
            ]}
          />
        )}
      </div>
    </div>
  );
};
