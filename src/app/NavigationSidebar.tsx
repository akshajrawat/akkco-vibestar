import { motion, useIsPresent, useReducedMotion } from "motion/react";
import {
  Activity,
  Bot,
  FolderGit2,
  GitPullRequest,
  ListTodo,
  Plus,
  Plug,
  Search,
  Settings,
} from "lucide-react";

import type { Page, Snapshot } from "../lib/types";
import { Button } from "../components/ui/button";
import { TaskNavigation } from "../features/tasks/TaskNavigation";

export const navigation = [
  ["Tasks", ListTodo],
  ["Vibers", Bot],
  ["Scheduled", GitPullRequest],
  ["Issue Watch", Search],
  ["Repositories", FolderGit2],
  ["Providers", Plug],
  ["Usage", Activity],
  ["Settings", Settings],
] as const;

interface NavigationSidebarProps {
  width: number;
  snapshot: Snapshot | null;
  page: Page;
  count: number;
  taskId: string | null;
  repairId: string | null;
  newTask: () => void;
  navigate: (page: Page) => void;
  open: (id: string) => void;
  openRepair: (id: string) => void;
  onError: (error: string) => void;
}

export const NavigationSidebar = ({
  width,
  snapshot,
  page,
  count,
  taskId,
  repairId,
  newTask,
  navigate,
  open,
  openRepair,
  onError,
}: NavigationSidebarProps) => {
  const present = useIsPresent();
  const reduced = useReducedMotion();

  return (
    <motion.aside
      className="sidebar"
      style={{ width }}
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -8 }}
      transition={{ duration: reduced ? 0 : 0.16 }}
      inert={!present}
      aria-hidden={!present}
    >
      <div className="brand">
        VIBESTAR <small>LOCAL</small>
      </div>

      <Button
        className="new-task-button"
        aria-label="New task"
        onClick={newTask}
        disabled={!snapshot}
      >
        <Plus size={14} />
        New task
        <span className="spacer" />
        <kbd>＋</kbd>
      </Button>

      <div className="sidebar-label">
        <button onClick={() => navigate("Tasks")}>Tasks</button>
        <small>{snapshot?.tasks.length || 0}</small>
      </div>

      <TaskNavigation
        flowStates={snapshot?.flow_states}
        repositories={snapshot?.repositories || []}
        tasks={snapshot?.tasks || []}
        selected={taskId}
        open={open}
        onError={onError}
      />

      {!!snapshot?.repairs?.length && (
        <div className="repair-navigation">
          <div className="sidebar-label">
            PULL REQUESTS <small>{snapshot.repairs.length}</small>
          </div>

          {snapshot.repositories.map((repository) => {
            const repairs =
              snapshot.repairs?.filter((repair) => repair.repo_id === repository.id) || [];

            return repairs.length ? (
              <div key={repository.id}>
                <small className="repair-repository-label">
                  {repository.owner}/{repository.name}
                </small>

                {repairs.map((repair) => (
                  <button
                    key={repair.id}
                    className={repairId === repair.id ? "selected" : ""}
                    onClick={() => openRepair(repair.id)}
                  >
                    <GitPullRequest size={13} />
                    <span>#{repair.identity.number} · Review repair</span>
                    <small>{repair.status.replaceAll("_", " ")}</small>
                  </button>
                ))}
              </div>
            ) : null;
          })}
        </div>
      )}

      <nav className="sidebar-tools">
        {navigation
          .filter(([label]) => label !== "Tasks")
          .map(([label, Icon]) => (
            <button
              className={page === label ? "selected" : ""}
              key={label}
              aria-label={label === "Scheduled" ? "Pull Requests" : label}
              aria-current={page === label ? "page" : undefined}
              onClick={() => navigate(label)}
            >
              <Icon size={14} />
              {label === "Scheduled" ? "Pull Requests" : label}
              {label === "Scheduled" && (
                <small className={count ? "warning" : ""}>
                  {count
                    ? `${count} need attention`
                    : snapshot?.scheduled?.filter((job) => job.enabled).length || ""}
                </small>
              )}
            </button>
          ))}
      </nav>

      <div className="sidebar-footer">
        <span className="local-dot" />
        {snapshot?.github?.status?.connected
          ? `@${snapshot.github.status.username}`
          : "Local workspace"}
        <small>{snapshot?.settings.concurrency || 2} agent slots</small>
      </div>
    </motion.aside>
  );
};
