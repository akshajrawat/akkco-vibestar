import { useCallback, useRef, useState, type Ref } from "react";
import {
  Activity,
  CircleAlert,
  FolderGit2,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import type { AgentProfile, ViberMessagePreview } from "../../core/vibers/contracts";
import { ViberFace } from "../features/vibers/ViberFace";
import type { Snapshot, WorkspaceTool } from "../lib/types";

interface NavigationSidebarProps {
  collapsed: boolean;
  width: number;
  snapshot: Snapshot | null;
  profiles: AgentProfile[];
  previews: ViberMessagePreview[];
  profilesError: string;
  createViber: () => void;
  selectViber: (profile: AgentProfile) => void;
  selectedViber?: string;
  openTool: (tool: WorkspaceTool) => void;
  toggleSidebar: () => void;
  toggleRef?: Ref<HTMLButtonElement>;
}

export const collapsedSidebarWidth = 64;

const dockItems = [
  { tool: "Repositories", Icon: FolderGit2 },
  { tool: "Providers", Icon: Plug },
  { tool: "Usage", Icon: Activity },
  { tool: "Settings", Icon: Settings },
] as const;

const messageTime = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const messageDate = new Intl.DateTimeFormat(undefined, { dateStyle: "short" });

export const NavigationSidebar = ({
  collapsed,
  width,
  snapshot,
  profiles,
  previews,
  profilesError,
  createViber,
  selectViber,
  selectedViber,
  openTool,
  toggleSidebar,
  toggleRef,
}: NavigationSidebarProps) => {
  const [search, setSearch] = useState("");
  const focusOnExpand = useRef(false);

  const searchInput = useCallback((input: HTMLInputElement | null) => {
    if (input && focusOnExpand.current) {
      focusOnExpand.current = false;
      input.focus();
    }
  }, []);

  const previewsByProfile = new Map(previews.map((preview) => [preview.profile_id, preview]));
  const today = new Date().toDateString();

  const query = search.trim().toLowerCase();

  const visibleProfiles =
    collapsed || !query
      ? profiles
      : profiles.filter((profile) =>
          `${profile.name} ${profile.description || ""}`.toLowerCase().includes(query),
        );

  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const toggleLabel = collapsed ? "Expand sidebar" : "Collapse sidebar";

  return (
    <aside
      className={`sidebar flex flex-none flex-col min-w-0 min-h-0 text-foreground ${collapsed ? "sidebar-collapsed" : ""}`}
      style={{ width }}
      aria-label="Workspace navigation"
    >
      <div className="sidebar-brand-header flex items-center justify-between flex-[0_0_42px] pt-2 pb-1">
        {!collapsed && <span className="sidebar-brand-title">Vibestar</span>}
        <button
          ref={toggleRef}
          type="button"
          className="sidebar-icon-button"
          aria-label={toggleLabel}
          aria-expanded={!collapsed}
          title={`${toggleLabel} (Ctrl+B)`}
          onClick={toggleSidebar}
        >
          <ToggleIcon size={18} aria-hidden="true" />
        </button>
      </div>

      <div className="sidebar-content">
        <div className="sidebar-header">
          {collapsed ? (
            <button
              type="button"
              className="sidebar-icon-button"
              aria-label="Search vibers"
              title="Search vibers"
              onClick={() => {
                focusOnExpand.current = true;
                toggleSidebar();
              }}
            >
              <Search size={18} aria-hidden="true" />
            </button>
          ) : (
            <div className="sidebar-search">
              <label>
                <Search size={16} aria-hidden="true" />
                <input
                  ref={searchInput}
                  type="search"
                  aria-label="Search vibers"
                  placeholder="Search"
                  autoComplete="off"
                  spellCheck={false}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && search && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      event.stopPropagation();
                      setSearch("");
                    }
                  }}
                />
              </label>
              <button
                type="button"
                className="sidebar-new-viber"
                aria-label="Create Viber"
                title="Create Viber"
                onClick={createViber}
                disabled={!snapshot}
              >
                <Plus size={18} aria-hidden="true" />
              </button>
            </div>
          )}
        </div>

        <div className="sidebar-vibers" role="region" aria-label="Viber list">
          {profilesError && (
            <p
              role="alert"
              className={collapsed ? "sidebar-rail-error" : "error"}
              title={profilesError}
            >
              {collapsed && <CircleAlert size={16} aria-hidden="true" />}
              <span className={collapsed ? "sr-only" : undefined}>{profilesError}</span>
            </p>
          )}
          {visibleProfiles.length === 0 ? (
            <p
              className={collapsed ? "sr-only" : "px-3 py-6 text-ink-muted text-[12px] text-center"}
            >
              {query && !collapsed ? "No matching vibers" : "No vibers created yet"}
            </p>
          ) : (
            visibleProfiles.map((profile) => {
              const message = previewsByProfile.get(profile.id);
              const date = message ? new Date(message.created_at) : null;
              const preview = message?.content.replace(/\s+/g, " ").trim();
              const timestamp = date?.toDateString() === today ? messageTime : messageDate;

              return (
                <button
                  type="button"
                  className="sidebar-viber"
                  key={profile.id}
                  aria-current={selectedViber === profile.id ? "page" : undefined}
                  onClick={() => selectViber(profile)}
                  aria-label={collapsed ? `Chat with ${profile.name}` : undefined}
                  title={`Chat with ${profile.name}`}
                >
                  <ViberFace profile={profile} compact />
                  {!collapsed && (
                    <span className="sidebar-viber-details">
                      <strong>{profile.name}</strong>
                      {message && date && Number.isFinite(date.getTime()) && (
                        <time dateTime={message.created_at} title={date.toLocaleString()}>
                          {timestamp.format(date)}
                        </time>
                      )}
                      {preview && <small>{preview}</small>}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>

      <nav className="sidebar-dock" aria-label="Workspace tools">
        {dockItems
          .filter(({ tool }) => !collapsed || tool === "Settings")
          .map(({ tool, Icon }) => (
            <div key={tool} className="sidebar-dock-item">
              <button
                type="button"
                aria-label={tool}
                title={collapsed ? tool : undefined}
                aria-haspopup="dialog"
                onClick={() => openTool(tool)}
              >
                <Icon aria-hidden="true" />
              </button>
              {!collapsed && (
                <span className="sidebar-dock-label" aria-hidden="true">
                  {tool}
                </span>
              )}
            </div>
          ))}
      </nav>
    </aside>
  );
};
