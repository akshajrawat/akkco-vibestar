import { useEffect, useState } from "react";
import type { Task, Diff, FileDiff, DiffFile } from "../lib/types";
import { rpc, errorMessage } from "../lib/api";
import { useTaskView, updateTaskView } from "../lib/taskView";
import { DiffFileTree } from "./diff/DiffFileTree";
import { DiffView } from "./diff/DiffView";
import { Button } from "./ui/button";

export const ChangesView = ({
  task,
  diff,
  revision,
  onError,
  owner = "task",
  layer,
  reviews = [],
  reviewed,
  compact = false,
  baseline,
}: {
  task: Pick<Task, "id" | "base_commit_sha">;
  diff: Diff | null;
  revision: number;
  onError: (error: string) => void;
  owner?: "task" | "repair";
  layer?: "original" | "upstream" | "repair";
  reviews?: { path: string; hash: string; reviewed: boolean; notes?: number }[];
  reviewed?: (
    path: string,
    oldPath: string | null,
    hash: string,
    checked: boolean,
  ) => void;
  compact?: boolean;
  baseline?: string;
}) => {
  const view = useTaskView(task.id);
  const file =
    diff?.files.find((f) => f.path === view.diffPath) || diff?.files[0];
  const path = file?.path;
  const oldPath = file?.old_path;
  const [issueReviews, setIssueReviews] = useState<typeof reviews>([]);
  const [reviewError, setReviewError] = useState("");
  const [marking, setMarking] = useState(false);
  const reviewRows = owner === "task" ? issueReviews : reviews;
  const review = reviewRows.find((row) => row.path === path);
  const fileKey = `${owner}:${task.id}:${layer}:${path}:${oldPath}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    value: FileDiff;
    revision: number;
  }>();
  const content = loaded?.key === fileKey ? loaded.value : null;
  const [error, setError] = useState("");
  const selectFile = (file: DiffFile, expand = false) =>
    updateTaskView(task.id, {
      diffPath: file.path,
      ...(expand ? { expandedTool: true } : {}),
      ...(owner === "repair" && layer
        ? { diffLayerPaths: { ...view.diffLayerPaths, [layer]: file.path } }
        : {}),
    });
  useEffect(() => {
    let alive = true;
    if (owner === "task")
      void rpc<typeof reviews>("review.files", { id: task.id })
        .then((rows) => {
          if (alive) {
            setIssueReviews(rows || []);
            setReviewError("");
          }
        })
        .catch((reason) => {
          if (alive) {
            setIssueReviews([]);
            setReviewError(errorMessage(reason));
          }
        });
    return () => {
      alive = false;
    };
  }, [owner, task.id, revision]);
  const markReviewed = async (checked: boolean) => {
    if (!file || !review || marking) return;
    if (owner === "repair") {
      reviewed?.(file.path, file.old_path, review.hash, checked);
      return;
    }
    setMarking(true);
    try {
      await rpc("review.reviewed", {
        id: task.id,
        path: file.path,
        old_path: file.old_path,
        expected_hash: review.hash,
        reviewed: checked,
      });
      setIssueReviews((rows) =>
        rows.map((row) =>
          row.path === file.path ? { ...row, reviewed: checked } : row,
        ),
      );
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setMarking(false);
    }
  };
  useEffect(() => {
    let alive = true;
    setError("");
    if (path && !compact)
      void rpc<FileDiff>(`${owner}.file`, {
        id: task.id,
        path,
        old_path: oldPath,
        ...(layer ? { layer } : {}),
      })
        .then((value) => {
          if (alive) setLoaded({ key: fileKey, value, revision });
        })
        .catch((error) => {
          if (alive) setError(errorMessage(error));
        });
    return () => {
      alive = false;
    };
  }, [task.id, path, oldPath, revision, owner, layer, compact, fileKey]);
  if (compact)
    return (
      <section className="changes-summary" aria-label="Changed files">
        {baseline && <small className="diff-baseline">{baseline}</small>}
        <p>
          {diff?.files.length ?? 0} files ·{" "}
          <span className="success">+{diff?.insertions ?? 0}</span> /{" "}
          <span className="failure">−{diff?.deletions ?? 0}</span>
        </p>
        <Button
          size="sm"
          onClick={() => updateTaskView(task.id, { expandedTool: true })}
        >
          Open full diff review
        </Button>
        <DiffFileTree
          files={diff?.files || []}
          selected={file?.path}
          mode={view.diffTree}
          onMode={(diffTree) => updateTaskView(task.id, { diffTree })}
          reviews={reviewRows.map((row) => ({ ...row, notes: row.notes || 0 }))}
          onSelect={(file) => selectFile(file, true)}
        />
      </section>
    );
  return (
    <section className="changes-panel" aria-label="Task changes">
      <DiffFileTree
        files={diff?.files || []}
        selected={file?.path}
        mode={view.diffTree}
        onMode={(diffTree) => updateTaskView(task.id, { diffTree })}
        reviews={reviewRows.map((row) => ({ ...row, notes: row.notes || 0 }))}
        onSelect={(file) => selectFile(file)}
      />
      <div className="change-content">
        <div className="cwd-banner">
          <code>{file?.path || "No changed files"}</code>
          <span>
            {baseline ||
              `base ${task.base_commit_sha.slice(0, 8)} → working tree`}
          </span>
          {file?.old_path && <span>renamed from {file.old_path}</span>}
          {file && (
            <span>
              <span className="success">+{file.insertions}</span> /{" "}
              <span className="failure">−{file.deletions}</span>
            </span>
          )}
          {review && file && (owner === "task" || reviewed) && (
            <label>
              <input
                type="checkbox"
                aria-label={`Mark ${owner} file reviewed`}
                checked={review.reviewed}
                disabled={
                  marking ||
                  file.binary ||
                  !content ||
                  loaded?.revision !== revision ||
                  !!error
                }
                onChange={(e) => void markReviewed(e.target.checked)}
              />
              Reviewed
            </label>
          )}
        </div>
        <div className="diff-toolbar" aria-label="Diff presentation">
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={view.diffMode === "unified"}
            onClick={() => updateTaskView(task.id, { diffMode: "unified" })}
          >
            Unified diff
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={view.diffMode === "side"}
            onClick={() => updateTaskView(task.id, { diffMode: "side" })}
          >
            Side-by-side diff
          </Button>
          {reviewError && (
            <small className="warning">
              Review marks unavailable: {reviewError}
            </small>
          )}
        </div>
        {error ? (
          <p className="empty-row warning">
            {error} Open the file in your editor for full review.
          </p>
        ) : content && path ? (
          <DiffView
            key={fileKey}
            file={content}
            path={path}
            mode={view.diffMode}
          />
        ) : (
          <p className="empty-row">
            {file ? "Loading diff…" : "No changes yet."}
          </p>
        )}
      </div>
    </section>
  );
};
