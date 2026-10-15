import { useEffect, useState } from "react";
import type { Task, Diff, FileDiff } from "../lib/types";
import { rpc, errorMessage } from "../lib/api";
import { useTaskView, updateTaskView } from "../lib/taskView";
import { DiffFileTree } from "./DiffFileTree";

export const ChangesView = ({
  task,
  diff,
  revision,
  onError,
  owner = "task",
  layer,
  reviews = [],
  reviewed,
}: {
  task: Pick<Task, "id" | "base_commit_sha">;
  diff: Diff | null;
  revision: number;
  onError: (error: string) => void;
  owner?: "task" | "repair";
  layer?: "original" | "upstream" | "repair";
  reviews?: { path: string; hash: string; reviewed: boolean }[];
  reviewed?: (
    path: string,
    oldPath: string | null,
    hash: string,
    checked: boolean,
  ) => void;
}) => {
  const view = useTaskView(task.id);
  const file =
    diff?.files.find((f) => f.path === view.diffPath) || diff?.files[0];
  const path = file?.path;
  const oldPath = file?.old_path;
  const review = reviews.find((row) => row.path === path);
  const [content, setContent] = useState<FileDiff | null>(null);
  useEffect(() => {
    let alive = true;
    setContent(null);
    if (path)
      void rpc<FileDiff>(`${owner}.file`, {
        id: task.id,
        path,
        old_path: oldPath,
        ...(layer ? { layer } : {}),
      })
        .then((value) => {
          if (alive) setContent(value);
        })
        .catch((error) => {
          if (alive) onError(errorMessage(error));
        });
    return () => {
      alive = false;
    };
  }, [task.id, path, oldPath, revision, onError, owner, layer]);
  return (
    <section className="changes-panel" aria-label="Task changes">
      <DiffFileTree
        files={diff?.files || []}
        selected={file?.path}
        onSelect={(file) => updateTaskView(task.id, { diffPath: file.path })}
      />
      <div className="change-content">
        <div className="cwd-banner">
          <code>{file?.path || "No changed files"}</code>
          <span>base {task.base_commit_sha.slice(0, 8)} → working tree</span>
          {review && file && reviewed && (
            <label>
              <input
                type="checkbox"
                aria-label="Mark repair file reviewed"
                checked={review.reviewed}
                onChange={(e) =>
                  reviewed(
                    file.path,
                    file.old_path,
                    review.hash,
                    e.target.checked,
                  )
                }
              />
              Reviewed
            </label>
          )}
        </div>
        {content?.binary ? (
          <p className="empty-row">
            Binary or oversized file. Open it in your editor.
          </p>
        ) : (
          <pre className="change-patch">
            {(content?.unified || (file ? "Loading diff…" : "No changes yet."))
              .split("\n")
              .map((line, i) => (
                <span
                  key={i}
                  className={
                    line.startsWith("+")
                      ? "success"
                      : line.startsWith("-")
                        ? "failure"
                        : undefined
                  }
                >
                  {line}
                  {"\n"}
                </span>
              ))}
          </pre>
        )}
      </div>
    </section>
  );
};
