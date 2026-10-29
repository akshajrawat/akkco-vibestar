import { RunPrompt } from "../chat/RunPrompt";
import { ChangesView } from "../../components/shared/ChangesView";
import { CurrentRun } from "../chat/CurrentRun";
import { OpenInEditor } from "../../components/shared/OpenInEditor";
import { containDialogFocus } from "../../lib/keyboard";
import { useState, useRef, useEffect } from "react";
import { GitBranch, Square, PanelBottom, ChevronRight, PanelRight } from "lucide-react";
import type { Detail, Repository, Diff, Message, Run } from "../../lib/types";
import { activeStatuses } from "../../lib/types";
import { rpc, errorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Select } from "../../components/ui/Select";
import { ComposerSettings, followupConfiguration } from "../chat/ComposerSettings";
import { TaskTerminal } from "../../components/shared/TaskTerminal";
import {
  useTaskView,
  updateTaskView,
  openWorkspaceTool,
  type SecondarySection,
} from "../../lib/taskView";
import { useWorkspaceKeys } from "../../hooks/useWorkspaceKeys";
import { AgentTimeline } from "../chat/AgentTimeline";
import { AgentResponse } from "../chat/AgentResponse";
import { PlanView } from "../workflow/PlanView";
import { LogView } from "../chat/LogView";
import { TestsView } from "../verification/TestsView";
import { UsageView } from "../usage/UsageView";
import { RunError } from "../chat/RunError";
import { detailVerification } from "../../lib/verification";
import { Composer, composerContent } from "../chat/Composer";
import { workspaceContext } from "../workflow/context";
import { ActionTray } from "../workflow/ActionTray";
import { ChatSurface } from "../chat/ChatSurface";
import { SecondaryWorkspace } from "../workflow/SecondaryWorkspace";
import { BottomDock } from "../workflow/BottomDock";
import { PipelineView, RunDetailsView } from "../workflow/TaskEngineering";
import { FinalReviewSummary } from "../verification/FinalReviewSummary";

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
  onError: (message: string) => void;
  back: () => void;
}) => {
  const t = detail.task;
  const view = useTaskView(t.id);
  useWorkspaceKeys(t.id);
  const shell = useRef<HTMLDivElement>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [draftRun, setDraftRun] = useState<Run>();
  const [busy, setBusy] = useState(false);
  const [conversationMode, setConversationMode] = useState<"chat" | "changes">("chat");
  const noticeContext = `${t.id}:${t.stage}:${t.status}:${t.approval_gate}:${detail.runs.at(-1)?.id}:${detail.artifacts.at(-1)?.id}`;

  const [statusNotice, setStatusNotice] = useState<{
    message: string;
    context: string;
  }>();

  const notice = statusNotice?.context === noticeContext ? statusNotice.message : "";
  const setNotice = (message: string) => setStatusNotice({ message, context: noticeContext });

  const [instructionChoice, setInstructionChoice] = useState<{
    ids: string;
    disposition: "keep_saved" | "include_next_stage";
  }>();

  const [sent, setSent] = useState<Message[]>([]);
  const sending = useRef(false);
  const acting = useRef(false);
  const [diff, setDiff] = useState<Diff | null>(null);
  const promptDialog = useRef<HTMLElement>(null);
  const refreshDiff = useRef<(() => Promise<void>) | null>(null);
  const active = !!detail.executing || activeStatuses.includes(t.status);
  const occupied = !!detail.active;
  const watchChanges = active || occupied;

  const feedbackStage =
    t.stage <= 1 ? "planning" : t.stage === 2 ? "plan refinement" : "implementation";

  const verification = detailVerification(detail);

  const approvalGate =
    t.approval_gate ||
    (t.stage === 4 &&
    !active &&
    ["verification_blocked", "failed", "interrupted", "cancelled"].includes(t.status)
      ? "implementation"
      : undefined);

  const messages = [
    ...detail.messages,
    ...sent.filter((message) => !detail.messages.some((row) => row.id === message.id)),
  ];

  const pending = messages.filter((message) => ["draft", "queued"].includes(message.status || ""));
  const pendingIds = pending.map((message) => message.id);

  const approvalArtifact = [...detail.artifacts]
    .reverse()
    .find(
      (artifact) =>
        artifact.kind === "plan" &&
        artifact.stage ===
          (approvalGate === "antigravity_plan"
            ? 1
            : approvalGate === "codex_plan"
              ? 2
              : approvalGate === "implementation"
                ? 3
                : 5),
    );

  const pendingKey = `${approvalGate}:${approvalArtifact?.id}:${pendingIds.join(",")}`;
  const approvalNotice = approvalGate ? `${approvalGate}:${approvalArtifact?.id || ""}` : null;

  useEffect(() => {
    if (approvalNotice && view.shownApproval !== approvalNotice)
      updateTaskView(t.id, { secondaryOpen: true, shownApproval: approvalNotice });
  }, [approvalNotice, view.shownApproval, t.id]);

  const chosenInstructions =
    instructionChoice?.ids === pendingKey ? instructionChoice.disposition : "";

  const currentDraft = useRef(view);

  useEffect(() => {
    currentDraft.current = view;
  }, [view]);

  const content = composerContent(view);

  const saved =
    (view.savedInstruction?.content === content
      ? messages.find((message) => message.id === view.savedInstruction?.id)
      : undefined) ||
    pending.find((message) => message.status === "draft" && message.content === content);

  const inspect = (name: string) => {
    const sections: Record<string, SecondarySection> = {
      Plan: "plans",
      Tests: "tests",
      Changes: "changes",
      Usage: "usage",
      Logs: "logs",
      "Agent Output": "logs",
      "Final review": "final-review",
    };

    openWorkspaceTool(t.id, sections[name] || "pipeline");
  };

  const dock = (dockTab: "Terminal" | "Problems") =>
    updateTaskView(t.id, { terminalDock: true, dockTab });

  const currentRun = () => {
    updateTaskView(t.id, {
      outputRun:
        [...detail.runs].reverse().find((run) => run.status === "running")?.id ||
        detail.runs.at(-1)?.id ||
        "",
    });

    openWorkspaceTool(t.id, "run-details");
  };

  useEffect(() => {
    if (!promptOpen) return;
    const previous = document.activeElement;
    promptDialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [promptOpen]);

  useEffect(() => {
    if (!t.worktree_path) return;
    let alive = true;
    let fetching = false;

    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const value = await rpc<Diff>("task.diff", { id: t.id });
        if (alive) setDiff(value);
      } catch (e) {
        if (alive) onError(errorMessage(e));
      } finally {
        fetching = false;
      }
    };

    refreshDiff.current = refresh;
    void refresh();
    const timer = watchChanges ? setInterval(() => void refresh(), 2000) : undefined;
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
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    try {
      await rpc(method, params);
      return true;
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      acting.current = false;
      setBusy(false);
    }
  };

  const submit = async (saveOnly = false) => {
    if (!content || content.length > 32000 || busy || sending.current) return;
    if (saveOnly && saved) {
      setNotice(
        saved.status === "delivered"
          ? "Instruction already delivered"
          : "Instruction saved for later · no agent started",
      );

      return;
    }

    const configuration = followupConfiguration(t, view);
    const question = !saveOnly && conversationMode === "chat";

    const signature = JSON.stringify({
      content,
      configuration,
      saveOnly,
      question,
    });

    const request_id =
      view.messageRequest?.signature === signature ? view.messageRequest.id : crypto.randomUUID();

    updateTaskView(t.id, { messageRequest: { id: request_id, signature } });
    sending.current = true;
    setBusy(true);
    try {
      const result = await rpc<{ message?: Message; disposition: string }>(
        question ? "task.chat" : saved && !saveOnly ? "task.message.send" : "task.followup",
        question
          ? { id: t.id, content, configuration, request_id }
          : saved && !saveOnly
            ? {
                id: t.id,
                message_id: saved.id,
                configuration,
              }
            : {
                id: t.id,
                content,
                configuration,
                save_only: saveOnly,
                request_id,
              },
      );

      if (result.message)
        setSent((messages) => [
          ...messages.filter((message) => message.id !== result.message!.id),
          result.message!,
        ]);
      if (saveOnly || result.disposition === "draft") {
        if (result.message)
          updateTaskView(t.id, {
            savedInstruction: { id: result.message.id, content },
          });
        setNotice("Instruction saved for later · no agent started");
      } else {
        setNotice(
          question
            ? "Read-only question sent"
            : saved && result.disposition === "delivered"
              ? "Instruction already delivered · no new agent started"
              : result.disposition === "queued"
                ? "Feedback queued for the next safe stage boundary"
                : "Feedback sent · continuation authorized",
        );

        // Preserve edits made while this request was in flight.
        if (composerContent(currentDraft.current) === content)
          updateTaskView(t.id, {
            draft: "",
            draftContext: [],
            messageRequest: null,
          });
      }
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
      sending.current = false;
    }
  };

  const workflowActions = (
    <>
      {approvalGate && (
        <ActionTray
          label="Pipeline review required"
          title={
            approvalGate === "antigravity_plan"
              ? "Plan is ready"
              : approvalGate === "codex_plan"
                ? "Refined plan is ready"
                : approvalGate === "implementation"
                  ? "Implementation is ready to review"
                  : "Review is ready"
          }
          detail={
            approvalGate.endsWith("plan")
              ? "Review the saved plan or send feedback before continuing."
              : approvalGate === "implementation"
                ? "Inspect changes and tests, then authorize the independent final review."
                : "Inspect findings and tests not run. Final acceptance starts no agent."
          }
        >
          <Button
            size="sm"
            onClick={() => {
              if (approvalGate?.endsWith("plan")) {
                updateTaskView(t.id, {
                  planStage: approvalGate === "codex_plan" ? 2 : 1,
                });

                openWorkspaceTool(t.id, "plans");
              } else if (approvalGate === "implementation") inspect("Tests");
              else inspect("Final review");
            }}
          >
            View{" "}
            {approvalGate.endsWith("plan")
              ? "plan"
              : approvalGate === "implementation"
                ? "tests"
                : "review"}
          </Button>

          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setConversationMode("changes");

              updateTaskView(t.id, {
                expandedTool: false,
                secondaryOpen: !shell.current?.querySelector(".secondary-drawer"),
              });

              requestAnimationFrame(() => shell.current?.querySelector("textarea")?.focus());
            }}
          >
            Request changes
          </Button>

          <Button
            size="sm"
            variant="default"
            disabled={
              busy ||
              (pending.length > 0 && !chosenInstructions) ||
              occupied ||
              (approvalGate === "final_review" &&
                (verification.outcome === "failed" ||
                  t.final_review_verdict === "changes_requested" ||
                  JSON.parse(
                    [...detail.artifacts].reverse().find((a) => a.stage === 5 && a.kind === "plan")
                      ?.content || "{}",
                  ).approval !== "approved"))
            }
            onClick={() =>
              void action("task.approve", {
                id: t.id,
                ...(approvalArtifact ? { artifact_id: approvalArtifact.id } : {}),
                ...(pending.length
                  ? {
                      instructions: {
                        disposition: chosenInstructions,
                        message_ids: pendingIds,
                      },
                    }
                  : {}),
              }).then((success) => {
                if (success)
                  setNotice(
                    approvalGate === "final_review"
                      ? "Review accepted · no agent started"
                      : "Approved · next pipeline stage authorized",
                  );
              })
            }
          >
            {approvalGate === "antigravity_plan"
              ? "Approve → Plan refinement"
              : approvalGate === "codex_plan"
                ? "Approve → Implement"
                : approvalGate === "implementation"
                  ? "Approve → Review"
                  : "Accept review"}
          </Button>

          {pending.length > 0 && (
            <div className="instruction-choice">
              <details>
                <summary>
                  {pending.length} saved pending{" "}
                  {pending.length === 1 ? "instruction" : "instructions"}
                </summary>

                {pending.map((message) => (
                  <pre key={message.id}>{message.content}</pre>
                ))}
              </details>

              <label>
                Saved instructions on approval
                <Select
                  label="Saved instructions on approval"
                  value={chosenInstructions}
                  onChange={(value) =>
                    setInstructionChoice({
                      ids: pendingKey,
                      disposition: value as "keep_saved" | "include_next_stage",
                    })
                  }
                  options={[
                    { value: "", label: "Choose explicitly…" },
                    { value: "keep_saved", label: "Keep saved · approve current artifact" },
                    ...(approvalGate !== "final_review"
                      ? [
                          {
                            value: "include_next_stage",
                            label: "Include in the next pipeline stage",
                          },
                        ]
                      : []),
                  ]}
                />
              </label>

              <small>
                Your unsent composer draft stays independent. Including saved instructions keeps the
                next stage's configured provider and model.
              </small>
            </div>
          )}
        </ActionTray>
      )}

      {t.status === "reviewed_with_gaps" && (
        <p className="warning">
          Code review accepted · changes kept locally.{" "}
          {verification.canReview
            ? "Recheck evidence to request final verification review."
            : "Complete the required verification checks."}
        </p>
      )}

      {["ready_for_review", "completed"].includes(t.status) && (
        <Button size="sm" onClick={() => dock("Terminal")}>
          Open terminal
        </Button>
      )}
    </>
  );

  return (
    <div
      ref={shell}
      className={`workspace chat-workspace ${view.terminalDock && view.dockMaximized ? "dock-maximized" : ""}`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && view.dockMaximized)
          updateTaskView(t.id, { dockMaximized: false });
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

          <strong className="task-title" title={t.issue?.title}>
            {t.claimed_scope || t.issue?.title || "Entire issue"}
          </strong>
          <span className="spacer" />
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
          <OpenInEditor id={t.id} kind="task" path={t.worktree_path} disabled={!t.worktree_path} />
          <Button
            className="secondary-toggle"
            variant="ghost"
            size="icon"
            aria-label="Toggle secondary workspace"
            aria-expanded={view.secondaryOpen}
            onClick={() =>
              updateTaskView(t.id, {
                secondaryOpen: !view.secondaryOpen,
                expandedTool: false,
              })
            }
          >
            <PanelRight size={15} />
          </Button>
        </div>
      </header>

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
              {draftRun.status === "running" ? "This stops the current run. " : ""}
              The draft is checked against the plan schema and unchanged worktree. The original run
              keeps its actual outcome. You will review this plan before starting the next agent.
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

      <div className="workspace-content">
        <ChatSurface
          id={t.id}
          revision={revision + ":" + detail.events.length + ":" + detail.runs.length}
          activity={
            <CurrentRun
              detail={detail}
              output={currentRun}
              stop={() => void action("task.cancel")}
            />
          }
          conversation={
            <>
              <article className="context-message">
                <small>
                  You · {t.scope_mode === "whole_issue" ? "Entire issue" : "Specific scope"}
                </small>
                <h2>{t.issue?.title || `Issue #${t.issue_number}`}</h2>
                <p>
                  {t.scope_mode === "whole_issue"
                    ? "All issue requirements are in scope."
                    : t.claimed_scope}
                </p>
                {t.notes && <p>{t.notes}</p>}
                <details>
                  <summary>Issue context</summary>
                  <AgentResponse text={t.issue?.body || "No description"} />
                </details>
              </article>

              {(t.worktree_path || active) && (
                <section className="preparation-turn">
                  <strong>
                    {t.status === "not_started"
                      ? "Read-only chat workspace"
                      : "Repository preparation"}
                  </strong>

                  {detail.activity
                    ?.filter((row) => ["preparation", "chat_preparation"].includes(row.kind))
                    .map((row) => {
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
                            <span className={data.code === 0 ? "success" : "failure"}>
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
                    <p className="subtle">Fetching upstream and creating an isolated worktree…</p>
                  )}
                </section>
              )}

              {detail.activity
                ?.filter((row) => row.kind === "chat_error")
                .slice(-1)
                .map((row) => (
                  <RunError
                    key={row.id}
                    error={JSON.parse(row.data).error}
                    logs={() => inspect("Logs")}
                  />
                ))}

              <AgentTimeline
                expandResults={false}
                events={detail.events}
                runs={detail.runs}
                messages={messages}
                retryMessage={
                  !active && !occupied
                    ? (message) => {
                        const signature = JSON.stringify({ retry: message.id });

                        const request_id =
                          view.messageRequest?.signature === signature
                            ? view.messageRequest.id
                            : crypto.randomUUID();

                        updateTaskView(t.id, {
                          messageRequest: { id: request_id, signature },
                        });

                        void action("task.message.retry", {
                          id: t.id,
                          message_id: message.id,
                          request_id,
                        }).then((success) => {
                          if (success) updateTaskView(t.id, { messageRequest: null });
                        });
                      }
                    : undefined
                }
                editMessage={(message) => {
                  updateTaskView(t.id, {
                    draft: message.content.split("\n\nLinked PR review context (untrusted):")[0],
                  });

                  shell.current?.querySelector("textarea")?.focus();
                }}
                files={diff?.files}
                openDiff={(path) => {
                  updateTaskView(t.id, { diffPath: path });
                  inspect("Changes");
                }}
              />

              {t.error &&
                (t.stage !== 4 || detail.tests.length === 0) &&
                !(
                  detail.runs.at(-1)?.error &&
                  errorMessage(t.error).endsWith(errorMessage(detail.runs.at(-1)!.error))
                ) && (
                  <RunError
                    key={t.error}
                    error={t.error}
                    stage={t.stage}
                    blocked={
                      verification.outcome === "blocked" || verification.outcome === "unknown"
                    }
                    logs={() => inspect("Logs")}
                  />
                )}

              {!!diff?.files.length && (
                <details className="chat-changes" open>
                  <summary>
                    Changed {diff.files.length} {diff.files.length === 1 ? "file" : "files"}
                  </summary>

                  {diff.files.map((file) => (
                    <div className="edited-file" key={file.path}>
                      <button
                        onClick={() => {
                          updateTaskView(t.id, { diffPath: file.path });
                          inspect("Changes");
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
            </>
          }
          composer={
            <Composer
              id={t.id}
              label="Task conversation"
              placeholder={active ? "Write while the agent works…" : "Ask Vibestar…"}
              sendLabel={conversationMode === "chat" ? "Ask question" : "Send follow-up"}
              busy={busy}
              disabled={
                t.status === "preserved" || (occupied && (conversationMode === "chat" || !active))
              }
              onSend={() => void submit()}
              save={{
                label:
                  saved?.status === "delivered"
                    ? "Instruction delivered"
                    : saved
                      ? "Instruction saved"
                      : "Save for later",
                run: () => void submit(true),
                disabled: !!saved || t.status === "preserved",
              }}
              model={
                <>
                  <label className="conversation-mode">
                    <span className="sr-only">Message action</span>
                    <Select
                      label="Message action"
                      value={conversationMode}
                      onChange={(value) => setConversationMode(value as "chat" | "changes")}
                      options={[
                        {
                          value: "chat",
                          label: "Ask",
                          description: "Discuss your task without changing files",
                        },
                        {
                          value: "changes",
                          label: "Work",
                          description:
                            t.status === "not_started"
                              ? "Start the workflow to enable work"
                              : "Send feedback or request changes",
                          disabled: t.status === "not_started",
                        },
                      ]}
                    />
                  </label>
                  <ComposerSettings task={t} />
                </>
              }
              notice={notice}
              onEdit={() => setNotice("")}
              hint={
                t.status === "preserved"
                  ? "History removed. Files and branch remain available in your editor."
                  : conversationMode === "chat"
                    ? occupied
                      ? "Wait for the current operation to finish."
                      : "Ask about your task. Start workflow when you’re ready to make changes."
                    : active
                      ? `Send queues feedback for ${feedbackStage} at the next safe boundary. Save for later starts no agent.`
                      : occupied
                        ? "Close the terminal before sending feedback. Save for later starts no agent."
                        : t.approval_gate?.endsWith("plan")
                          ? "Send feedback reruns the current planning stage. Save for later keeps the approval gate."
                          : "Send starts an implementation follow-up. Save for later starts no agent."
              }
              context={workspaceContext({
                id: t.id,
                owner: "task",
                files: diff?.files || [],
                selected: view.diffPath,
                plan: [...detail.artifacts]
                  .reverse()
                  .find((artifact) => artifact.kind === "plan" && [1, 2].includes(artifact.stage))
                  ?.content,
                failures: verification.checks
                  .filter((check) => check.outcome !== "passed")
                  .map((check) => JSON.stringify(check))
                  .join("\n"),
              })}
            />
          }
        />

        <SecondaryWorkspace id={t.id} actions={workflowActions}>
          {view.secondarySection === "pipeline" ? (
            <PipelineView
              detail={detail}
              busy={busy}
              action={action}
              terminal={() => dock("Terminal")}
              onError={onError}
            />
          ) : view.secondarySection === "plans" ? (
            <PlanView
              compact={!view.expandedTool}
              selectedStage={view.planStage}
              selectStage={(planStage) => updateTaskView(t.id, { planStage })}
              artifacts={detail.artifacts}
              runs={detail.runs}
              events={detail.events}
              busy={busy || (occupied && !active)}
              acceptDraft={setDraftRun}
            />
          ) : view.secondarySection === "changes" ? (
            <>
              <ChangesView
                task={t}
                diff={diff}
                revision={revision}
                onError={onError}
                compact={!view.expandedTool}
              />
            </>
          ) : view.secondarySection === "tests" ? (
            <TestsView detail={detail} onError={onError} terminal={() => dock("Terminal")} />
          ) : view.secondarySection === "usage" ? (
            <UsageView taskId={t.id} records={detail.usage} />
          ) : view.secondarySection === "logs" ? (
            <LogView
              taskId={t.id}
              runs={detail.runs}
              events={detail.events}
              selectedRun={view.outputRun || undefined}
            />
          ) : view.secondarySection === "run-details" ? (
            <RunDetailsView
              detail={detail}
              repository={repository}
              prompts={() => setPromptOpen(true)}
            />
          ) : (
            <div className="final-review-panel">
              <FinalReviewSummary
                detail={detail}
                changes={() => inspect("Changes")}
                tests={() => inspect("Tests")}
              />

              {detail.runs
                .filter((run) => run.stage === 5)
                .map((run) => (
                  <RunPrompt key={run.id} run={run} />
                ))}
            </div>
          )}
        </SecondaryWorkspace>
      </div>

      <BottomDock
        id={t.id}
        terminal={(active, focusRequest) => (
          <TaskTerminal task={t} onError={onError} active={active} focusRequest={focusRequest} />
        )}
        problems={
          <div className="problems-panel">
            {t.error ? (
              <>
                <p className="warning">{errorMessage(t.error)}</p>
                <Button size="sm" onClick={() => inspect(t.stage === 4 ? "Tests" : "Logs")}>
                  Inspect evidence
                </Button>
              </>
            ) : (
              <p className="subtle">No task problems</p>
            )}
          </div>
        }
      />

      <footer className="workspace-status">
        <GitBranch size={11} />
        <span>{t.branch_name || "Preparing worktree"}</span>
        <span className="spacer" />
        <Button
          size="sm"
          variant="ghost"
          aria-label="Toggle utility dock"
          onClick={() => updateTaskView(t.id, { terminalDock: !view.terminalDock })}
        >
          <PanelBottom size={13} />
          Terminal
        </Button>

        <Button size="sm" variant="ghost" onClick={() => dock("Problems")}>
          Problems
        </Button>
        <span>base {t.base_commit_sha.slice(0, 8) || "pending"}</span>
      </footer>
    </div>
  );
};
