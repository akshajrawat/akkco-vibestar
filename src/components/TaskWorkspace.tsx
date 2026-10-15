import { RunPrompt } from "./RunPrompt";
import { ChangesView } from "./ChangesView";
import type { Run } from "../lib/types";
import { CurrentRun } from "./CurrentRun";
import { OpenInEditor } from "./OpenInEditor";
import { containDialogFocus } from "../lib/keyboard";
import { useState, useRef, useEffect } from "react";
import {
  GitBranch,
  FolderOpen,
  ArrowUp,
  Square,
  RotateCcw,
  Check,
  PanelBottom,
  X,
  Plus,
  ChevronRight,
  PanelRight,
  Maximize2,
  Minimize2,
} from "lucide-react";
import type { Detail, Repository, Diff, Message } from "../lib/types";
import { activeStatuses, stages } from "../lib/types";
import { rpc, errorMessage, duration } from "../lib/api";
import { Button } from "./ui/button";
import { Status } from "./Status";
import { ComposerSettings, followupConfiguration } from "./ComposerSettings";
import { TaskTerminal } from "./TaskTerminal";
import { ResizeHandle } from "./ResizeHandle";
import { usePaneSize } from "../lib/usePaneSize";
import { useTaskView, updateTaskView } from "../lib/taskView";
import { navigateTabs } from "../lib/keyboard";
import { AgentTimeline } from "./AgentTimeline";
import { AgentResponse } from "./AgentResponse";
import { PlanView } from "./PlanView";
import { LogView } from "./LogView";
import { TestsView } from "./TestsView";
import { UsageView } from "./UsageView";
import { RunError } from "./RunError";
import { TaskCleanup } from "./TaskCleanup";
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
  const tab = ["Chat", "Plan", "Usage"].includes(view.tab) ? view.tab : "Chat";
  const [paneWidth, setPaneWidth] = usePaneSize("contextWidth", 360, 240, 1000);
  const [dockHeight, setDockHeight] = usePaneSize("dockHeight", 260, 120, 500);
  const [promptOpen, setPromptOpen] = useState(false);
  const [draftRun, setDraftRun] = useState<Run>();
  const [busy, setBusy] = useState(false);
  const [addingContext, setAddingContext] = useState(false);
  const [contextText, setContextText] = useState("");
  const setSelectedRun = (id?: string) =>
    updateTaskView(t.id, { outputRun: id || "" });
  const [cleanup, setCleanup] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [reviewSeen, setReviewSeen] = useState("");
  const reviewKey = `${t.approval_gate}:${detail.artifacts.at(-1)?.created_at || t.updated_at}`;
  const [sent, setSent] = useState<Message[]>([]);
  const sending = useRef(false);
  const [diff, setDiff] = useState<Diff | null>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const promptDialog = useRef<HTMLElement>(null);
  const stick = useRef(true);
  const refreshDiff = useRef<(() => Promise<void>) | null>(null);
  const active = !!detail.executing || activeStatuses.includes(t.status);
  const occupied = !!detail.active;
  const watchChanges = active || occupied;
  useEffect(() => {
    if (!promptOpen) return;
    const previous = document.activeElement;
    promptDialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, [promptOpen]);
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
  const submit = async () => {
    if (!view.draft.trim() || busy || sending.current) return;
    const configuration = followupConfiguration(t, view);
    sending.current = true;
    setBusy(true);
    try {
      const result = await rpc<{ message: Message }>("task.followup", {
        id: t.id,
        content: view.draft,
        configuration,
      });
      setSent((messages) => [...messages, result.message]);
      updateTaskView(t.id, { draft: "" });
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
      sending.current = false;
    }
  };
  return (
    <div
      className={`workspace ${view.terminalDock && view.dockMaximized ? "dock-maximized" : ""}`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && view.dockMaximized) {
          updateTaskView(t.id, { dockMaximized: false });
        }
      }}
    >
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
          {active && (
            <Button
              size="sm"
              variant="ghost"
              aria-label="Stop agent"
              onClick={() => void action("task.cancel")}
            >
              <Square size={12} />
              Stop
            </Button>
          )}
          {!occupied && !active && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void action("task.archive", { id: t.id, archived: !t.archived })
              }
            >
              {t.archived ? "Unarchive" : "Archive"}
            </Button>
          )}
          {[
            "completed",
            "cancelled",
            "failed",
            "interrupted",
            "ready_for_review",
          ].includes(t.status) && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setCleanup(true)}
            >
              Delete task data
            </Button>
          )}
          <OpenInEditor
            id={t.id}
            kind="task"
            path={t.worktree_path}
            disabled={!t.worktree_path}
          />
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
          {active || t.status === "queued" ? null : t.status ===
            "ready_for_review" ? (
            <Button
              size="sm"
              disabled={occupied || busy}
              onClick={() => setFinalizing(true)}
            >
              <Check size={12} />
              Finalize…
            </Button>
          ) : !["completed", "awaiting_approval"].includes(t.status) ? (
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
      {t.status === "awaiting_approval" && t.approval_gate && (
        <section
          className="pipeline-approval"
          aria-label="Pipeline review required"
        >
          <div>
            <strong>
              {t.approval_gate === "antigravity_plan"
                ? "Antigravity plan is ready"
                : t.approval_gate === "codex_plan"
                  ? "Refined Codex plan is ready"
                  : t.approval_gate === "implementation"
                    ? "Implementation is ready to review"
                    : "Antigravity review & tests are ready"}
            </strong>
            <small>
              {t.approval_gate.endsWith("plan")
                ? "Review the saved plan or send feedback before continuing."
                : t.approval_gate === "implementation"
                  ? "Inspect the changes and tests, then authorize Antigravity's final review."
                  : "Inspect findings and tests not run before finalizing. Unresolved findings require changes."}
            </small>
          </div>
          <Button
            size="sm"
            onClick={() => {
              if (t.approval_gate?.endsWith("plan"))
                updateTaskView(t.id, { tab: "Plan" });
              else if (t.approval_gate === "implementation") dock("Tests");
              else dock("Final review");
            }}
          >
            View{" "}
            {t.approval_gate.endsWith("plan")
              ? "plan"
              : t.approval_gate === "implementation"
                ? "tests"
                : "review"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              updateTaskView(t.id, { tab: "Chat" });
            }}
          >
            Request changes
          </Button>
          <Button
            size="sm"
            variant="default"
            disabled={
              busy ||
              occupied ||
              (t.approval_gate === "final_review" &&
                JSON.parse(
                  [...detail.artifacts]
                    .reverse()
                    .find((a) => a.stage === 5 && a.kind === "plan")?.content ||
                    "{}",
                ).approval !== "approved")
            }
            onClick={() => void action("task.approve")}
          >
            {t.approval_gate === "antigravity_plan"
              ? "Approve → Codex refinement"
              : t.approval_gate === "codex_plan"
                ? "Approve → Implement"
                : t.approval_gate === "implementation"
                  ? "Approve → Antigravity review & tests"
                  : "Accept review"}
          </Button>
        </section>
      )}
      {t.status === "awaiting_approval" &&
        t.approval_gate &&
        reviewSeen !== reviewKey && (
          <div className="modal-backdrop">
            <section
              className="modal compact-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Stage review required"
            >
              <h2>
                {t.approval_gate === "antigravity_plan"
                  ? "Review Antigravity's plan"
                  : t.approval_gate === "codex_plan"
                    ? "Review Codex's refined plan"
                    : t.approval_gate === "implementation"
                      ? "Review the implementation"
                      : "Review Antigravity's final report"}
              </h2>
              <p>
                The pipeline is paused.{" "}
                {t.approval_gate.endsWith("plan")
                  ? "Read the saved plan, request changes if needed, then explicitly approve the next stage."
                  : "Review changes in VS Code and inspect the executed and skipped tests before approving."}{" "}
                No next agent starts until you approve.
              </p>
              {!t.approval_gate.endsWith("plan") && (
                <OpenInEditor
                  id={t.id}
                  kind="task"
                  path={t.worktree_path}
                  disabled={!t.worktree_path}
                />
              )}
              <div className="actions">
                <Button
                  variant="default"
                  onClick={() => {
                    setReviewSeen(reviewKey);
                    if (t.approval_gate?.endsWith("plan"))
                      updateTaskView(t.id, { tab: "Plan" });
                    else
                      dock(
                        t.approval_gate === "implementation"
                          ? "Tests"
                          : "Final review",
                      );
                  }}
                >
                  {t.approval_gate.endsWith("plan")
                    ? "Review plan"
                    : t.approval_gate === "implementation"
                      ? "Review implementation"
                      : "Review final report"}
                </Button>
                <Button onClick={() => setReviewSeen(reviewKey)}>Later</Button>
              </div>
            </section>
          </div>
        )}
      {promptOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPromptOpen(false);
          }}
        >
          <section
            ref={promptDialog}
            className="modal prompt-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Agent prompts"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setPromptOpen(false);
              }
              containDialogFocus(e);
            }}
          >
            <div className="modal-heading">
              <h2>Agent prompts</h2>
              <Button onClick={() => setPromptOpen(false)}>Close</Button>
            </div>
            {[...detail.runs].reverse().map((run) => (
              <RunPrompt key={run.id} run={run} />
            ))}
          </section>
        </div>
      )}
      {draftRun && (
        <div className="modal-backdrop">
          <section
            className="modal compact-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Use streamed plan"
          >
            <h2>Use streamed plan</h2>
            <p>
              {draftRun.status === "running"
                ? "This stops the current run. "
                : ""}
              The draft is checked against the plan schema and unchanged
              worktree. The original run keeps its actual outcome. You will
              review this plan before starting the next agent.
            </p>
            <div className="actions">
              <Button
                disabled={busy}
                onClick={async () => {
                  await action("task.acceptDraft", {
                    id: t.id,
                    run_id: draftRun.id,
                  });
                  setDraftRun(undefined);
                }}
              >
                Use draft
              </Button>
              <Button disabled={busy} onClick={() => setDraftRun(undefined)}>
                Cancel
              </Button>
            </div>
          </section>
        </div>
      )}
      {finalizing && (
        <div className="modal-backdrop">
          <section
            className="modal compact-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="finalize-task-title"
          >
            <h2 id="finalize-task-title">Finalize task</h2>
            <dl className="repository-facts">
              <dt>Source repository</dt>
              <dd>
                <code>{repository?.path}</code>
              </dd>
              <dt>Task worktree</dt>
              <dd>
                <code>{t.worktree_path}</code>
              </dd>
              <dt>Task branch</dt>
              <dd>
                <code>{t.branch_name}</code>
              </dd>
              <dt>Changed files</dt>
              <dd>{diff?.files.length ?? "Unavailable"}</dd>
            </dl>
            <p>
              Changes stay in the task worktree. Marking this task complete
              preserves its branch and worktree. It does not commit changes or
              switch the source checkout.
            </p>
            <div className="actions">
              <OpenInEditor
                id={t.id}
                kind="task"
                path={t.worktree_path}
                disabled={!t.worktree_path}
              />
              <Button
                onClick={() =>
                  void action("open.directory", { id: t.id, kind: "task" })
                }
              >
                Open worktree
              </Button>
              <Button
                variant="default"
                disabled={busy || occupied}
                onClick={async () => {
                  await action("task.complete");
                  setFinalizing(false);
                }}
              >
                Mark complete
              </Button>
              <Button variant="ghost" onClick={() => setFinalizing(false)}>
                Keep task in worktree
              </Button>
            </div>
          </section>
        </div>
      )}
      {cleanup && (
        <TaskCleanup
          id={t.id}
          close={() => setCleanup(false)}
          done={() => {
            setCleanup(false);
            back();
          }}
        />
      )}
      <div
        className="workspace-tabs"
        role="tablist"
        aria-label="Task views"
        onKeyDown={navigateTabs}
      >
        {["Chat", "Plan", "Usage"].map((tab) => (
          <button
            role="tab"
            aria-label={tab}
            aria-selected={view.tab === tab}
            className={view.tab === tab ? "selected" : ""}
            key={tab}
            onClick={() => updateTaskView(t.id, { tab })}
          >
            {tab}
          </button>
        ))}
        <div className="spacer" />
        {["Changes", "Tests", "Agent Output"].map((name) => (
          <Button
            key={name}
            size="sm"
            variant="ghost"
            onClick={() => dock(name)}
          >
            {name}
          </Button>
        ))}
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
          <PanelRight size={14} />
          Run details
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
      <CurrentRun
        detail={detail}
        prompt={() => setPromptOpen(true)}
        plan={() => updateTaskView(t.id, { tab: "Plan" })}
        output={() => {
          setSelectedRun();
          dock("Agent Output");
        }}
        usage={() => {
          setSelectedRun(
            [...detail.runs].reverse().find((r) => r.status === "running")?.id,
          );
          dock("Usage");
        }}
        stop={() => void action("task.cancel")}
      />
      <div className="workspace-content">
        {tab === "Chat" ? (
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
                messages={[
                  ...detail.messages,
                  ...sent.filter(
                    (m) => !detail.messages.some((row) => row.id === m.id),
                  ),
                ]}
                retryMessage={
                  !active && !occupied
                    ? (message) =>
                        void action("task.message.retry", {
                          id: t.id,
                          message_id: message.id,
                        })
                    : undefined
                }
                editMessage={(message) => {
                  updateTaskView(t.id, {
                    draft: message.content.split(
                      "\n\nLinked PR review context (untrusted):",
                    )[0],
                  });
                  timeline.current?.parentElement
                    ?.querySelector("textarea")
                    ?.focus();
                }}
                files={diff?.files}
                openDiff={(path) => {
                  updateTaskView(t.id, { diffPath: path });
                  dock("Changes");
                }}
              />
              {t.error &&
                !(
                  detail.runs.at(-1)?.error &&
                  errorMessage(t.error).endsWith(
                    errorMessage(detail.runs.at(-1)!.error),
                  )
                ) && (
                  <RunError
                    key={t.error}
                    error={t.error}
                    stage={t.stage}
                    logs={() => dock("Logs")}
                  />
                )}
              {!!diff?.files.length && (
                <details className="chat-changes" open>
                  <summary>
                    Changed {diff.files.length}{" "}
                    {diff.files.length === 1 ? "file" : "files"}
                  </summary>
                  {diff.files.map((file) => (
                    <div className="edited-file" key={file.path}>
                      <button
                        onClick={() => {
                          updateTaskView(t.id, { diffPath: file.path });
                          dock("Changes");
                        }}
                      >
                        <code>{file.path}</code>
                      </button>
                      <span className="spacer" />
                      <span className="success">+{file.insertions}</span>
                      <span className="failure">−{file.deletions}</span>
                    </div>
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
                <p className="ready-review">
                  <Check size={14} />
                  Ready for review
                  <span className="spacer" />
                  {diff?.files.length || 0}{" "}
                  {diff?.files.length === 1 ? "file" : "files"}
                  <ChevronRight size={14} />
                </p>
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
                      ? "Save an instruction; close the terminal to resume…"
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
                {active && (
                  <Button
                    type="button"
                    aria-label="Stop agent"
                    onClick={() => void action("task.cancel")}
                  >
                    <Square size={12} />
                  </Button>
                )}
                <Button
                  type="submit"
                  variant="default"
                  aria-label="Send follow-up"
                  disabled={busy || !view.draft.trim()}
                >
                  <ArrowUp size={15} />
                </Button>
              </div>
              {(active || occupied || t.stage < 3) && (
                <small className="composer-note">
                  {active
                    ? "Enter queues this instruction for the next stage."
                    : occupied
                      ? "Enter saves this instruction. Close the terminal, then Retry the saved message to run it."
                      : "Enter resumes planning with this instruction."}{" "}
                  Shift+Enter adds a newline.
                </small>
              )}
            </form>
          </div>
        ) : tab === "Usage" ? (
          <UsageView taskId={t.id} records={detail.usage} />
        ) : tab === "Plan" ? (
          <PlanView
            artifacts={detail.artifacts}
            runs={detail.runs}
            events={detail.events}
            busy={busy || (occupied && !active)}
            acceptDraft={setDraftRun}
          />
        ) : null}
        {view.contextPane === "pipeline" && (
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
                <strong>Run details</strong>
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
              <div className="run-details-scroll">
                {!!detail.runs.length && (
                  <button
                    className="workspace-prompt-link"
                    onClick={() => setPromptOpen(true)}
                  >
                    View sent prompts
                  </button>
                )}
                <details className="workspace-repository-context">
                  <summary>
                    Repository source · {repository?.path || "Unavailable"}
                  </summary>
                  <dl className="repository-facts">
                    <dt>Source</dt>
                    <dd>
                      <code>{repository?.path}</code> ·{" "}
                      {repository?.source === "imported"
                        ? "User-owned checkout"
                        : "Vibestar-managed clone"}
                    </dd>
                    <dt>Worktree</dt>
                    <dd>
                      <code>
                        {t.worktree_path || "Created when preparation starts"}
                      </code>
                    </dd>
                    <dt>Branch</dt>
                    <dd>
                      <code>
                        {t.branch_name || "Created during preparation"}
                      </code>
                    </dd>
                    <dt>Base</dt>
                    <dd>
                      {repository?.upstream_remote || "upstream"}/
                      {t.base_branch} <code>{t.base_commit_sha}</code>
                    </dd>
                  </dl>
                </details>
                <div className="stage-rail">
                  <h3>Pipeline</h3>
                  {stages.map((s, i) => {
                    const run = [...detail.runs]
                      .reverse()
                      .find(
                        (r) =>
                          r.stage === i &&
                          !["scheduled", "Code Review Ask AI"].includes(
                            r.purpose || "",
                          ),
                      );
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
                                : i === t.stage && active
                                  ? "running"
                                  : "subtle"
                            }
                          >
                            {i < t.stage
                              ? "✓"
                              : i === t.stage && active
                                ? "→"
                                : "○"}
                          </span>
                          <div>
                            {s}
                            {run && (
                              <small>
                                {run.model || "CLI default"} · {run.effort} ·{" "}
                                {run.status} ·{" "}
                                {duration(run.started_at, run.ended_at)}
                              </small>
                            )}
                          </div>
                        </button>
                        {i > 0 && i <= Math.min(t.stage, 5) && (
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
                    <p>
                      Source: <code>{repository?.path}</code>
                    </p>
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
              </div>
            </aside>
          </>
        )}
      </div>
      {view.terminalDock && (
        <>
          {!view.dockMaximized && (
            <ResizeHandle
              label="Resize utility dock"
              value={dockHeight}
              onChange={setDockHeight}
              min={120}
              max={500}
              vertical
              reverse
            />
          )}
          <div
            className="utility-dock"
            style={view.dockMaximized ? undefined : { height: dockHeight }}
          >
            <div
              className="dock-tabs"
              role="tablist"
              aria-label="Utilities"
              onKeyDown={navigateTabs}
            >
              {[
                "Changes",
                "Problems",
                "Tests",
                "Final review",
                "Terminal",
                "Agent Output",
                "Logs",
                "Usage",
              ].map((tab) => (
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
                aria-label={
                  view.dockMaximized
                    ? "Restore utility dock"
                    : "Maximize utility dock"
                }
                aria-pressed={view.dockMaximized}
                onClick={() =>
                  updateTaskView(t.id, { dockMaximized: !view.dockMaximized })
                }
              >
                {view.dockMaximized ? (
                  <Minimize2 size={13} />
                ) : (
                  <Maximize2 size={13} />
                )}
              </Button>
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
              {view.dockTab === "Changes" ? (
                <ChangesView
                  task={t}
                  diff={diff}
                  revision={revision}
                  onError={onError}
                />
              ) : view.dockTab === "Terminal" ? (
                <TaskTerminal task={t} onError={onError} />
              ) : view.dockTab === "Usage" ? (
                <UsageView
                  key={view.outputRun}
                  taskId={t.id}
                  records={detail.usage}
                  runId={view.outputRun}
                />
              ) : view.dockTab === "Final review" ? (
                <div className="final-review-panel">
                  <AgentResponse
                    expanded
                    text={
                      [...detail.artifacts]
                        .reverse()
                        .find((a) => a.stage === 5 && a.kind === "plan")
                        ?.content || "Antigravity final review has not run yet."
                    }
                  />
                  {detail.runs
                    .filter((r) => r.stage === 5)
                    .map((run) => (
                      <RunPrompt key={run.id} run={run} />
                    ))}
                </div>
              ) : view.dockTab === "Tests" ? (
                <TestsView detail={detail} onError={onError} />
              ) : view.dockTab === "Logs" || view.dockTab === "Agent Output" ? (
                <LogView
                  key={t.id}
                  taskId={t.id}
                  liveOutput={view.dockTab === "Agent Output"}
                  runs={detail.runs}
                  events={detail.events}
                  selectedRun={view.outputRun || undefined}
                />
              ) : (
                <div className="problems-panel">
                  {t.error ? (
                    <p className="failure">{errorMessage(t.error)}</p>
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
        <span>
          {["cancelled", "failed", "interrupted"].includes(t.status)
            ? t.status.replace(/^./, (letter) => letter.toUpperCase())
            : t.status === "awaiting_approval"
              ? "Awaiting your review"
              : stages[t.stage]}
        </span>
      </footer>
    </div>
  );
};
