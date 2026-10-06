import { useState, useRef, useEffect, lazy, Suspense } from "react";
import {
  GitBranch,
  FolderOpen,
  Send,
  Square,
  RotateCcw,
  Check,
  ChevronLeft,
  PanelBottom,
  X,
} from "lucide-react";
import type { Detail, Repository } from "../lib/types";
import { activeStatuses, stages } from "../lib/types";
import { rpc, errorMessage } from "../lib/api";
import { Button } from "./ui/button";
import { Status } from "./Status";
import { ComposerSettings } from "./ComposerSettings";
import { TaskTerminal } from "./TaskTerminal";
import { ResizeHandle } from "./ResizeHandle";
import { usePaneSize } from "../lib/usePaneSize";
import { useTaskView, updateTaskView } from "../lib/taskView";
import { AgentTimeline } from "./AgentTimeline";
import { PlanView } from "./PlanView";
const DiffView = lazy(() =>
  import("./DiffView").then((module) => ({ default: module.DiffView })),
);
import { LogView } from "./LogView";
import { TestsView } from "./TestsView";
export const TaskWorkspace = ({
  detail,
  repository,
  revision,
  onError,
  initialTab = "Chat",
  back,
}: {
  detail: Detail;
  repository?: Repository;
  revision: number;
  onError: (s: string) => void;
  initialTab?: string;
  back: () => void;
}) => {
  const view = useTaskView(detail.task.id);
  const tab = view.tab,
    input = view.draft;
  const setTab = (tab: string) => updateTaskView(detail.task.id, { tab });
  const setInput = (draft: string) => updateTaskView(detail.task.id, { draft });
  const [stageWidth, setStageWidth] = usePaneSize("stageWidth", 240, 180, 400);
  const [terminalHeight, setTerminalHeight] = usePaneSize(
    "terminalHeight",
    230,
    120,
    500,
  );
  useEffect(() => {
    if (initialTab === "Changes")
      updateTaskView(detail.task.id, { tab: "Changes" });
  }, [initialTab, detail.task.id]);
  const [busy, setBusy] = useState(false);
  const [selectedRun, setSelectedRun] = useState<string>();
  const t = detail.task;
  const active = !!detail.active || activeStatuses.includes(t.status);
  const timeline = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    if (stick.current)
      timeline.current?.scrollTo({ top: timeline.current.scrollHeight });
  }, [detail.events.length]);
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
  return (
    <div className="workspace">
      <header className="workspace-header">
        <div className="workspace-heading">
          <Button variant="ghost" size="icon" aria-label="Back" onClick={back}>
            <ChevronLeft size={16} />
          </Button>
          <div>
            <div className="repo-label">
              {repository?.owner}/{repository?.name}{" "}
              <button
                className="issue-link"
                onClick={() => void window.vibestar.openExternal(t.issue_url)}
              >
                #{t.issue_number}
              </button>
            </div>
            <h1>{t.claimed_scope}</h1>
          </div>
          <div className="spacer" />
          <Status status={t.status} />
          <Button
            size="sm"
            onClick={() =>
              void action("open.directory", { id: t.id, kind: "task" })
            }
          >
            <FolderOpen size={13} />
            Open worktree
          </Button>
          {active ? (
            <Button size="sm" onClick={() => void action("task.cancel")}>
              <Square size={12} />
              Cancel
            </Button>
          ) : t.status === "ready_for_review" ? (
            <Button
              size="sm"
              variant="default"
              onClick={() => void action("task.complete")}
            >
              <Check size={12} />
              Complete
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void action("task.retry")}
            >
              <RotateCcw size={12} />
              Resume / retry
            </Button>
          )}
        </div>
        <div className="workspace-info mono">
          <span>
            <GitBranch size={12} />
            {t.branch_name || "Queued for preparation"}
          </span>
          <span>
            base {t.base_commit_sha.slice(0, 12) || "pending"} · upstream/
            {t.base_branch}
          </span>
          <span>{stages[t.stage]}</span>
        </div>
        <div className="cwd-banner">
          <span>Assigned worktree</span>
          <code>{t.worktree_path || "Created during preparation"}</code>
        </div>
      </header>
      {t.error && <div className="error-box">{t.error}</div>}
      <div className="workspace-tabs">
        {["Chat", "Plan", "Changes", "Tests", "Terminal", "Logs"].map((v) => (
          <button
            className={tab === v ? "selected" : ""}
            key={v}
            onClick={() => setTab(v)}
          >
            {v}
          </button>
        ))}
        <div className="spacer" />
        <Button
          size="sm"
          variant="ghost"
          aria-label="Toggle terminal dock"
          onClick={() =>
            updateTaskView(t.id, { terminalDock: !view.terminalDock })
          }
        >
          <PanelBottom size={14} />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={active || busy}
          onClick={() => void action("task.retry", { id: t.id, restart: true })}
        >
          Restart pipeline
        </Button>
      </div>
      <div className="workspace-content">
        {tab === "Chat" ? (
          <div className="chat-layout">
            <div className="chat-main">
              <div
                ref={timeline}
                className="event-timeline"
                onScroll={(e) => {
                  const el = e.currentTarget;
                  stick.current =
                    el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                }}
              >
                <div className="context-message">
                  <span className="eyebrow">Issue context</span>
                  <h2>{t.issue.title || `Issue #${t.issue_number}`}</h2>
                  <p>
                    {t.notes ||
                      "Only the claimed scope is assigned to this task."}
                  </p>
                  <details>
                    <summary>View full issue context</summary>
                    <pre>{JSON.stringify(t.issue, null, 2)}</pre>
                  </details>
                </div>
                {detail.messages.map((m) => (
                  <div className="user-message" key={m.id}>
                    <strong>You</strong>
                    <p>{m.content}</p>
                  </div>
                ))}
                <AgentTimeline events={detail.events} runs={detail.runs} />
              </div>
              <form
                className="chat-input"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!input.trim()) return;
                  setBusy(true);
                  try {
                    await rpc("task.followup", { id: t.id, content: input });
                    setInput("");
                  } catch (e) {
                    onError(errorMessage(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <textarea
                  aria-label="Task follow-up"
                  rows={2}
                  value={input}
                  placeholder={
                    active
                      ? "Wait for this stage or cancel to send a continuation…"
                      : "Send follow-up instructions to this task…"
                  }
                  onChange={(e) => setInput(e.target.value)}
                />
                <Button
                  type="submit"
                  aria-label="Send follow-up"
                  disabled={active || busy || t.stage < 3 || !input.trim()}
                >
                  <Send size={15} />
                </Button>
                <ComposerSettings task={t} active={active} onError={onError} />
                <small>
                  Continuation reconstructs this task’s persisted context in the
                  same worktree.
                </small>
              </form>
            </div>
            <ResizeHandle
              label="Resize stage pane"
              value={stageWidth}
              onChange={setStageWidth}
              min={180}
              max={400}
              reverse
            />
            <aside className="stage-rail" style={{ width: stageWidth }}>
              <h3>Pipeline</h3>
              {stages.map((s, i) => {
                const run = [...detail.runs]
                  .reverse()
                  .find((r) => r.stage === i && r.purpose !== "scheduled");
                return (
                  <div className="stage-row" key={s}>
                    <button
                      onClick={() => {
                        if (i === 0) {
                          setSelectedRun("preparation");
                          setTab("Logs");
                        } else if (i === 1 || i === 2) setTab("Plan");
                        else if (i === 4) setTab("Tests");
                        else if (run) {
                          setSelectedRun(run.id);
                          setTab("Logs");
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
                            {run.provider} · {run.model || "CLI default"}
                            <br />
                            {run.effort} · {run.status}
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
                    {run && (
                      <button
                        className="stage-inspect"
                        onClick={() => {
                          setSelectedRun(run.id);
                          setTab("Logs");
                        }}
                      >
                        Inspect prompt / logs
                      </button>
                    )}
                  </div>
                );
              })}
              <div className="rail-note">
                Base stays pinned until you deliberately update it. Personal
                checkouts are never used.
              </div>
            </aside>
          </div>
        ) : tab === "Plan" ? (
          <PlanView artifacts={detail.artifacts} />
        ) : tab === "Terminal" ? (
          <TaskTerminal
            task={t}
            onError={onError}
            dock={() =>
              updateTaskView(t.id, { terminalDock: true, tab: "Chat" })
            }
          />
        ) : tab === "Changes" ? (
          t.worktree_path ? (
            <Suspense
              fallback={<p className="empty-row">Loading diff editor…</p>}
            >
              <DiffView task={t} revision={revision} onError={onError} />
            </Suspense>
          ) : (
            <p className="empty-row">Worktree preparation is pending.</p>
          )
        ) : tab === "Tests" ? (
          <TestsView detail={detail} onError={onError} />
        ) : (
          <LogView
            taskId={t.id}
            runs={detail.runs}
            events={detail.events}
            selectedRun={selectedRun}
          />
        )}
      </div>
      {view.terminalDock && tab !== "Terminal" && (
        <>
          <ResizeHandle
            label="Resize terminal dock"
            value={terminalHeight}
            onChange={setTerminalHeight}
            min={120}
            max={500}
            vertical
            reverse
          />
          <div className="terminal-dock" style={{ height: terminalHeight }}>
            <button
              className="terminal-hide"
              aria-label="Hide terminal dock"
              onClick={() => updateTaskView(t.id, { terminalDock: false })}
            >
              <X size={12} />
            </button>
            <TaskTerminal task={t} onError={onError} />
          </div>
        </>
      )}
    </div>
  );
};
