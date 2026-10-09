import { CodeAskAI } from "./CodeAskAI";
import type { ReviewNote } from "../../backend/review/service";
import { useState, useEffect, useRef, useId } from "react";
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
  X,
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
  const [reviews, setReviews] = useState<
    { path: string; hash: string; reviewed: boolean; notes: number }[]
  >([]);
  const [notes, setNotes] = useState<ReviewNote[]>([]);
  const [ask, setAsk] = useState(false);
  const [editorRevision, setEditorRevision] = useState(0);
  const [selected, setSelected] = useState<DiffFile | null>(null);
  const [content, setContent] = useState<FileDiff | null>(null);
  const view = useTaskView(task.id);
  const selections = useRef(view.diffSelections);
  selections.current = view.diffSelections;
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
  const instance = useId();
  const loadedFile = useRef("");
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
                (f) => f.path === (view.diffPath || current?.path),
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
    const key = `${task.id}/${selected?.path || ""}`;
    if (loadedFile.current !== key) {
      setContent(null);
      loadedFile.current = key;
    }
    index.current = -1;
    if (selected) {
      setSelection(
        selections.current[selected.path] || {
          start: 1,
          end: 1,
          side: "working",
        },
      );
      void rpc<FileDiff>("task.file", {
        id: task.id,
        path: selected.path,
        old_path: selected.old_path,
      })
        .then((c) => {
          if (alive) setContent(c);
        })
        .catch((e) => onError(errorMessage(e)));
    }
    return () => {
      alive = false;
    };
  }, [task.id, selected, revision, refresh, onError]);
  useEffect(() => {
    let alive = true;
    if (!task.worktree_path) return;
    void Promise.all([
      rpc<typeof reviews>("review.files", { id: task.id }),
      rpc<ReviewNote[]>("review.list", { id: task.id }),
    ])
      .then(([files, notes]) => {
        if (alive) {
          setReviews(files);
          setNotes(notes);
        }
      })
      .catch((e) => onError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [task.id, task.worktree_path, revision, refresh, onError]);
  useEffect(() => {
    const e = editor.current;
    if (!e || !selected) return;
    const collections = (["base", "working"] as const).map((side) => {
      const pane =
        side === "base" ? e.getOriginalEditor() : e.getModifiedEditor();
      const count = pane.getModel()?.getLineCount() || 1;
      return pane.createDecorationsCollection(
        notes
          .filter(
            (n) =>
              n.side === side &&
              (n.path === selected.path || n.path === selected.old_path),
          )
          .map((n) => ({
            range: new monaco.Range(
              Math.min(n.line_start, count),
              1,
              Math.min(n.line_end, count),
              1,
            ),
            options: {
              isWholeLine: true,
              glyphMarginClassName: "review-note-marker",
              className: "review-note-line",
              glyphMarginHoverMessage: { value: n.content, isTrusted: false },
            },
          })),
      );
    });
    return () => {
      collections.forEach((c) => c.clear());
    };
  }, [notes, selected, content, editorRevision]);
  const saveSelection = (value: typeof selection) => {
    setSelection(value);
    if (selected)
      updateTaskView(task.id, {
        diffSelections: { ...view.diffSelections, [selected.path]: value },
      });
  };
  const selectRange = (range: monaco.Selection, side: "base" | "working") =>
    saveSelection({
      start: range.startLineNumber,
      end: Math.max(
        range.startLineNumber,
        range.endLineNumber -
          (range.endColumn === 1 && range.endLineNumber > range.startLineNumber
            ? 1
            : 0),
      ),
      side,
    });
  const currentReview = reviews.find((r) => r.path === selected?.path);
  const markReviewed = async () => {
    if (!selected || !currentReview) return;
    try {
      await rpc("review.reviewed", {
        id: task.id,
        path: selected.path,
        old_path: selected.old_path,
        expected_hash: currentReview.hash,
        reviewed: !currentReview.reviewed,
      });
      setRefresh((n) => n + 1);
    } catch (e) {
      onError(errorMessage(e));
    }
  };
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
          Changes · <span>{diff?.files.length || 0} files changed</span>
        </strong>
        <span className="success">+{diff?.insertions || 0}</span>
        <span className="failure">−{diff?.deletions || 0}</span>
        <span className="subtle mono">
          base {task.base_commit_sha.slice(0, 12)}
        </span>
        <small className="subtle">
          {reviews.filter((r) => r.reviewed).length} / {diff?.files.length || 0}{" "}
          reviewed
        </small>
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
        <Button
          size="sm"
          disabled={
            !selected ||
            !content ||
            content.binary ||
            (!openFile && mode === "unified")
          }
          onClick={() => setAsk(!ask)}
        >
          Ask AI
        </Button>
        <Button
          size="sm"
          aria-label="Copy diff"
          disabled={!content}
          onClick={() =>
            void navigator.clipboard
              .writeText(content?.unified || "")
              .catch((e) => onError(errorMessage(e)))
          }
        >
          Copy diff
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
          reviews={reviews}
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
              <Button
                size="sm"
                aria-pressed={!!currentReview?.reviewed}
                disabled={!currentReview || content?.binary}
                onClick={() => void markReviewed()}
              >
                {currentReview?.reviewed ? "✓ Reviewed" : "Mark reviewed"}
              </Button>
              <Button
                size="sm"
                aria-label="Copy selected code"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(
                      (selection.side === "base"
                        ? content?.original
                        : content?.modified
                      )
                        ?.split("\n")
                        .slice(selection.start - 1, selection.end)
                        .join("\n") || "",
                    )
                    .catch((e) => onError(errorMessage(e)))
                }
              >
                Copy selection
              </Button>
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
                key={`${openFile ? "file" : "unified"}/${selected.path}`}
                theme="vibestar-dark"
                language={openFile ? language(selected.path) : "diff"}
                value={openFile ? content.modified : content.unified}
                onMount={(pane) => {
                  if (!openFile) return;
                  const saved = view.diffSelections[selected.path];
                  if (saved?.side === "working")
                    pane.setSelection(
                      new monaco.Selection(saved.start, 1, saved.end, 100000),
                    );
                  pane.onDidChangeCursorSelection((event) =>
                    selectRange(event.selection, "working"),
                  );
                  pane.addAction({
                    id: "vibestar.ask-ai",
                    label: "Ask AI about selected code",
                    contextMenuGroupId: "navigation",
                    run: () => setAsk(true),
                  });
                }}
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  fontSize: 12,
                  automaticLayout: true,
                }}
              />
            ) : (
              <DiffEditor
                key={selected.path}
                theme="vibestar-dark"
                language={language(selected.path)}
                original={content.original}
                modified={content.modified}
                originalModelPath={`base/${task.id}/${instance}/${selected.path}`}
                modifiedModelPath={`working/${task.id}/${instance}/${selected.path}`}
                keepCurrentOriginalModel
                keepCurrentModifiedModel
                onMount={(e) => {
                  editor.current = e;
                  setEditorRevision((n) => n + 1);
                  const saved = view.diffSelections[selected.path];
                  if (saved)
                    (saved.side === "base"
                      ? e.getOriginalEditor()
                      : e.getModifiedEditor()
                    ).setSelection(
                      new monaco.Selection(saved.start, 1, saved.end, 100000),
                    );
                  const models = e.getModel();
                  // The React wrapper disposes models before the diff widget.
                  // Monaco requires detaching the widget first. Own these models
                  // per pane and release them after editor disposal completes.
                  e.onDidDispose(() =>
                    queueMicrotask(() => {
                      if (editor.current === e) editor.current = null;
                      if (!models?.original.isDisposed())
                        models?.original.dispose();
                      if (!models?.modified.isDisposed())
                        models?.modified.dispose();
                    }),
                  );
                  e.getOriginalEditor().onDidChangeCursorSelection((event) =>
                    selectRange(event.selection, "base"),
                  );
                  e.getModifiedEditor().onDidChangeCursorSelection((event) =>
                    selectRange(event.selection, "working"),
                  );
                  for (const pane of [
                    e.getOriginalEditor(),
                    e.getModifiedEditor(),
                  ])
                    pane.addAction({
                      id: "vibestar.ask-ai",
                      label: "Ask AI about selected code",
                      contextMenuGroupId: "navigation",
                      run: () => setAsk(true),
                    });
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
                  glyphMargin: true,
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
              {selected
                ? "Loading file…"
                : task.stage < 3
                  ? "No changes yet. Planning is in progress or waiting to resume; changes appear when implementation begins."
                  : task.status === "implementing"
                    ? "Watching worktree for changes…"
                    : "No changes against the saved base."}
            </div>
          )}
        </div>
        {(ask || review) && selected && (
          <aside
            className={`review-rail ${!ask ? "review-only" : ""}`}
            aria-label="Code review sidebar"
          >
            <div className="review-rail-heading">
              <strong>Code review</strong>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Close code review sidebar"
                onClick={() => {
                  setAsk(false);
                  setReview(false);
                }}
              >
                <X size={13} />
              </Button>
            </div>
            {ask && (
              <CodeAskAI
                key={selected.path}
                task={task}
                path={selected.path}
                oldPath={selected.old_path}
                selection={selection}
                revision={revision + refresh}
              />
            )}
            {review && (
              <DiffReview
                taskId={task.id}
                path={selected.path}
                oldPath={selected.old_path}
                selection={selection}
                revision={revision}
                onError={onError}
              />
            )}
          </aside>
        )}
      </div>
    </div>
  );
};
