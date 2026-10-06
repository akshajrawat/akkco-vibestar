import { useState, useEffect, useRef } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import {
  ChevronUp,
  ChevronDown,
  Copy,
  Trash2,
  FileCode2,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
} from "lucide-react";
import { monaco, language } from "../lib/monaco";
import { rpc, errorMessage } from "../lib/api";
import type { Task, Diff, DiffFile, FileDiff } from "../lib/types";
import { useTaskView, updateTaskView } from "../lib/taskView";
import { DiffReview } from "./DiffReview";
import { DiffFileTree } from "./DiffFileTree";
import { Button } from "./ui/button";
export const DiffView = ({
  task,
  revision,
  onError,
}: {
  task: Task;
  revision: number;
  onError: (s: string) => void;
}) => {
  const [diff, setDiff] = useState<Diff | null>(null);
  const [selected, setSelected] = useState<DiffFile | null>(null);
  const [content, setContent] = useState<FileDiff | null>(null);
  const view = useTaskView(task.id);
  const mode = view.diffMode,
    review = view.diffReview;
  const setMode = (diffMode: string) => updateTaskView(task.id, { diffMode });
  const setReview = (value: boolean | ((current: boolean) => boolean)) =>
    updateTaskView(task.id, {
      diffReview: typeof value === "function" ? value(review) : value,
    });
  const [selection, setSelection] = useState<{
    start: number;
    end: number;
    side: "base" | "working";
  }>({ start: 1, end: 1, side: "working" });
  const fullContext = view.fullContext,
    openFile = view.openFile;
  const setFullContext = (value: boolean | ((current: boolean) => boolean)) =>
    updateTaskView(task.id, {
      fullContext: typeof value === "function" ? value(fullContext) : value,
    });
  const setOpenFile = (openFile: boolean) =>
    updateTaskView(task.id, { openFile });
  const [refresh, setRefresh] = useState(0);
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const index = useRef(-1);
  useEffect(() => {
    let alive = true;
    void rpc<Diff>("task.diff", { id: task.id })
      .then((d) => {
        if (alive) {
          setDiff(d);
          setSelected(
            (current) =>
              d.files.find(
                (f) => f.path === (current?.path || view.diffPath),
              ) ||
              d.files[0] ||
              null,
          );
        }
      })
      .catch((e) => onError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [task.id, revision, refresh, onError, view.diffPath]);
  useEffect(() => {
    let alive = true;
    setContent(null);
    index.current = -1;
    if (selected)
      void rpc<FileDiff>("task.file", {
        id: task.id,
        path: selected.path,
        old_path: selected.old_path,
      })
        .then((c) => {
          if (alive) setContent(c);
        })
        .catch((e) => onError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [task.id, selected, revision, refresh, onError]);
  const discard = async (path?: string) => {
    if (
      !window.confirm(
        path
          ? `Discard ${path} back to saved base ${task.base_commit_sha.slice(0, 8)}?`
          : "Discard ALL task changes, including untracked files, back to the saved base commit?",
      )
    )
      return;
    try {
      await rpc("task.discard", { id: task.id, path, confirmed: true });
      setRefresh((v) => v + 1);
    } catch (e) {
      onError(errorMessage(e));
    }
  };
  const navigate = (direction: number) => {
    const e = editor.current;
    const changes = e?.getLineChanges();
    if (!e || !changes?.length) return;
    index.current =
      index.current < 0
        ? direction > 0
          ? 0
          : changes.length - 1
        : (index.current + direction + changes.length) % changes.length;
    const line = Math.max(1, changes[index.current].modifiedStartLineNumber);
    e.getModifiedEditor().setPosition({ lineNumber: line, column: 1 });
    e.getModifiedEditor().revealLineInCenter(line);
  };
  const selectFile = (file: DiffFile) => {
    updateTaskView(task.id, { diffPath: file.path });
    setSelected(file);
    setOpenFile(false);
  };
  const navigateFile = (direction: number) => {
    if (!diff?.files.length) return;
    const current = diff.files.findIndex((f) => f.path === selected?.path);
    selectFile(
      diff.files[(current + direction + diff.files.length) % diff.files.length],
    );
  };
  return (
    <div
      className="diff-view"
      onKeyDown={(e) => {
        if (e.key === "F7") {
          e.preventDefault();
          navigate(e.shiftKey ? -1 : 1);
        }
        if (e.altKey && ["ArrowDown", "ArrowUp"].includes(e.key)) {
          e.preventDefault();
          navigateFile(e.key === "ArrowDown" ? 1 : -1);
        }
      }}
    >
      <div className="diff-toolbar">
        <strong title="Saved base commit → complete working tree, including staged and untracked files">
          Final diff · <span>{diff?.files.length || 0} files changed</span>
        </strong>
        <span className="success">+{diff?.insertions || 0}</span>
        <span className="failure">−{diff?.deletions || 0}</span>
        <span className="subtle mono">
          base {task.base_commit_sha.slice(0, 12)}
        </span>
        <div className="spacer" />
        <Button
          size="sm"
          aria-label="Refresh diff"
          onClick={() => setRefresh((v) => v + 1)}
        >
          <RefreshCw size={12} />
        </Button>
        <select
          aria-label="Diff mode"
          value={mode}
          onChange={(e) => {
            setMode(e.target.value);
            setOpenFile(false);
          }}
        >
          <option value="side">Side by side</option>
          <option value="inline">Inline</option>
          <option value="unified">Unified</option>
        </select>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setFullContext((v) => !v)}
        >
          {fullContext ? "Collapse context" : "Expand context"}
        </Button>
        <Button
          size="sm"
          aria-label="Previous file"
          onClick={() => navigateFile(-1)}
        >
          <ChevronLeft size={14} />
        </Button>
        <Button
          size="sm"
          aria-label="Next file"
          onClick={() => navigateFile(1)}
        >
          <ChevronRight size={14} />
        </Button>
        <Button
          size="sm"
          aria-label="Previous change"
          onClick={() => navigate(-1)}
        >
          <ChevronUp size={14} />
        </Button>
        <Button size="sm" aria-label="Next change" onClick={() => navigate(1)}>
          <ChevronDown size={14} />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setReview((v) => !v)}
          aria-pressed={review}
        >
          <MessageSquare size={13} />
          Review
        </Button>
        <Button size="sm" variant="destructive" onClick={() => void discard()}>
          <Trash2 size={12} />
          Discard all
        </Button>
      </div>
      <div className="diff-body">
        <DiffFileTree
          files={diff?.files || []}
          selected={selected?.path}
          onSelect={selectFile}
        />
        <div className="diff-editor">
          {selected && (
            <div className="file-toolbar">
              <code>
                {selected.old_path ? `${selected.old_path} → ` : ""}
                {selected.path}
              </code>
              <span className="file-change-state">
                {selected.staged ? "Staged" : ""}
                {selected.staged && selected.unstaged ? " + " : ""}
                {selected.untracked
                  ? "Untracked"
                  : selected.unstaged
                    ? "Working tree"
                    : ""}
              </span>
              <div className="spacer" />
              <Button size="sm" onClick={() => setOpenFile(!openFile)}>
                <FileCode2 size={12} />
                {openFile ? "Back to diff" : "Open file"}
              </Button>
              <Button
                size="sm"
                aria-label="Copy file path"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(`${task.worktree_path}/${selected.path}`)
                    .catch((e) => onError(errorMessage(e)))
                }
              >
                <Copy size={12} />
              </Button>
              <Button
                size="sm"
                aria-label="Discard file changes"
                onClick={() => void discard(selected.path)}
              >
                <Trash2 size={12} />
              </Button>
            </div>
          )}
          {content &&
            selected &&
            !content.binary &&
            !openFile &&
            mode !== "unified" && (
              <div
                className={`diff-version-labels ${mode === "inline" ? "inline" : ""}`}
              >
                <span>
                  BASE · {task.base_commit_sha.slice(0, 8)}
                  {selected.old_path ? ` · ${selected.old_path}` : ""}
                </span>
                <span>WORKING TREE · {selected.path}</span>
              </div>
            )}
          {content?.binary ? (
            <div className="empty-row">
              Binary or oversized file. Diff rendering is unavailable.
            </div>
          ) : content && selected ? (
            openFile || mode === "unified" ? (
              <Editor
                theme="vibestar-dark"
                language={openFile ? language(selected.path) : "diff"}
                value={openFile ? content.modified : content.unified}
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  fontSize: 12,
                  automaticLayout: true,
                }}
              />
            ) : (
              <DiffEditor
                theme="vibestar-dark"
                language={language(selected.path)}
                original={content.original}
                modified={content.modified}
                originalModelPath={`base/${task.id}/${selected.path}`}
                modifiedModelPath={`working/${task.id}/${selected.path}`}
                onMount={(e) => {
                  editor.current = e;
                  e.getOriginalEditor().onDidChangeCursorSelection((event) =>
                    setSelection({
                      start: event.selection.startLineNumber,
                      end: event.selection.endLineNumber,
                      side: "base",
                    }),
                  );
                  e.getModifiedEditor().onDidChangeCursorSelection((event) =>
                    setSelection({
                      start: event.selection.startLineNumber,
                      end: event.selection.endLineNumber,
                      side: "working",
                    }),
                  );
                  e.getModifiedEditor().addAction({
                    id: "vibestar.local-review",
                    label: "Add local review note",
                    contextMenuGroupId: "navigation",
                    run: () => setReview(true),
                  });
                }}
                options={{
                  readOnly: true,
                  originalEditable: false,
                  renderSideBySide: mode === "side",
                  minimap: { enabled: false },
                  fontSize: 12,
                  automaticLayout: true,
                  scrollBeyondLastLine: false,
                  renderIndicators: true,
                  hideUnchangedRegions: {
                    enabled: !fullContext,
                    contextLineCount: 3,
                    minimumLineCount: 8,
                    revealLineCount: 12,
                  },
                  renderMarginRevertIcon: false,
                  diffWordWrap: "on",
                  padding: { top: 8 },
                  stickyScroll: { enabled: true },
                  accessibilityVerbose: true,
                  ariaLabel: `Final diff for ${selected.path}`,
                }}
              />
            )
          ) : (
            <div className="empty-row">
              {selected ? "Loading file…" : "Select a changed file"}
            </div>
          )}
          {review && selected && (
            <DiffReview
              taskId={task.id}
              path={selected.path}
              oldPath={selected.old_path}
              selection={selection}
              revision={revision}
              onError={onError}
            />
          )}
        </div>
      </div>
    </div>
  );
};
