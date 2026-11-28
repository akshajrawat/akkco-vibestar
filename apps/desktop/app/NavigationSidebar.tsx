import { useCallback, useRef, useState, type MouseEvent, type Ref } from "react";
import {
  Activity,
  CircleAlert,
  FolderGit2,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Pencil,
  RefreshCw,
  SquarePen,
  Trash2,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import {
  viberGreeting,
  type AgentProfile,
  type ViberMessagePreview,
} from "../../core/vibers/contracts";
import { ViberFace } from "../features/vibers/ViberFace";
import type { Snapshot, WorkspaceTool } from "../lib/types";

interface NavigationSidebarProps {
  collapsed: boolean;
  width: number;
  snapshot: Snapshot | null;
  profiles: AgentProfile[];
  previews: ViberMessagePreview[];
  createdAtByProfile?: Record<string, string>;
  profilesError: string;
  createViber: () => void;
  selectViber: (profile: AgentProfile) => void;
  selectedViber?: string;
  openTool: (tool: WorkspaceTool) => void;
  toggleSidebar: () => void;
  pinnedIds?: string[];
  onViberAction?: (action: "rename" | "edit" | "pin" | "delete", profile: AgentProfile) => void;
  toggleRef?: Ref<HTMLButtonElement>;
  connection?: { issue?: string; busy: boolean; retry: () => Promise<void> };
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
  createdAtByProfile,
  profilesError,
  createViber,
  selectViber,
  selectedViber,
  openTool,
  toggleSidebar,
  toggleRef,
  pinnedIds = [],
  onViberAction,
  connection,
}: NavigationSidebarProps) => {
  const [search, setSearch] = useState("");
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; opener: HTMLElement }>();
  const focusOnExpand = useRef(false);
  const focusAfterPin = useRef<string>(null);

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

  const pinned = pinnedIds
    .map((id) => visibleProfiles.find((profile) => profile.id === id))
    .filter((profile) => profile !== undefined);

  const unpinned = visibleProfiles.filter((profile) => !pinnedIds.includes(profile.id));
  const menuProfile = profiles.find((profile) => profile.id === menu?.id);

  const closeMenu = () => {
    setMenu(undefined);
    menu?.opener.focus();
  };

  const openMenu = (event: MouseEvent<HTMLButtonElement>, id: string) => {
    if (!onViberAction) {
      return;
    }

    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();

    setMenu({
      id,
      x: Math.max(8, Math.min(window.innerWidth - 184, event.clientX || bounds.right)),
      y: Math.max(8, Math.min(window.innerHeight - 148, event.clientY || bounds.top)),
      opener: event.currentTarget,
    });
  };

  const renderProfile = (profile: AgentProfile, pinnedTile = false) => {
    const message = previewsByProfile.get(profile.id);
    const dateTime = message?.created_at || createdAtByProfile?.[profile.id];
    const date = dateTime ? new Date(dateTime) : null;

    const preview = message
      ? message.content.replace(/\s+/g, " ").trim()
      : dateTime && viberGreeting(profile.name);

    const timestamp = date?.toDateString() === today ? messageTime : messageDate;

    return (
      <button
        type="button"
        className={`sidebar-viber ${pinnedTile ? "sidebar-pinned-viber" : ""}`}
        key={profile.id}
        ref={(button) => {
          if (button && focusAfterPin.current === profile.id) {
            focusAfterPin.current = null;
            button.focus();
          }
        }}
        aria-current={selectedViber === profile.id ? "page" : undefined}
        onClick={() => selectViber(profile)}
        onContextMenu={(event) => openMenu(event, profile.id)}
        aria-label={collapsed || pinnedTile ? `Chat with ${profile.name}` : undefined}
        title={
          pinnedTile
            ? `${profile.name}${preview ? ` · ${preview}` : ""}`
            : `Chat with ${profile.name}`
        }
      >
        <ViberFace profile={profile} />
        {pinnedTile && !collapsed && <strong className="w-full truncate">{profile.name}</strong>}
        {!collapsed && !pinnedTile && (
          <span className="sidebar-viber-details">
            <strong>{profile.name}</strong>
            {date && Number.isFinite(date.getTime()) && (
              <time dateTime={dateTime} title={date.toLocaleString()}>
                {timestamp.format(date)}
              </time>
            )}
            {preview && <small>{preview}</small>}
          </span>
        )}
      </button>
    );
  };

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
            <>
              {pinned.length > 0 && (
                <div className="sidebar-pinned" aria-label="Pinned Vibers" role="group">
                  {pinned.map((profile) => renderProfile(profile, true))}
                </div>
              )}
              {unpinned.map((profile) => renderProfile(profile))}
            </>
          )}
        </div>
      </div>

      {menu && menuProfile && (
        <div
          className="fixed inset-0 z-30"
          onPointerDown={closeMenu}
          onContextMenu={(event) => {
            event.preventDefault();
            closeMenu();
          }}
        >
          <div
            className="sidebar-viber-menu"
            role="group"
            aria-label={`Actions for ${menuProfile.name}`}
            style={{ left: menu.x, top: menu.y }}
            onPointerDown={(event) => event.stopPropagation()}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
                setMenu(undefined);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                closeMenu();
              }
            }}
          >
            {(
              [
                ["pin", pinnedIds.includes(menuProfile.id) ? "Unpin" : "Pin", null],
                ["rename", "Rename", Pencil],
                ["edit", "Edit", SquarePen],
                ["delete", "Delete", Trash2],
              ] as const
            ).map(([action, label, Icon], index) => (
              <button
                type="button"
                key={action}
                autoFocus={index === 0}
                onClick={() => {
                  if (action === "pin") {
                    focusAfterPin.current = menuProfile.id;
                    setMenu(undefined);
                  } else {
                    closeMenu();
                  }

                  onViberAction?.(action, menuProfile);
                }}
              >
                {Icon && <Icon size={14} aria-hidden="true" />} {label}
              </button>
            ))}
          </div>
        </div>
      )}

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
        {connection && (
          <button
            type="button"
            className="sidebar-refresh"
            aria-label="Refresh connection"
            aria-description={connection.issue}
            title={connection.issue ? `${connection.issue}. Click to retry` : "Refresh connection"}
            disabled={connection.busy}
            aria-busy={connection.busy || undefined}
            onClick={() => void connection.retry()}
          >
            <RefreshCw
              aria-hidden="true"
              className={connection.busy ? "motion-safe:animate-spin" : undefined}
            />
            {connection.issue && <span className="sidebar-refresh-dot" aria-hidden="true" />}
          </button>
        )}
      </nav>
    </aside>
  );
};
