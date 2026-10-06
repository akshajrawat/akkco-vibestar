import { useState } from "react";
import { FolderGit2, ChevronRight, ChevronDown } from "lucide-react";
import type { Repository, Task } from "../lib/types";
export const TaskNavigation = ({
  repositories,
  tasks,
  selected,
  open,
}: {
  repositories: Repository[];
  tasks: Task[];
  selected: string | null;
  open: (id: string) => void;
}) => {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setCollapsed((current) => {
      const value = new Set(current);
      if (value.has(id)) value.delete(id);
      else value.add(id);
      return value;
    });
  return (
    <div className="sidebar-tasks">
      {repositories.map((repo) => {
        const local = tasks.filter((task) => task.repo_id === repo.id);
        const issues = [...new Set(local.map((task) => task.issue_number))];
        return (
          <section key={repo.id}>
            <button
              className="tree-group-toggle"
              aria-expanded={!collapsed.has(repo.id)}
              onClick={() => toggle(repo.id)}
            >
              {collapsed.has(repo.id) ? (
                <ChevronRight size={11} />
              ) : (
                <ChevronDown size={11} />
              )}
              <FolderGit2 size={13} />
              <span>
                {repo.owner}/{repo.name}
              </span>
              <small>{local.length}</small>
            </button>
            {!collapsed.has(repo.id) &&
              issues.map((issue) => {
                const key = `${repo.id}/${issue}`;
                return (
                  <div className="tree-issue" key={key}>
                    <button
                      className="tree-issue-toggle"
                      aria-expanded={!collapsed.has(key)}
                      onClick={() => toggle(key)}
                    >
                      {collapsed.has(key) ? (
                        <ChevronRight size={10} />
                      ) : (
                        <ChevronDown size={10} />
                      )}
                      <span>#{issue}</span>
                    </button>
                    {!collapsed.has(key) &&
                      local
                        .filter((task) => task.issue_number === issue)
                        .map((task) => (
                          <button
                            className={`tree-task ${selected === task.id ? "selected" : ""}`}
                            key={task.id}
                            onClick={() => open(task.id)}
                            title={`${task.claimed_scope}\n${task.branch_name}`}
                          >
                            <i className={`task-dot ${task.status}`} />
                            <span>{task.claimed_scope}</span>
                          </button>
                        ))}
                  </div>
                );
              })}
          </section>
        );
      })}
    </div>
  );
};
