import { Activity, useState, type Ref } from "react";
import { Plus, Search, PanelLeftClose, Bot, ListTodo } from "lucide-react";
import type { AgentProfile } from "../../core/flows/contracts";
import { ViberFace } from "../features/flows/ViberFace";
import vibestarLogo from "../../../assets/icon.svg";
import type { Page, Snapshot } from "../lib/types";
import { TaskNavigation } from "../features/tasks/TaskNavigation";

const dock = [
  [
    "Scheduled",
    "Pull Requests",
    "M6 2a4 4 0 0 0-1.5 7.7v4.6a4 4 0 1 0 3 0V9.7A4 4 0 0 0 6 2Zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm0 12a2 2 0 1 1 0 4 2 2 0 0 1 0-4ZM15 2l-5 4 5 4V7.5h1A1.5 1.5 0 0 1 17.5 9v5.3a4 4 0 1 0 3 0V9A4.5 4.5 0 0 0 16 4.5h-1V2Zm4 14a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z",
  ],
  [
    "Issue Watch",
    "Issues",
    "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1.5 4h3v8h-3V6Zm0 10h3v3h-3v-3Z",
  ],
  ["Usage", "Usage", "M3 14h4v8H3v-8Zm7-6h4v14h-4V8Zm7-6h4v20h-4V2Z"],
  [
    "Settings",
    "Settings",
    "M9 1h6l.6 3 2 .9 2.8-.9 3 5.2-2.3 2v1.6l2.3 2-3 5.2-2.8-.9-2 .9-.6 3H9l-.6-3-2-.9-2.8.9-3-5.2 2.3-2v-1.6l-2.3-2 3-5.2 2.8.9 2-.9L9 1Zm3 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
  ],
] as const;

interface NavigationSidebarProps {
  width: number;
  revision: number;
  snapshot: Snapshot | null;
  page: Page;
  count: number;
  taskId: string | null;
  newTask: () => void;
  profiles: AgentProfile[];
  profilesError: string;
  createViber: () => void;
  selectViber: (profile: AgentProfile) => void;
  selectedViber?: string;
  navigate: (page: Page) => void;
  open: (id: string) => void;
  onError: (error: string) => void;
  toggleSidebar: () => void;
  toggleRef?: Ref<HTMLButtonElement>;
}

export const NavigationSidebar = ({
  width,
  revision,
  snapshot,
  page,
  count,
  taskId,
  newTask,
  profiles,
  profilesError,
  createViber,
  selectViber,
  selectedViber,
  navigate,
  open,
  onError,
  toggleSidebar,
  toggleRef,
}: NavigationSidebarProps) => {
  const [selectedMode, setSelectedMode] = useState<"Tasks" | "Vibers">("Tasks");
  const mode = page === "Vibers" || page === "Tasks" ? page : selectedMode;
  const [queries, setQueries] = useState({ Tasks: "", Vibers: "" });
  const search = queries[mode];
  const setSearch = (value: string) => setQueries({ ...queries, [mode]: value });

  const header = (tasksToggle?: React.ReactNode) => (
    <div className="sidebar-header">
      <label className="sidebar-search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          aria-label={`Search ${mode.toLowerCase()}`}
          placeholder={`Search ${mode.toLowerCase()}…`}
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
        className="sidebar-new-task"
        aria-label={mode === "Tasks" ? "New task" : "Create Viber"}
        title={mode === "Tasks" ? "New task" : "Create Viber"}
        onClick={mode === "Tasks" ? newTask : createViber}
        disabled={!snapshot}
      >
        <Plus size={19} aria-hidden="true" />
      </button>
      {tasksToggle}
    </div>
  );

  return (
    <aside className="sidebar" style={{ width }} aria-label="Workspace navigation">
      <div className="sidebar-brand-header">
        <div className="sidebar-brand">
          <img src={vibestarLogo} width="24" height="24" alt="" />
          <span>Vibestar</span>
        </div>
        <div className="sidebar-modes" role="group" aria-label="Sidebar mode">
          {(
            [
              ["Vibers", Bot],
              ["Tasks", ListTodo],
            ] as const
          ).map(([value, Icon]) => (
            <button
              key={value}
              className="sidebar-mode"
              aria-label={`Show ${value}`}
              title={value}
              aria-pressed={mode === value}
              onClick={() => {
                setSelectedMode(value);
                navigate(value);
              }}
            >
              <Icon size={16} aria-hidden="true" />
            </button>
          ))}
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
      <Activity mode={mode === "Tasks" ? "visible" : "hidden"}>
        <TaskNavigation
          renderHeader={(tasksToggle) => header(tasksToggle)}
          query={search}
          revision={revision}
          flowStates={snapshot?.flow_states}
          repositories={snapshot?.repositories || []}
          tasks={snapshot?.tasks || []}
          selected={taskId}
          open={open}
          onError={onError}
        />
      </Activity>
      {mode === "Vibers" && (
        <>
          {header()}
          <div className="sidebar-vibers" aria-label="Viber profiles">
            {profilesError && (
              <p role="alert" className="error">
                {profilesError}
              </p>
            )}
            {profiles
              .filter((profile) =>
                `${profile.name} ${profile.description || ""}`
                  .toLowerCase()
                  .includes(search.trim().toLowerCase()),
              )
              .map((profile) => (
                <button
                  className="sidebar-viber"
                  key={profile.id}
                  onClick={() => selectViber(profile)}
                  title={`Chat with ${profile.name}`}
                  aria-current={
                    page === "Vibers" && selectedViber === profile.id ? "page" : undefined
                  }
                >
                  <ViberFace profile={profile} />
                  <span>
                    <strong>{profile.name}</strong>
                    <small>{profile.description || profile.execution.provider}</small>
                  </span>
                </button>
              ))}
            {!profiles.some((profile) =>
              `${profile.name} ${profile.description || ""}`
                .toLowerCase()
                .includes(search.trim().toLowerCase()),
            ) && (
              <p className="empty-row">
                {search ? "No matching Vibers." : "Create your first Viber."}
              </p>
            )}
          </div>
        </>
      )}

      <nav className="sidebar-tools" aria-label="Workspace tools">
        {dock.map(([destination, label, path]) => (
          <button
            className={
              page === destination ||
              (destination === "Settings" && ["Repositories", "Providers"].includes(page))
                ? "selected"
                : ""
            }
            key={destination}
            aria-label={label}
            title={label}
            aria-current={
              page === destination ||
              (destination === "Settings" && ["Repositories", "Providers"].includes(page))
                ? "page"
                : undefined
            }
            onClick={() => navigate(destination)}
          >
            <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d={path} fillRule="evenodd" clipRule="evenodd" />
            </svg>
            {destination === "Scheduled" && count > 0 && (
              <span className="sidebar-attention">
                <span className="sr-only">{count} need attention</span>
              </span>
            )}
          </button>
        ))}
      </nav>
    </aside>
  );
};
