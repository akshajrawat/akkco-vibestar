import { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
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
  const [collapsed, setCollapsed] = useState(new Set<string>());
  return (
    <div className="sidebar-tasks">
      {repositories
        .filter((r) => tasks.some((t) => t.repo_id === r.id))
        .map((repo) => (
          <section key={repo.id}>
            <button
              className="tree-group-toggle"
              aria-expanded={!collapsed.has(repo.id)}
              onClick={() =>
                setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(repo.id)) next.delete(repo.id);
                  else next.add(repo.id);
                  return next;
                })
              }
            >
              {collapsed.has(repo.id) ? (
                <ChevronRight size={12} />
              ) : (
                <ChevronDown size={12} />
              )}
              <span>
                {repo.owner}/{repo.name}
              </span>
            </button>
            {!collapsed.has(repo.id) &&
              tasks
                .filter((t) => !t.archived)
                .filter((t) => t.repo_id === repo.id)
                .map((task) => (
                  <button
                    className={`tree-task ${task.id === selected ? "selected" : ""}`}
                    key={task.id}
                    onClick={() => open(task.id)}
                    title={`${task.issue.title || task.claimed_scope}\n${task.branch_name}`}
                  >
                    <i className={`task-dot ${task.status}`} />
                    <span>
                      <small>#{task.issue_number}</small>{" "}
                      {task.claimed_scope || task.issue.title || "Entire issue"}
                    </span>
                  </button>
                ))}
          </section>
        ))}
      {!tasks.length && (
        <p className="sidebar-empty">Your tasks appear here.</p>
      )}
    </div>
  );
};
