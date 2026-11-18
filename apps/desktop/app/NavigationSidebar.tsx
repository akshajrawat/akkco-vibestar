import { useState, type Ref } from "react";
import { Plus, Search, PanelLeftClose, Activity, FolderGit2, Plug, Settings } from "lucide-react";
import type { AgentProfile } from "../../core/vibers/contracts";
import { ViberFace } from "../features/flows/ViberFace";
import vibestarLogo from "../../../assets/icon.svg";
import type { Page, Snapshot } from "../lib/types";

interface NavigationSidebarProps {
  width: number;
  revision: number;
  snapshot: Snapshot | null;
  profiles: AgentProfile[];
  profilesError: string;
  createViber: () => void;
  selectViber: (profile: AgentProfile) => void;
  selectedViber?: string;
  page?: Page;
  navigate: (page: Page) => void;
  toggleSidebar: () => void;
  toggleRef?: Ref<HTMLButtonElement>;
}

export const NavigationSidebar = ({
  width,
  snapshot,
  profiles,
  profilesError,
  createViber,
  selectViber,
  selectedViber,
  page,
  navigate,
  toggleSidebar,
  toggleRef,
}: NavigationSidebarProps) => {
  const [search, setSearch] = useState("");

  const filtered = profiles.filter((profile) =>
    `${profile.name} ${profile.description || ""}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );

  return (
    <aside className="sidebar" style={{ width }} aria-label="Workspace navigation">
      <div className="sidebar-brand-header">
        <div className="sidebar-brand" onClick={() => navigate("Vibers")}>
          <img src={vibestarLogo} width="24" height="24" alt="" />
          <span>Vibestar</span>
        </div>
        <button
          ref={toggleRef}
          className="sidebar-collapse"
          aria-label="Collapse sidebar"
          aria-expanded="true"
          title="Collapse sidebar (Ctrl+B)"
          onClick={toggleSidebar}
        >
          <PanelLeftClose size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="sidebar-header">
        <label className="sidebar-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            aria-label="Search vibers"
            placeholder="Search vibers…"
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
          <Plus size={19} aria-hidden="true" />
        </button>
      </div>

      <div className="sidebar-vibers" aria-label="Viber list">
        {profilesError && (
          <p role="alert" className="error">
            {profilesError}
          </p>
        )}
        {filtered.length === 0 ? (
          <div className="sidebar-empty">
            <p>{search ? "No matching vibers" : "No vibers created yet"}</p>
          </div>
        ) : (
          filtered.map((profile) => (
            <button
              className="sidebar-viber"
              key={profile.id}
              aria-current={selectedViber === profile.id ? "page" : undefined}
              onClick={() => {
                selectViber(profile);
                navigate("Vibers");
              }}
              title={`Chat with ${profile.name}`}
            >
              <ViberFace profile={profile} />
              <span>
                <strong>{profile.name}</strong>
                <small>{profile.description || profile.execution.provider}</small>
              </span>
            </button>
          ))
        )}
      </div>

      <nav className="sidebar-tools sidebar-dock" aria-label="Secondary navigation">
        <button
          className={`sidebar-dock-button ${page === "Repositories" ? "selected" : ""}`}
          aria-label="Repositories"
          title="Repositories"
          aria-current={page === "Repositories" ? "page" : undefined}
          onClick={() => navigate("Repositories")}
        >
          <FolderGit2 size={16} aria-hidden="true" />
        </button>
        <button
          className={`sidebar-dock-button ${page === "Providers" ? "selected" : ""}`}
          aria-label="Providers"
          title="Providers"
          aria-current={page === "Providers" ? "page" : undefined}
          onClick={() => navigate("Providers")}
        >
          <Plug size={16} aria-hidden="true" />
        </button>
        <button
          className={`sidebar-dock-button ${page === "Usage" ? "selected" : ""}`}
          aria-label="Usage"
          title="Usage"
          aria-current={page === "Usage" ? "page" : undefined}
          onClick={() => navigate("Usage")}
        >
          <Activity size={16} aria-hidden="true" />
        </button>
        <button
          className={`sidebar-dock-button ${page === "Settings" ? "selected" : ""}`}
          aria-label="Settings"
          title="Settings"
          aria-current={page === "Settings" ? "page" : undefined}
          onClick={() => navigate("Settings")}
        >
          <Settings size={16} aria-hidden="true" />
        </button>
      </nav>
    </aside>
  );
};
