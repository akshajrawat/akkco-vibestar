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
  getTaskView,
  updateTaskView,
  openWorkspaceTool,
  type SecondarySection,
} from "../../lib/taskView";
import { useWorkspaceKeys } from "../../hooks/useWorkspaceKeys";
import { AgentTimeline } from "../chat/AgentTimeline";
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
import { useOptimisticMessages } from "../chat/useOptimisticMessages";
import { eventData } from "../chat/output/events";
import { useConversationEvents } from "../chat/output/useConversationEvents";

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
  const conversationEvents = useConversationEvents(t.id, "task", detail.events, onError);
  const view = useTaskView(t.id);
  useWorkspaceKeys(t.id);
  const shell = useRef<HTMLDivElement>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [draftRun, setDraftRun] = useState<Run>();
  const [busy, setBusy] = useState(false);
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

  const {
    messages,
    upsert: showMessage,
    remove: removeMessage,
  } = useOptimisticMessages(t.id, detail.messages);

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

  const pending = messages.filter((message) => ["draft", "queued"].includes(message.status || ""));

  const latestQuestion = [...messages]
    .reverse()
    .find((message) => message.role === "user" && message.purpose === "chat");

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

  const submit = async (saveOnly = false, workflow = false) => {
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
    const question = !saveOnly && !workflow;
    const workspaceAccess = question && (t.stage >= 6 || t.approval_gate === "final_review");

    const signature = JSON.stringify({
      content,
      configuration,
      saveOnly,
      question,
      workspaceAccess,
    });

    const request_id =
      view.messageRequest?.signature === signature ? view.messageRequest.id : crypto.randomUUID();

    updateTaskView(t.id, { messageRequest: { id: request_id, signature } });
    const draftSnapshot = { draft: view.draft, draftContext: view.draftContext };
    const optimisticId = saved && !saveOnly && !question ? saved.id : request_id;
    if (!saveOnly) {
      showMessage({
        id: optimisticId,
        role: "user",
        content,
        created_at: new Date().toISOString(),
        status: question ? "chat_pending" : "pending",
        purpose: question ? "chat" : undefined,
      });

      updateTaskView(t.id, { draft: "", draftContext: [], chatFollow: true });
    }

    sending.current = true;
    setBusy(true);
    try {
      const result = await rpc<{ message?: Message; disposition: string }>(
        question ? "task.chat" : saved && !saveOnly ? "task.message.send" : "task.followup",
        question
          ? {
              id: t.id,
              content,
              configuration: {
                ...configuration,
                ...(workspaceAccess ? { access: "workspace" } : {}),
              },
              request_id,
            }
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

      if (result.message) {
        if (result.message.id !== optimisticId) removeMessage(optimisticId);
        showMessage(result.message);
      }

      if (saveOnly || result.disposition === "draft") {
        if (!saveOnly && !composerContent(getTaskView(t.id))) updateTaskView(t.id, draftSnapshot);
        if (result.message)
          updateTaskView(t.id, {
            savedInstruction: { id: result.message.id, content },
          });
        setNotice("Instruction saved for later · no agent started");
      } else {
        setNotice(
          question
            ? ""
            : saved && result.disposition === "delivered"
              ? "Instruction already delivered · no new agent started"
              : result.disposition === "queued"
                ? "Feedback queued for the next safe stage boundary"
                : "Feedback sent · continuation authorized",
        );

        // Preserve edits made while this request was in flight.
        updateTaskView(t.id, { messageRequest: null });
      }
    } catch (e) {
      if (!saveOnly) {
        removeMessage(optimisticId);
        if (!composerContent(getTaskView(t.id))) updateTaskView(t.id, draftSnapshot);
        else
          showMessage({
            id: optimisticId,
            role: "user",
            content,
            created_at: new Date().toISOString(),
            status: question ? "chat_failed" : "failed",
            purpose: question ? "chat" : undefined,
          });
      }

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
              setNotice("Write your feedback, then choose Send to workflow.");

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
          {!t.final_review_verdict
            ? "Changes updated after review. Ask for a fresh review when ready."
            : t.final_review_verdict === "changes_requested"
              ? "Review found problems. Use the chat to request a fix when ready."
              : "Review finished with verification gaps. See the review for next steps."}
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
          empty={!messages.length && !detail.runs.length && !active}
          revision={revision + ":" + detail.events.length + ":" + detail.runs.length}
          activity={
            <CurrentRun
              detail={{ ...detail, events: conversationEvents }}
              output={currentRun}
              stop={() => void action("task.cancel")}
            />
          }
          conversation={
            <>
              {!messages.length && !detail.runs.length && !active && (
                <div className="chat-welcome">
                  <h1>Let’s start building.</h1>
                </div>
              )}

              {detail.activity
                ?.filter((row) => row.kind === "chat_error")
                .slice(-1)
                .map((row) => {
                  const data = eventData(row.data);
                  if (
                    data.message_id !== latestQuestion?.id ||
                    latestQuestion?.status === "chat_completed" ||
                    (latestQuestion?.run_id &&
                      detail.runs.some((run) => run.id === latestQuestion.run_id && run.error))
                  )
                    return null;
                  return (
                    <RunError
                      key={row.id}
                      error={String(data.error || "Conversation could not finish")}
                      logs={() => inspect("Logs")}
                    />
                  );
                })}

              <AgentTimeline
                compact
                showPrompts
                expandResults={false}
                events={conversationEvents}
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
            </>
          }
          composer={
            <Composer
              id={t.id}
              label="Task conversation"
              placeholder={active ? "Write a message…" : "Message Vibestar…"}
              sendLabel="Send message"
              busy={busy}
              disabled={t.status === "preserved" || occupied}
              onSend={() => void submit()}
              stop={
                active || detail.runs.some((run) => run.status === "running")
                  ? () => void action("task.cancel")
                  : undefined
              }
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
              workflow={
                t.status !== "not_started"
                  ? {
                      run: () => void submit(false, true),
                      disabled: t.status === "preserved" || (occupied && !active),
                    }
                  : undefined
              }
              model={<ComposerSettings task={t} />}
              notice={notice}
              onEdit={() => setNotice("")}
              hint={
                t.status === "preserved"
                  ? "History removed. Files and branch remain available in your editor."
                  : occupied
                    ? "Wait for the current operation to finish."
                    : active
                      ? `Send to workflow queues feedback for ${feedbackStage} at the next safe boundary.`
                      : t.stage >= 6 || t.approval_gate === "final_review"
                        ? "Ask a question or request a fix with the selected model."
                        : "Message the agent, or use the workflow controls to make changes."
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
