import { useEffect, useState } from "react";
import type { CloneActivity as Activity } from "../../../backend/github/service";
import { rpc, errorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";

export const CloneActivity = ({
  activity,
  createTask,
}: {
  activity: Activity;
  createTask?: () => void;
}) => {
  const [logs, setLogs] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  const active = ["resolving", "cloning"].includes(activity.status);
  useEffect(() => {
    if (!expanded) return;
    let alive = true;
    const load = () =>
      rpc<{ text: string }>("github.clone.logs", { id: activity.id })
        .then((r) => {
          if (alive) setLogs(r.text);
          if (alive) setError("");
        })
        .catch((e) => {
          if (alive) setError(errorMessage(e));
        });
    void load();
    const timer = active ? setInterval(() => void load(), 1000) : undefined;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [activity.id, active, expanded]);
  return (
    <article className="clone-activity" aria-label={`Clone ${activity.repository}`}>
      <div className="section-heading">
        <strong>{activity.repository}</strong>
        <span
          className={`status-chip ${activity.status === "completed" ? "success" : activity.status === "failed" ? "failure" : active ? "running" : "warning"}`}
        >
          {activity.status}
          {activity.percent != null ? ` · ${activity.percent}%` : ""}
        </span>
      </div>
      <p>{activity.phase}</p>
      {active && <progress max={100} value={activity.percent} aria-label="Clone progress" />}
      {activity.destination && (
        <code className="repository-path">Destination: {activity.destination}</code>
      )}
      {activity.upstream && (
        <small className="subtle">
          Upstream: {activity.upstream} · Origin: {activity.origin || "Not configured"}
        </small>
      )}
      <div className="actions">
        {active && (
          <Button
            size="sm"
            onClick={() =>
              void rpc("github.clone.cancel", { id: activity.id }).catch((e) =>
                setError(errorMessage(e)),
              )
            }
          >
            Cancel clone
          </Button>
        )}
        {activity.status === "completed" && activity.repository_id && (
          <>
            <Button
              size="sm"
              onClick={() =>
                void rpc("open.directory", {
                  id: activity.repository_id,
                  kind: "repository",
                }).catch((e) => setError(errorMessage(e)))
              }
            >
              Open repository
            </Button>
            {createTask && (
              <Button size="sm" onClick={createTask}>
                Create task
              </Button>
            )}
          </>
        )}
      </div>
      {(activity.error || error) && (
        <p className="warning" role="alert">
          {errorMessage(activity.error || error)}
        </p>
      )}
      <details onToggle={(e) => setExpanded(e.currentTarget.open)}>
        <summary>Raw clone logs</summary>
        <pre className="raw-log">{logs || "Waiting for clone output…"}</pre>
      </details>
    </article>
  );
};
