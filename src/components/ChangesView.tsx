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
}: {
  task: Task;
  diff: Diff | null;
  revision: number;
  onError: (error: string) => void;
}) => {
  const view = useTaskView(task.id);
  const file =
    diff?.files.find((f) => f.path === view.diffPath) || diff?.files[0];
  const path = file?.path;
  const oldPath = file?.old_path;
  const [content, setContent] = useState<FileDiff | null>(null);
  useEffect(() => {
    let alive = true;
    setContent(null);
    if (path)
      void rpc<FileDiff>("task.file", {
        id: task.id,
        path,
        old_path: oldPath,
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
  }, [task.id, path, oldPath, revision, onError]);
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
