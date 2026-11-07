import { useState, type Ref } from "react";
import { Plus, Search, PanelLeftClose } from "lucide-react";
import vibestarLogo from "../../assets/icon.svg";
import type { Page, Snapshot } from "../lib/types";
import { TaskNavigation } from "../features/tasks/TaskNavigation";

// Compact filled glyphs keep the five destinations readable at the minimum pane width.
const dock = [
  [
    "Vibers",
    "Vibers",
    "M11 2h2v3h4a3 3 0 0 1 3 3v2h2v7h-2v1a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-1H2v-7h2V8a3 3 0 0 1 3-3h4V2ZM8 9a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm8 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM8 16v2h8v-2H8Z",
  ],
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
  navigate,
  open,
  onError,
  toggleSidebar,
  toggleRef,
}: NavigationSidebarProps) => {
  const [search, setSearch] = useState("");

  return (
    <aside className="sidebar" style={{ width }} aria-label="Workspace navigation">
      <div className="sidebar-brand-header">
        <div className="sidebar-brand">
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
      <TaskNavigation
        renderHeader={(tasksToggle) => (
          <div className="sidebar-header">
            <label className="sidebar-search">
              <Search size={14} aria-hidden="true" />
              <input
                type="search"
                aria-label="Search tasks"
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
              className="sidebar-new-task"
              aria-label="New task"
              title="New task"
              onClick={newTask}
              disabled={!snapshot}
            >
              <Plus size={19} strokeWidth={3} aria-hidden="true" />
            </button>
            {tasksToggle}
          </div>
        )}
        query={search}
        revision={revision}
        flowStates={snapshot?.flow_states}
        repositories={snapshot?.repositories || []}
        tasks={snapshot?.tasks || []}
        selected={taskId}
        open={open}
        onError={onError}
      />

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
