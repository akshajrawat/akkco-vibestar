import { useState, useRef, useEffect, lazy, Suspense } from "react";
import {
  GitBranch,
  FolderOpen,
  ArrowUp,
  Square,
  RotateCcw,
  Check,
  PanelBottom,
  PanelRight,
  X,
  Plus,
  ChevronRight,
} from "lucide-react";
import type { Detail, Repository, Diff } from "../lib/types";
import { activeStatuses, stages } from "../lib/types";
import { rpc, errorMessage } from "../lib/api";
import { modelEffortError } from "../../backend/domain";
import { Button } from "./ui/button";
import { Status } from "./Status";
import { ComposerSettings, followupConfiguration } from "./ComposerSettings";
import { TaskTerminal } from "./TaskTerminal";
import { ResizeHandle } from "./ResizeHandle";
import { usePaneSize } from "../lib/usePaneSize";
import { useTaskView, updateTaskView } from "../lib/taskView";
import { AgentTimeline } from "./AgentTimeline";
import { AgentResponse } from "./AgentResponse";
import { PlanView } from "./PlanView";
import { LogView } from "./LogView";
import { TestsView } from "./TestsView";
const DiffView = lazy(() =>
  import("./DiffView").then((m) => ({ default: m.DiffView })),
);
export const TaskWorkspace = ({
  detail,
  repository,
  revision,
  onError,
  back,
}: {
  detail: Detail;
  repository?: Repository;
  revision: number;
  onError: (s: string) => void;
  back: () => void;
}) => {
  const t = detail.task;
  const view = useTaskView(t.id);
  const [paneWidth, setPaneWidth] = usePaneSize("contextWidth", 560, 240, 1000);
  const [dockHeight, setDockHeight] = usePaneSize("dockHeight", 260, 120, 500);
  const [busy, setBusy] = useState(false);
  const [addingContext, setAddingContext] = useState(false);
  const [contextText, setContextText] = useState("");
  const [selectedRun, setSelectedRun] = useState<string>();
  const [diff, setDiff] = useState<Diff | null>(null);
  const [liveRevision, setLiveRevision] = useState(0);
  const timeline = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const refreshDiff = useRef<(() => Promise<void>) | null>(null);
  const active = !!detail.executing || activeStatuses.includes(t.status);
  const occupied = !!detail.active;
  const watchChanges = active || occupied;
  useEffect(() => {
    if (stick.current)
      timeline.current?.scrollTo({ top: timeline.current.scrollHeight });
  }, [detail.events.length, detail.runs.length, detail.activity?.length]);
  useEffect(() => {
    if (!t.worktree_path) return;
    let alive = true;
    let fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const value = await rpc<Diff>("task.diff", { id: t.id });
        if (alive) {
          setDiff(value);
          setLiveRevision((v) => v + 1);
        }
      } catch (e) {
        if (alive) onError(errorMessage(e));
      } finally {
        fetching = false;
      }
    };
    refreshDiff.current = refresh;
    void refresh();
    const timer = watchChanges
      ? setInterval(() => void refresh(), 2000)
      : undefined;
    return () => {
      alive = false;
      refreshDiff.current = null;
      if (timer) clearInterval(timer);
    };
  }, [t.id, t.worktree_path, watchChanges, onError]);
  useEffect(() => {
    void refreshDiff.current?.();
  }, [revision]);
  const action = async (method: string, params: unknown = { id: t.id }) => {
    setBusy(true);
    try {
      await rpc(method, params);
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const dock = (dockTab: string) =>
    updateTaskView(t.id, { terminalDock: true, dockTab });
  const openDiff = (path: string) =>
    updateTaskView(t.id, {
      contextPane: "changes",
      diffPath: path.replace(`${t.worktree_path}/`, ""),
      diffMode: "inline",
      openFile: false,
    });
  const changes = (
    <Suspense fallback={<p className="empty-row">Loading changes…</p>}>
      {t.worktree_path ? (
        <DiffView task={t} revision={liveRevision} onError={onError} />
      ) : (
        <p className="empty-row">Preparing the worktree…</p>
      )}
    </Suspense>
  );
  const submit = async () => {
    if (!view.draft.trim() || active || occupied || busy) return;
    const configuration = followupConfiguration(t, view);
    const error = modelEffortError(
      configuration.provider,
      configuration.config.model,
      configuration.config.effort,
    );
    if (error) {
      onError(error);
      return;
    }
    setBusy(true);
    try {
      await rpc("task.followup", {
        id: t.id,
        content: view.draft,
        configuration,
      });
      updateTaskView(t.id, { draft: "" });
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="workspace">
      <header className="workspace-header">
        <div className="workspace-heading">
          <button className="breadcrumb" onClick={back}>
            {repository?.owner}/{repository?.name}
          </button>
          <ChevronRight size={12} />
          <button
            className="issue-link"
            onClick={() => void window.vibestar.openExternal(t.issue_url)}
          >
            #{t.issue_number}
          </button>
          <strong className="task-title" title={t.issue.title}>
            {t.scope_mode === "whole_issue"
              ? t.issue.title || "Entire issue"
              : t.claimed_scope}
          </strong>
          <div className="spacer" />
          <Status status={t.status} />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open worktree"
            disabled={!t.worktree_path}
            onClick={() =>
              void action("open.directory", { id: t.id, kind: "task" })
            }
          >
            <FolderOpen size={14} />
          </Button>
          {active ? (
            <Button size="sm" onClick={() => void action("task.cancel")}>
              <Square size={11} />
              Stop
            </Button>
          ) : t.status === "ready_for_review" ? (
            <Button
              size="sm"
              disabled={occupied || busy}
              onClick={() => void action("task.complete")}
            >
              <Check size={12} />
              Complete
            </Button>
          ) : t.status !== "completed" ? (
            <Button
              size="sm"
              disabled={busy || occupied}
              onClick={() => void action("task.retry")}
            >
              <RotateCcw size={12} />
              Resume
            </Button>
          ) : null}
        </div>
      </header>
      {t.error && <p className="error-box">{t.error}</p>}
      <div className="workspace-tabs" role="tablist" aria-label="Task views">
        {["Chat", "Plan", "Changes"].map((tab) => (
          <button
            role="tab"
            aria-label={tab}
            aria-selected={view.tab === tab}
            className={view.tab === tab ? "selected" : ""}
            key={tab}
            onClick={() => updateTaskView(t.id, { tab })}
          >
            {tab}
            {tab === "Changes" && !!diff?.files.length && (
              <small>{diff.files.length}</small>
            )}
          </button>
        ))}
        <div className="spacer" />
        {diff && !!diff.files.length && (
          <button
            className="diff-stats"
            onClick={() => updateTaskView(t.id, { tab: "Changes" })}
          >
            <span className="success">+{diff.insertions}</span>
            <span className="failure">−{diff.deletions}</span>
          </button>
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-label="Split Changes beside chat"
          aria-pressed={view.contextPane === "changes"}
          onClick={() =>
            updateTaskView(t.id, {
              tab: "Chat",
              contextPane: view.contextPane === "changes" ? "none" : "changes",
              diffMode: "inline",
            })
          }
        >
          <PanelRight size={14} />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Toggle pipeline context"
          aria-pressed={view.contextPane === "pipeline"}
          onClick={() =>
            updateTaskView(t.id, {
              contextPane:
                view.contextPane === "pipeline" ? "none" : "pipeline",
            })
          }
        >
          Pipeline
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Toggle utility dock"
          onClick={() =>
            updateTaskView(t.id, { terminalDock: !view.terminalDock })
          }
        >
          <PanelBottom size={14} />
        </Button>
      </div>
      <div className="workspace-content">
        {view.tab === "Chat" ? (
          <div className="chat-main">
            <div
              className="event-timeline"
              ref={timeline}
              onScroll={(e) => {
                const el = e.currentTarget;
                stick.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              }}
            >
              <article className="context-message">
                <small>
                  You ·{" "}
                  {t.scope_mode === "whole_issue"
                    ? "Entire issue"
                    : "Specific scope"}
                </small>
                <h2>{t.issue.title || `Issue #${t.issue_number}`}</h2>
                <p>
                  {t.scope_mode === "whole_issue"
                    ? "All issue requirements are in scope."
                    : t.claimed_scope}
                </p>
                {t.notes && <p>{t.notes}</p>}
                <details>
                  <summary>Issue context</summary>
                  <AgentResponse text={t.issue.body || "No description"} />
                </details>
              </article>
              <section className="preparation-turn">
                <strong>Preparing repository</strong>
                {detail.activity?.map((row) => {
                  const data = JSON.parse(row.data) as {
                    argv: string[];
                    code: number;
                    stdout: string;
                    stderr: string;
                    duration_ms: number;
                  };
                  return (
                    <details key={row.id}>
                      <summary>
                        <span
                          className={data.code === 0 ? "success" : "failure"}
                        >
                          {data.code === 0 ? "✓" : "!"}
                        </span>
                        <code>{data.argv.join(" ")}</code>
                        <small>{Math.round(data.duration_ms / 1000)}s</small>
                      </summary>
                      <pre>{data.stdout || data.stderr}</pre>
                    </details>
                  );
                })}
                {t.worktree_path && (
                  <p className="mono subtle">
                    <GitBranch size={12} />
                    {t.branch_name}
                  </p>
                )}
                {t.stage === 0 && active && (
                  <p className="subtle">
                    Fetching upstream and creating an isolated worktree…
                  </p>
                )}
              </section>
              <AgentTimeline
                events={detail.events}
                runs={detail.runs}
                messages={detail.messages}
                files={diff?.files}
                openDiff={openDiff}
              />
              {!!diff?.files.length && (
                <details className="chat-changes" open>
                  <summary>
                    Changed {diff.files.length}{" "}
                    {diff.files.length === 1 ? "file" : "files"}
                  </summary>
                  {diff.files.map((file) => (
                    <button
                      className="edited-file"
                      key={file.path}
                      onClick={() => openDiff(file.path)}
                    >
                      <code>{file.path}</code>
                      <span className="spacer" />
                      <span className="success">+{file.insertions}</span>
                      <span className="failure">−{file.deletions}</span>
                    </button>
                  ))}
                </details>
              )}
              {detail.tests.length > 0 && (
                <section className="validation-turn">
                  <button onClick={() => dock("Tests")}>
                    Validation{" "}
                    <span
                      className={
                        detail.tests.at(-1)?.status === "passed"
                          ? "success"
                          : "warning"
                      }
                    >
                      {detail.tests.at(-1)?.status}
                    </span>
                  </button>
                </section>
              )}
              {t.status === "ready_for_review" && (
                <button
                  className="ready-review"
                  onClick={() => updateTaskView(t.id, { tab: "Changes" })}
                >
                  <Check size={14} />
                  Ready for review
                  <span className="spacer" />
                  {diff?.files.length || 0}{" "}
                  {diff?.files.length === 1 ? "file" : "files"}
                  <ChevronRight size={14} />
                </button>
              )}
            </div>
            <form
              className="chat-input"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              {addingContext && (
                <div className="composer-context">
                  <input
                    autoFocus
                    aria-label="Context file or note"
                    placeholder="Worktree-relative file path or context note"
                    value={contextText}
                    onChange={(e) => setContextText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setAddingContext(false);
                      }
                      if (e.key === "Enter") e.preventDefault();
                    }}
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={!contextText.trim()}
                    onClick={() => {
                      updateTaskView(t.id, {
                        draft: `${view.draft}${view.draft ? "\n" : ""}@${contextText.trim()}`,
                      });
                      setContextText("");
                      setAddingContext(false);
                    }}
                  >
                    Add
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="Cancel context"
                    onClick={() => setAddingContext(false)}
                  >
                    <X size={13} />
                  </Button>
                </div>
              )}
              <textarea
                aria-label="Task follow-up"
                rows={2}
                value={view.draft}
                placeholder={
                  active
                    ? "Draft your next message while the agent works…"
                    : occupied
                      ? "Close the task terminal before sending…"
                      : "Ask Vibestar…"
                }
                onChange={(e) =>
                  updateTaskView(t.id, { draft: e.target.value })
                }
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
              <div className="composer-toolbar">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-expanded={addingContext}
                  onClick={() => setAddingContext((value) => !value)}
                >
                  <Plus size={13} />
                  Context
                </Button>
                <div className="spacer" />
                <ComposerSettings task={t} />
                {active ? (
                  <Button
                    type="button"
                    aria-label="Stop agent"
                    onClick={() => void action("task.cancel")}
                  >
                    <Square size={12} />
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    variant="default"
                    aria-label="Send follow-up"
                    disabled={
                      busy || occupied || t.stage < 3 || !view.draft.trim()
                    }
                  >
                    <ArrowUp size={15} />
                  </Button>
                )}
              </div>
              {active && (
                <small className="composer-note">
                  Draft is saved for this task. Stop or wait for the current run
                  to send it.
                </small>
              )}
            </form>
          </div>
        ) : view.tab === "Plan" ? (
          <PlanView artifacts={detail.artifacts} />
        ) : (
          changes
        )}
        {view.contextPane !== "none" && view.tab !== "Changes" && (
          <>
            <ResizeHandle
              label="Resize context pane"
              value={paneWidth}
              onChange={setPaneWidth}
              min={240}
              max={1000}
              reverse
            />
            <aside
              className={`context-pane ${view.contextPane}`}
              style={{ width: paneWidth, maxWidth: "60%" }}
            >
              <div className="context-heading">
                <strong>
                  {view.contextPane === "changes" ? "Changes" : "Task context"}
                </strong>
                <div className="spacer" />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Close context pane"
                  onClick={() => updateTaskView(t.id, { contextPane: "none" })}
                >
                  <X size={13} />
                </Button>
              </div>
              {view.contextPane === "changes" ? (
                changes
              ) : (
                <div className="stage-rail">
                  <h3>Pipeline</h3>
                  {stages.map((s, i) => {
                    const run = [...detail.runs]
                      .reverse()
                      .find((r) => r.stage === i && r.purpose !== "scheduled");
                    return (
                      <div className="stage-row" key={s}>
                        <button
                          onClick={() => {
                            if (i === 1 || i === 2)
                              updateTaskView(t.id, { tab: "Plan" });
                            else if (i === 4) dock("Tests");
                            else {
                              setSelectedRun(run?.id || "preparation");
                              dock("Logs");
                            }
                          }}
                        >
                          <span
                            className={
                              i < t.stage
                                ? "success"
                                : i === t.stage
                                  ? "running"
                                  : "subtle"
                            }
                          >
                            {i < t.stage ? "✓" : i === t.stage ? "→" : "○"}
                          </span>
                          <div>
                            {s}
                            {run && (
                              <small>
                                {run.model || "CLI default"} · {run.effort} ·{" "}
                                {run.status}
                              </small>
                            )}
                          </div>
                        </button>
                        {i > 0 && i <= Math.min(t.stage, 4) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={active || busy}
                            onClick={() =>
                              void action("task.retry", { id: t.id, stage: i })
                            }
                          >
                            Retry stage
                          </Button>
                        )}
                      </div>
                    );
                  })}
                  <details className="task-metadata">
                    <summary>Worktree</summary>
                    <code>{t.worktree_path}</code>
                    <p>
                      Base {t.base_commit_sha} · {t.base_branch}
                    </p>
                  </details>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={active || busy}
                    onClick={() =>
                      void action("task.retry", { id: t.id, restart: true })
                    }
                  >
                    Restart pipeline
                  </Button>
                </div>
              )}
            </aside>
          </>
        )}
      </div>
      {view.terminalDock && (
        <>
          <ResizeHandle
            label="Resize utility dock"
            value={dockHeight}
            onChange={setDockHeight}
            min={120}
            max={500}
            vertical
            reverse
          />
          <div className="utility-dock" style={{ height: dockHeight }}>
            <div className="dock-tabs" role="tablist" aria-label="Utilities">
              {["Problems", "Tests", "Terminal", "Logs"].map((tab) => (
                <button
                  role="tab"
                  aria-selected={view.dockTab === tab}
                  className={view.dockTab === tab ? "selected" : ""}
                  key={tab}
                  onClick={() => dock(tab)}
                >
                  {tab}
                </button>
              ))}
              <div className="spacer" />
              <Button
                variant="ghost"
                size="icon"
                aria-label="Hide utility dock"
                onClick={() => updateTaskView(t.id, { terminalDock: false })}
              >
                <X size={13} />
              </Button>
            </div>
            <div className="dock-content">
              {view.dockTab === "Terminal" ? (
                <TaskTerminal task={t} onError={onError} />
              ) : view.dockTab === "Tests" ? (
                <TestsView detail={detail} onError={onError} />
              ) : view.dockTab === "Logs" ? (
                <LogView
                  taskId={t.id}
                  runs={detail.runs}
                  events={detail.events}
                  selectedRun={selectedRun}
                />
              ) : (
                <div className="problems-panel">
                  {t.error ? (
                    <p className="failure">{t.error}</p>
                  ) : (
                    <p className="subtle">No task problems</p>
                  )}
                  {detail.tests
                    .filter((test) => test.status === "failed")
                    .map((test) => (
                      <p className="failure" key={test.id}>
                        {test.command} · exit {test.exit_code}
                      </p>
                    ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
      <footer className="workspace-status">
        <GitBranch size={11} />
        <span>{t.branch_name || "Preparing worktree"}</span>
        <span className="spacer" />
        <span>
          {t.scope_mode === "whole_issue" ? "Entire issue" : "Partial scope"}
        </span>
        <span>base {t.base_commit_sha.slice(0, 8) || "pending"}</span>
        <span>{stages[t.stage]}</span>
      </footer>
    </div>
  );
};
