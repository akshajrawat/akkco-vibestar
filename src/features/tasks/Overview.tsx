import { Plus, ArrowUpRight, ListTodo } from "lucide-react";
import type { Snapshot } from "../../lib/types";
import { activeStatuses } from "../../lib/types";
import { Status } from "../../components/shared/Status";
import { Button } from "../../components/ui/button";
import { PageHeader, EmptyState } from "../../components/ui/PageHeader";
import { ScheduledAttention } from "../pull-requests/ScheduledPage";
import { useState } from "react";

export const Overview = ({
  snapshot,
  refresh,
  open,
  newTask,
}: {
  snapshot: Snapshot;
  refresh: () => Promise<void>;
  open: (id: string) => void;
  newTask: () => void;
}) => {
  const [archived, setArchived] = useState(false);
  const tasks = snapshot.tasks.filter((t) => archived || !t.archived);

  const groups = [
    {
      name: "Running agents",
      tasks: tasks.filter((t) => activeStatuses.includes(t.status) || t.status === "queued"),
    },
    {
      name: "Recent tasks",
      tasks: tasks
        .filter((t) => !activeStatuses.includes(t.status) && t.status !== "queued")
        .slice(0, 30),
    },
  ];

  return (
    <div className="page task-library">
      <PageHeader
        title="Tasks"
        description="Plan, build and review contributions in isolated worktrees."
        actions={
          <>
            <Button variant="ghost" onClick={() => setArchived(!archived)}>
              {archived ? "Hide archived" : "Show archived"}
            </Button>

            <Button variant="default" onClick={newTask}>
              <Plus size={13} />
              New task
            </Button>
          </>
        }
      />

      {!!snapshot.attention?.length && (
        <ScheduledAttention snapshot={snapshot} refresh={refresh} open={open} />
      )}

      {!snapshot.tasks.length && (
        <EmptyState
          icon={<ListTodo size={26} />}
          title="Start from a GitHub issue"
          description="Bring an issue and your instructions. Vibestar prepares an isolated worktree and guides each plan, implementation and review through your approval."
          action={
            <Button variant="default" onClick={newTask}>
              New task
              <ArrowUpRight size={13} />
            </Button>
          }
        />
      )}

      {groups
        .filter((g) => g.tasks.length)
        .map((group) => (
          <section className="task-group" key={group.name}>
            <h2>
              {group.name}
              <small>{group.tasks.length}</small>
            </h2>

            <div className="task-list">
              {group.tasks.map((task) => {
                const repo = snapshot.repositories.find((r) => r.id === task.repo_id);
                return (
                  <button className="task-card" key={task.id} onClick={() => open(task.id)}>
                    <i className={`task-dot ${task.status}`} />
                    <div>
                      <strong>{task.claimed_scope || task.issue?.title || "Entire issue"}</strong>
                      <span className="subtle">
                        {repo?.owner}/{repo?.name} #{task.issue_number}
                      </span>
                    </div>
                    <Status status={task.status} />
                    <ArrowUpRight size={13} />
                  </button>
                );
              })}
            </div>
          </section>
        ))}
    </div>
  );
};
