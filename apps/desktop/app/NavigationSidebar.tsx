import { useState, type Ref } from "react";
import {
  Plus,
  Search,
  PanelLeftClose,
  Activity,
  FolderGit2,
  Plug,
  Settings,
  Monitor,
} from "lucide-react";
import type { AgentProfile, ViberMessagePreview } from "../../core/vibers/contracts";
import { ViberFace } from "../features/vibers/ViberFace";
import type { Snapshot, WorkspaceTool } from "../lib/types";

interface NavigationSidebarProps {
  width: number;
  snapshot: Snapshot | null;
  profiles: AgentProfile[];
  previews: ViberMessagePreview[];
  profilesError: string;
  createViber: () => void;
  selectViber: (profile: AgentProfile) => void;
  selectedViber?: string;
  openTool: (tool: WorkspaceTool) => void;
  computerOpen: boolean;
  toggleComputer: () => void;
  toggleSidebar: () => void;
  toggleRef?: Ref<HTMLButtonElement>;
}

const dockItems = [
  { tool: "Repositories", Icon: FolderGit2 },
  { tool: "Providers", Icon: Plug },
  { tool: "Usage", Icon: Activity },
  { tool: "Settings", Icon: Settings },
] as const;

const messageTime = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const messageDate = new Intl.DateTimeFormat(undefined, { dateStyle: "short" });

export const NavigationSidebar = ({
  width,
  snapshot,
  profiles,
  previews,
  profilesError,
  createViber,
  selectViber,
  selectedViber,
  openTool,
  computerOpen,
  toggleComputer,
  toggleSidebar,
  toggleRef,
}: NavigationSidebarProps) => {
  const [search, setSearch] = useState("");

  const previewsByProfile = new Map(previews.map((preview) => [preview.profile_id, preview]));
  const today = new Date().toDateString();

  const filtered = profiles.filter((profile) =>
    `${profile.name} ${profile.description || ""}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );

  return (
    <aside
      className="sidebar flex flex-none flex-col min-w-0 min-h-0 text-foreground"
      style={{ width }}
      aria-label="Workspace navigation"
    >
      <div className="sidebar-brand-header flex items-center justify-between flex-[0_0_42px] pt-2 pb-1">
        <div className="sidebar-brand flex items-center min-w-0 select-none flex-1">
          <span className="sidebar-brand-title">
            <span className="sidebar-brand-v">V</span>ibestar
          </span>
        </div>
        <button
          ref={toggleRef}
          className="sidebar-collapse grid place-items-center shrink-0 p-0 [border:0] [transition:color_var(--motion-fast),_background-color_var(--motion-fast)]"
          aria-label="Collapse sidebar"
          aria-expanded="true"
          title="Collapse sidebar (Ctrl+B)"
          onClick={toggleSidebar}
        >
          <PanelLeftClose size={18} aria-hidden="true" />
        </button>
      </div>

      <div className="sidebar-content">
        <div className="sidebar-header">
          <div className="sidebar-search">
            <label>
              <Search size={16} aria-hidden="true" />
              <input
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
              className="sidebar-new-viber"
              aria-label="Create Viber"
              title="Create Viber"
              onClick={createViber}
              disabled={!snapshot}
            >
              <Plus size={18} aria-hidden="true" />
            </button>
          </div>
        </div>

        <button
          type="button"
          className="mx-3 mb-1 flex items-center gap-2 rounded-lg border-0 bg-transparent px-3 py-2 text-left text-sm text-ink-secondary hover:bg-surface-hover aria-expanded:bg-surface-active aria-expanded:text-foreground"
          aria-expanded={computerOpen}
          onClick={toggleComputer}
        >
          <Monitor size={16} aria-hidden="true" />
          Computer
        </button>

        <div className="sidebar-vibers" role="region" aria-label="Viber list">
          {profilesError && (
            <p role="alert" className="error">
              {profilesError}
            </p>
          )}
          {filtered.length === 0 ? (
            <div className="sidebar-empty px-3 py-6 text-ink-muted text-[12px] text-center">
              <p>{search ? "No matching vibers" : "No vibers created yet"}</p>
            </div>
          ) : (
            filtered.map((profile) => {
              const message = previewsByProfile.get(profile.id);
              const date = message ? new Date(message.created_at) : null;
              const preview = message?.content.replace(/\s+/g, " ").trim();
              const timestamp = date?.toDateString() === today ? messageTime : messageDate;

              return (
                <button
                  className="sidebar-viber"
                  key={profile.id}
                  aria-current={selectedViber === profile.id ? "page" : undefined}
                  onClick={() => selectViber(profile)}
                  title={`Chat with ${profile.name}`}
                >
                  <ViberFace profile={profile} compact />
                  <span className="sidebar-viber-details">
                    <strong>{profile.name}</strong>
                    {message && date && Number.isFinite(date.getTime()) && (
                      <time dateTime={message.created_at} title={date.toLocaleString()}>
                        {timestamp.format(date)}
                      </time>
                    )}
                    {preview && <small>{preview}</small>}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>

      <nav className="sidebar-dock" aria-label="Workspace tools">
        {dockItems.map(({ tool, Icon }) => (
          <div key={tool} className="sidebar-dock-item">
            <button
              type="button"
              aria-label={tool}
              aria-haspopup="dialog"
              onClick={() => openTool(tool)}
            >
              <Icon aria-hidden="true" />
            </button>
            <span className="sidebar-dock-label" aria-hidden="true">
              {tool}
            </span>
          </div>
        ))}
      </nav>
    </aside>
  );
};
