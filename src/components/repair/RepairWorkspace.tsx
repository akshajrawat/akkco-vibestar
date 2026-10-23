import { RepairActions, RepairIdentity } from "./RepairContext";
import { Composer, composerContent } from "../workspace/Composer";
import { workspaceContext } from "../workspace/context";
import { ActionTray } from "../workspace/ActionTray";
import { ChatSurface } from "../workspace/ChatSurface";
import { SecondaryWorkspace } from "../workspace/SecondaryWorkspace";
import { BottomDock } from "../workspace/BottomDock";
import { RunPrompt } from "../RunPrompt";
import { useWorkspaceKeys } from "../../lib/useWorkspaceKeys";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, PanelRight, Square, PanelBottom } from "lucide-react";
import { rpc, errorMessage, parseArgv } from "../../lib/api";
import {
  useTaskView,
  updateTaskView,
  openWorkspaceTool,
  type SecondarySection,
} from "../../lib/taskView";
import { containDialogFocus } from "../../lib/keyboard";
import { useDialogFocus } from "../../lib/useDialogFocus";
import type { Diff } from "../../lib/types";
import { Button } from "../ui/button";
import { Status } from "../Status";
import { CurrentRun } from "../CurrentRun";
import { AgentTimeline } from "../AgentTimeline";
import { AgentResponse } from "../AgentResponse";
import { LogView } from "../LogView";
import { ChangesView } from "../ChangesView";
import { UsageView } from "../UsageView";
import { CommandRuns } from "../CommandRuns";
import { TaskTerminal } from "../TaskTerminal";
import { OpenInEditor } from "../OpenInEditor";
import { PublicationDialog } from "./PublicationDialog";
import { LocalCommitDialog } from "./LocalCommitDialog";
import type { RepairDetail, RepairPublication } from "./types";

const layers = {
  original: "Original PR changes",
  upstream: "Upstream integration",
  repair: "Review repair changes",
} as const;

export const RepairWorkspace = ({
  id,
  revision,
  back,
  refresh,
  analyze,
}: {
  id: string;
  revision: number;
  back: () => void;
  refresh: () => Promise<void>;
  analyze: (jobId: string) => void;
}) => {
  const [detail, setDetail] = useState<RepairDetail>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const noticeContext = `${id}:${detail?.session.status}:${detail?.runs.at(-1)?.id}`;
  const [statusNotice, setStatusNotice] = useState<{
    message: string;
    context: string;
  }>();
  const notice =
    statusNotice?.context === noticeContext ? statusNotice.message : "";
  const setNotice = (message: string) =>
    setStatusNotice({ message, context: noticeContext });
  const [publication, setPublication] = useState<RepairPublication>();
  const [localCommit, setLocalCommit] = useState(false);
  const [diffSnapshot, setDiffSnapshot] = useState<{
    layer: keyof typeof layers;
    value: Diff;
  }>();
  const [argv, setArgv] = useState('["git", "diff", "--check"]');
  const [reviews, setReviews] = useState<
    { path: string; hash: string; reviewed: boolean }[]
  >([]);
  const [cleanup, setCleanup] = useState(false);
  const cleanupDialog = useDialogFocus(cleanup);
  const view = useTaskView(id);
  const layer = view.diffLayer;
  const diff = diffSnapshot?.layer === layer ? diffSnapshot.value : null;
  const currentDraft = useRef(view);
  useEffect(() => {
    currentDraft.current = view;
  }, [view]);
  useWorkspaceKeys(id);
  const acting = useRef(false);
  const onError = useCallback((text: string) => setError(text), []);
  const reload = useCallback(async () => {
    setDetail(await rpc<RepairDetail>("repair.detail", { id }));
  }, [id]);
  useEffect(() => {
    let alive = true;
    void rpc<RepairDetail>("repair.detail", { id })
      .then((value) => {
        if (alive) setDetail(value);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [id, revision]);
  const prepared = detail?.session.workspace.preparation === "ready";
  useEffect(() => {
    let alive = true;
    if (prepared)
      void rpc<typeof reviews>("repair.reviewFiles", { id })
        .then((rows) => {
          if (alive) setReviews(rows);
        })
        .catch((e) => {
          if (alive) setError(errorMessage(e));
        });
    return () => {
      alive = false;
    };
  }, [id, revision, prepared]);
  useEffect(() => {
    let alive = true;
    setDiffSnapshot(undefined);
    if (prepared)
      void rpc<Diff>("repair.diff", { id, layer })
        .then((value) => {
          if (alive) setDiffSnapshot({ layer, value });
        })
        .catch((e) => {
          if (alive) setError(errorMessage(e));
        });
    return () => {
      alive = false;
    };
  }, [id, revision, prepared, layer]);
  const act = async <T,>(
    method: string,
    params: Record<string, unknown> = {},
  ) => {
    if (acting.current) return undefined;
    acting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await rpc<T>(method, { id, ...params });
      if (!(method === "repair.cleanup" && params.history === true))
        await reload();
      await refresh();
      return result;
    } catch (e) {
      setError(errorMessage(e));
      return undefined;
    } finally {
      acting.current = false;
      setBusy(false);
    }
  };

  const inspect = (name: string) => {
    const sections: Record<string, SecondarySection> = {
      Changes: "changes",
      Tests: "tests",
      "Agent Output": "logs",
      Logs: "logs",
      Usage: "usage",
    };
    openWorkspaceTool(id, sections[name] || "pipeline");
  };
  if (!detail)
    return (
      <p className="empty-row">{error || "Opening PR repair workspace…"}</p>
    );
  const session = detail.session;
  const workspace = session.workspace;
  const awaiting = ["awaiting_manual_review", "verification_blocked"].includes(
    session.status,
  );
  const canApprove =
    awaiting &&
    session.implementation?.items.every((item) =>
      ["implemented", "clarified"].includes(item.status),
    ) &&
    session.verification?.overall === "approved" &&
    session.verification.items.every((item) => item.status === "accepted");
  const reportedTests = [
    ...(session.implementation?.tests || []),
    ...(session.verification?.tests || []),
  ];
  const canFollowUp =
    !detail.active &&
    ![
      "published",
      "merge_conflict",
      "stale_remote_head",
      "ready_to_publish",
    ].includes(session.status);

  const run =
    detail.runs.find((run) => run.id === view.outputRun) || detail.runs.at(-1);
  return (
    <div
      className={`workspace chat-workspace repair-workspace ${view.terminalDock && view.dockMaximized ? "dock-maximized" : ""}`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && view.dockMaximized)
          updateTaskView(id, { dockMaximized: false });
      }}
    >
      <header className="workspace-header">
        <div className="workspace-heading">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Back to PR inbox"
            onClick={back}
          >
            <ChevronLeft size={14} />
          </Button>
          <span className="breadcrumb">{session.identity.upstream.name}</span>
          <strong className="task-title">
            PR #{session.identity.number} · Review repair
          </strong>
          <span className="spacer" />
          {detail.active && (
            <Button
              variant="ghost"
              size="sm"
              aria-label="Stop repair"
              disabled={busy}
              onClick={() =>
                void act(
                  detail.terminal_open
                    ? "repair.terminal.close"
                    : "repair.cancel",
                )
              }
            >
              <Square size={12} />
              Stop
            </Button>
          )}
          <OpenInEditor
            id={id}
            kind="repair"
            path={workspace.worktree_path}
            disabled={!workspace.branch_owned}
          />
          <Button
            className="secondary-toggle"
            variant="ghost"
            size="icon"
            aria-label="Toggle secondary workspace"
            aria-expanded={view.secondaryOpen}
            onClick={() =>
              updateTaskView(id, {
                secondaryOpen: !view.secondaryOpen,
                expandedTool: false,
              })
            }
          >
            <PanelRight size={15} />
          </Button>
        </div>
      </header>
      <div className="workspace-content">
        <ChatSurface
          id={id}
          revision={revision + ":" + detail.events.length}
          activity={
            <CurrentRun
              detail={{
                runs: detail.runs,
                events: detail.events,
                usage: detail.usage,
                status: session.status,
                updated_at: session.updated_at,
              }}
              output={() => {
                updateTaskView(id, {
                  outputRun:
                    detail.runs.find((run) => run.status === "running")?.id ||
                    detail.runs.at(-1)?.id ||
                    "",
                });
                openWorkspaceTool(id, "run-details");
              }}
              stop={() => void act("repair.cancel")}
            />
          }
          conversation={
            <>
              {(error || session.error) && (
                <div className="error-box" role="alert">
                  {error || session.error}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setError("")}
                  >
                    Dismiss
                  </Button>
                </div>
              )}
              <article className="repair-intro">
                <span className="eyebrow">EXISTING PULL REQUEST</span>
                <h2>{session.context.snapshot?.title}</h2>
                <AgentResponse
                  text={session.context.snapshot?.body || "No PR description"}
                />
                <details>
                  <summary>
                    Original issue context and full reviewer conversation
                  </summary>
                  {session.context.snapshot?.linkedIssues?.map(
                    (issue, index) => (
                      <AgentResponse
                        key={index}
                        text={`${String(issue.title || "Linked issue")}\n\n${String(issue.body || "")}`}
                      />
                    ),
                  )}
                  {session.context.snapshot?.discussion?.map((entry) => (
                    <article className="discussion-entry" key={entry.id}>
                      <header>
                        <strong>@{entry.author}</strong>
                        <small>
                          {entry.reviewState || entry.type} ·{" "}
                          {new Date(entry.createdAt).toLocaleString()}
                        </small>
                      </header>
                      <AgentResponse text={entry.body} />
                      <small>Source {entry.id}</small>
                    </article>
                  ))}
                </details>
              </article>
              {session.status === "merge_conflict" && (
                <article className="repair-gate warning">
                  <h2>Upstream merge needs your resolution</h2>
                  <p>
                    The isolated repair worktree and conflicted index are
                    preserved.
                  </p>
                  {workspace.conflict_paths.map((path) => (
                    <p key={path}>
                      <code>{path}</code>
                    </p>
                  ))}
                  <Button
                    disabled={busy || detail.active}
                    onClick={() =>
                      void act("repair.recoverConflict", { confirmed: true })
                    }
                  >
                    Recover resolved merge
                  </Button>
                </article>
              )}
              <AgentTimeline
                runs={detail.runs}
                events={detail.events}
                messages={detail.messages}
              />
              {session.status === "stale_remote_head" && (
                <article className="repair-gate warning">
                  <h2>Remote PR head changed</h2>
                  <p>
                    This repair and its history are preserved. Analyze the
                    current PR explicitly before preparing a new repair.
                  </p>
                  <Button onClick={() => analyze(session.job_id)}>
                    Analyze PR Again
                  </Button>
                </article>
              )}
              {session.status === "ready_to_publish" && (
                <article className="repair-gate">
                  <h2>Manually approved · publication pending</h2>
                  <Button
                    variant="secondary"
                    disabled={busy || detail.active}
                    onClick={() => setLocalCommit(true)}
                  >
                    Commit Locally
                  </Button>
                  <Button
                    disabled={busy || detail.active}
                    onClick={async () => {
                      const plan = await act<RepairPublication>(
                        "repair.preparePublication",
                      );
                      if (plan) setPublication(plan);
                    }}
                  >
                    Prepare Push
                  </Button>
                </article>
              )}
              {session.status === "published" && (
                <article className="repair-gate success">
                  <h2>Review repair pushed successfully</h2>
                  <p>
                    {session.identity.head.name}:{session.identity.head.branch}
                  </p>
                  <p>
                    Updated commit{" "}
                    <code>
                      {
                        detail.publications
                          .map((p) => JSON.parse(p.data) as RepairPublication)
                          .find((p) => p.outcome === "published")?.local_head
                      }
                    </code>
                  </p>
                  <div className="actions">
                    <Button
                      onClick={() =>
                        void window.vibestar.openExternal(session.identity.url)
                      }
                    >
                      Open PR on GitHub
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => analyze(session.job_id)}
                    >
                      Analyze PR Again
                    </Button>
                  </div>
                </article>
              )}
              {!!detail.publications.length && (
                <details className="repair-history">
                  <summary>Publication and repair history</summary>
                  {detail.publications.map((row) => {
                    const item = JSON.parse(row.data) as RepairPublication;
                    return (
                      <article key={row.id}>
                        <Status status={row.status} />
                        <code>{item.local_head}</code>
                        <p>
                          {item.destination.repository}:
                          {item.destination.branch}
                        </p>
                        {item.error && <p className="warning">{item.error}</p>}
                        {["uncertain", "pushing"].includes(row.status) && (
                          <Button
                            disabled={busy || detail.active}
                            onClick={() =>
                              void act("repair.reconcilePublication", {
                                publication_id: row.id,
                              })
                            }
                          >
                            Reconcile remote read-only
                          </Button>
                        )}
                      </article>
                    );
                  })}
                  {detail.activity.map((activity) => (
                    <p key={activity.id}>
                      {new Date(activity.timestamp).toLocaleString()} ·{" "}
                      {activity.kind === "transition"
                        ? `${JSON.parse(activity.data).from} → ${JSON.parse(activity.data).to}`
                        : activity.kind.replaceAll("_", " ")}
                    </p>
                  ))}
                </details>
              )}
              {!detail.active &&
                [
                  "created",
                  "ready_to_repair",
                  "failed",
                  "cancelled",
                  "interrupted",
                ].includes(session.status) && (
                  <Button
                    disabled={busy}
                    onClick={() => void act("repair.start")}
                  >
                    Continue repair explicitly
                  </Button>
                )}
            </>
          }
          actions={
            awaiting ? (
              <ActionTray
                id={id}
                label="PR repair manual review"
                title="Review repair complete · Manual review required"
                detail="Inspect the repair and independent verification before the separate local commit and publication decisions."
              >
                <Button
                  size="sm"
                  onClick={() => openWorkspaceTool(id, "final-review")}
                >
                  Review repair and publication options
                </Button>
              </ActionTray>
            ) : null
          }
          composer={
            <Composer
              id={id}
              label="PR repair follow-up"
              placeholder={
                canFollowUp
                  ? "Describe a further fix for Codex, followed by independent verification…"
                  : "Keep a local draft while this repair cannot accept another run…"
              }
              sendLabel="Request Further Fix"
              busy={busy}
              disabled={!canFollowUp}
              maxLength={16000}
              notice={notice}
              onEdit={() => setNotice("")}
              hint={
                canFollowUp
                  ? "Send explicitly starts Codex repair followed by Antigravity verification."
                  : "Draft saved locally. Resolve the current repair state before requesting another run; published repairs require a new explicit PR analysis."
              }
              save={{
                label: "Save draft locally",
                run: () => {
                  updateTaskView(id, { draft: view.draft });
                  setNotice("Draft saved locally · no repair agent started");
                },
              }}
              onSend={() => {
                const instructions = composerContent(view);
                if (
                  !instructions ||
                  instructions.length > 16000 ||
                  busy ||
                  !canFollowUp
                )
                  return;
                const signature = JSON.stringify({ instructions });
                const request_id =
                  view.messageRequest?.signature === signature
                    ? view.messageRequest.id
                    : crypto.randomUUID();
                updateTaskView(id, {
                  messageRequest: { id: request_id, signature },
                });
                void act("repair.start", { instructions, request_id }).then(
                  (value) => {
                    if (value) {
                      setNotice(
                        "Further fix requested · approved Codex → Antigravity sequence retained",
                      );
                      if (
                        composerContent(currentDraft.current) === instructions
                      )
                        updateTaskView(id, {
                          draft: "",
                          draftContext: [],
                          messageRequest: null,
                        });
                    }
                  },
                );
              }}
              model={
                <Button
                  variant="ghost"
                  size="sm"
                  className="repair-model-link"
                  aria-label="Inspect repair stage models"
                  onClick={() => openWorkspaceTool(id, "pipeline")}
                >
                  Codex → Antigravity
                </Button>
              }
              context={workspaceContext({
                id,
                owner: "repair",
                files: diff?.files || [],
                selected: view.diffPath,
                layer,
                plan: JSON.stringify(session.actions, null, 2),
                failures: reportedTests
                  .filter((test) => test.status !== "passed")
                  .map((test) => JSON.stringify(test))
                  .join("\n"),
              })}
            />
          }
        />
        <SecondaryWorkspace id={id}>
          {view.secondarySection === "changes" ? (
            <>
              <div className="repair-diff-layers">
                {Object.entries(layers).map(([key, label]) => (
                  <Button
                    key={key}
                    size="sm"
                    variant={layer === key ? "secondary" : "ghost"}
                    onClick={() => {
                      const nextLayer = key as keyof typeof layers;
                      updateTaskView(id, {
                        diffLayer: nextLayer,
                        diffPath: view.diffLayerPaths[nextLayer] || "",
                      });
                    }}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              <ChangesView
                task={{
                  id,
                  base_commit_sha:
                    layer === "original"
                      ? workspace.original_base
                      : layer === "upstream"
                        ? workspace.original_head
                        : workspace.integrated_head || workspace.original_head,
                }}
                diff={diff}
                revision={revision}
                onError={onError}
                compact={!view.expandedTool}
                owner="repair"
                baseline={
                  layer === "original"
                    ? `PR base ${workspace.original_base.slice(0, 8)} → PR head ${workspace.original_head.slice(0, 8)}`
                    : layer === "upstream"
                      ? `PR head ${workspace.original_head.slice(0, 8)} → integrated head ${workspace.integrated_head?.slice(0, 8) || "pending"}`
                      : `Integrated head ${(workspace.integrated_head || workspace.original_head).slice(0, 8)} → working tree`
                }
                layer={layer}
                reviews={layer === "repair" ? reviews : []}
                reviewed={(path, old_path, expected_hash, reviewed) =>
                  void act("repair.reviewed", {
                    path,
                    old_path,
                    expected_hash,
                    reviewed,
                  })
                }
              />
            </>
          ) : view.secondarySection === "tests" ? (
            <div className="tests-panel">
              <CommandRuns
                detail={{ tests: detail.tests, runs: detail.runs }}
              />
              <details>
                <summary>
                  Agent-reported checks · distinct from observed command
                  evidence
                </summary>
                {reportedTests.map((test, index) => (
                  <p key={index}>
                    <Status status={test.status} /> <code>{test.command}</code>{" "}
                    · {test.evidence}
                  </p>
                ))}
              </details>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  try {
                    void act("repair.command", { argv: parseArgv(argv) });
                  } catch (error) {
                    setError(errorMessage(error));
                  }
                }}
              >
                <label>
                  Manual validation command
                  <input
                    aria-label="Repair validation argv"
                    value={argv}
                    onChange={(e) => setArgv(e.target.value)}
                  />
                </label>
                <Button
                  disabled={busy || detail.active || !prepared}
                  type="submit"
                >
                  Run command
                </Button>
              </form>
            </div>
          ) : view.secondarySection === "usage" ? (
            <UsageView records={detail.usage} />
          ) : view.secondarySection === "logs" ? (
            <LogView
              taskId={id}
              runs={detail.runs}
              events={detail.events}
              owner="repair"
              selectedRun={view.outputRun || undefined}
            />
          ) : view.secondarySection === "final-review" ? (
            <div className="engineering-panel">
              {" "}
              {awaiting && (
                <article className="repair-gate">
                  <span className="eyebrow">MANUAL REVIEW REQUIRED</span>
                  <h2>PR Review Repair Complete — Manual Review Required</h2>
                  <AgentResponse
                    text={
                      session.implementation?.summary ||
                      "Implementation unavailable"
                    }
                  />
                  <h3>
                    Antigravity independent review ·{" "}
                    {session.verification?.overall.replaceAll("_", " ")}
                  </h3>
                  <AgentResponse
                    text={
                      session.verification?.summary ||
                      "Verification unavailable"
                    }
                  />
                  <ol className="repair-checklist">
                    {session.actions.map((action) => {
                      const implementation = session.implementation?.items.find(
                        (item) => item.actionId === action.id,
                      );
                      const verification = session.verification?.items.find(
                        (item) => item.actionId === action.id,
                      );
                      return (
                        <li key={action.id}>
                          <AgentResponse text={action.originalText} />
                          <p>
                            <strong>
                              {implementation?.status || "No result"}
                            </strong>{" "}
                            · Independent review:{" "}
                            <strong>
                              {verification?.status || "unverified"}
                            </strong>
                          </p>
                          <p>{implementation?.explanation}</p>
                          <p>{verification?.explanation}</p>
                          <small>
                            {implementation?.files.join(", ")} · source{" "}
                            {action.sourceId}
                          </small>
                        </li>
                      );
                    })}
                  </ol>
                  <p>
                    {diff
                      ? `${layers[layer]}: ${diff.files.length} files · +${diff.insertions} / −${diff.deletions}`
                      : "Open Changes to inspect file counts."}
                  </p>
                  <p className="subtle">
                    Upstream {session.identity.base.branch} ·{" "}
                    <code>{workspace.fetched_base}</code>
                    <br />
                    Local integration commit ·{" "}
                    <code>
                      {workspace.merge_commit || "Already integrated"}
                    </code>
                  </p>
                  {[
                    ...(session.implementation?.risks || []),
                    ...(session.verification?.risks || []),
                  ].map((risk, index) => (
                    <p className="warning" key={index}>
                      {risk}
                    </p>
                  ))}
                  <p>
                    {
                      detail.tests.filter((test) => test.status === "passed")
                        .length
                    }{" "}
                    observed commands passed ·{" "}
                    {
                      detail.tests.filter((test) => test.status === "failed")
                        .length
                    }{" "}
                    failed ·{" "}
                    {
                      reportedTests.filter((test) =>
                        ["blocked", "not_run"].includes(test.status),
                      ).length
                    }{" "}
                    checks reported blocked/not run
                  </p>
                  <div className="actions">
                    <Button
                      disabled={busy || detail.active || !canApprove}
                      onClick={async () => {
                        const plan = await act<RepairPublication>(
                          "repair.approve",
                          {
                            expected_hash: session.review_hash,
                            confirmed: true,
                          },
                        );
                        if (plan) setPublication(plan);
                      }}
                    >
                      Approve and Prepare Push
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={busy || detail.active || !canApprove}
                      onClick={() => setLocalCommit(true)}
                    >
                      Commit Locally
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={busy || detail.active}
                      onClick={() => void act("repair.keepLocal")}
                    >
                      Keep Local
                    </Button>
                    <Button variant="ghost" onClick={() => inspect("Tests")}>
                      Review test evidence
                    </Button>
                  </div>
                </article>
              )}
              {!awaiting && (
                <AgentResponse
                  text={
                    session.verification?.summary ||
                    "Independent verification has not completed."
                  }
                />
              )}
            </div>
          ) : view.secondarySection === "plans" ? (
            <div className="engineering-panel">
              {" "}
              <RepairActions session={session} />
              <RepairIdentity session={session} />
            </div>
          ) : view.secondarySection === "run-details" ? (
            <div className="engineering-panel">
              <label>
                Selected run
                <select
                  aria-label="Inspect run"
                  value={run?.id || ""}
                  onChange={(e) =>
                    updateTaskView(id, { outputRun: e.target.value })
                  }
                >
                  {detail.runs.map((run) => (
                    <option key={run.id} value={run.id}>
                      {run.provider} · {run.purpose} · {run.status}
                    </option>
                  ))}
                </select>
              </label>
              {run && (
                <>
                  <p>
                    {run.provider} · {run.model || "CLI default"} · {run.effort}{" "}
                    · {run.status}
                  </p>
                  <RunPrompt run={run} />
                  <pre>
                    {JSON.stringify(
                      {
                        id: run.id,
                        started_at: run.started_at,
                        ended_at: run.ended_at,
                        exit_code: run.exit_code,
                        conversation_id: run.conversation_id,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </>
              )}{" "}
              <RepairIdentity session={session} />
            </div>
          ) : (
            <div className="engineering-panel">
              <Status status={session.status} />
              <h3>Repair pipeline</h3>
              <p>
                Isolated branch preparation → Codex repair → Antigravity
                verification → manual review → separate publication
                confirmation.
              </p>
              {Object.entries(session.configuration).map(
                ([provider, configuration]) => (
                  <div key={provider}>
                    <strong>{provider}</strong>
                    <p>
                      {configuration.model || "Official CLI default"} ·{" "}
                      {configuration.effort}
                    </p>
                  </div>
                ),
              )}
              <p className="subtle">
                Repair execution uses this approved configuration. The chat
                model cannot override repair orchestration.
              </p>
              <h3>Git identity</h3>
              <p>
                {session.identity.head.name}:{session.identity.head.branch}
              </p>
              <code>{workspace.worktree_path}</code>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => openWorkspaceTool(id, "plans")}
              >
                Review action checklist
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={detail.active}
                onClick={() => setCleanup(true)}
              >
                Remove repair workspace
              </Button>
            </div>
          )}
        </SecondaryWorkspace>
      </div>
      <BottomDock
        id={id}
        terminal={
          <TaskTerminal
            task={{ id, worktree_path: workspace.worktree_path }}
            owner="repair"
            onError={onError}
          />
        }
        problems={
          <div className="problems-panel">
            <p>{error || session.error || "No repair problems"}</p>
            {(error || session.error) && (
              <Button size="sm" onClick={() => inspect("Tests")}>
                Inspect repair evidence
              </Button>
            )}
          </div>
        }
      />
      <footer className="workspace-status">
        <code>{workspace.branch_name}</code>
        <span className="spacer" />
        <Button
          size="sm"
          variant="ghost"
          aria-label="Toggle utility dock"
          onClick={() =>
            updateTaskView(id, { terminalDock: !view.terminalDock })
          }
        >
          <PanelBottom size={13} />
          Terminal
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            updateTaskView(id, { terminalDock: true, dockTab: "Problems" })
          }
        >
          Problems
        </Button>
      </footer>
      {publication && (
        <PublicationDialog
          publication={publication}
          close={() => setPublication(undefined)}
          refresh={async () => {
            await reload();
            await refresh();
          }}
        />
      )}
      {localCommit && (
        <LocalCommitDialog
          session={session}
          close={() => setLocalCommit(false)}
          refresh={async () => {
            await reload();
            await refresh();
          }}
        />
      )}
      {cleanup && (
        <div className="modal-backdrop">
          <section
            className="modal compact-modal"
            ref={cleanupDialog}
            role="dialog"
            aria-modal="true"
            aria-label="Remove PR repair workspace"
            onKeyDown={(e) => {
              if (e.key === "Escape" && !busy) setCleanup(false);
              containDialogFocus(e);
            }}
          >
            <h2>Remove owned repair workspace</h2>
            <code>{workspace.worktree_path}</code>
            <p>
              Only a clean, owned worktree and its local repair branch can be
              removed. Local modifications and pending merges are preserved.
            </p>
            <div className="actions">
              <Button variant="secondary" onClick={() => setCleanup(false)}>
                Cancel
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void act("repair.cleanup", {
                    confirmed: true,
                    history: false,
                  }).then((result) => {
                    if (result) setCleanup(false);
                  })
                }
              >
                Remove workspace, keep history
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void act("repair.cleanup", {
                    confirmed: true,
                    history: true,
                  }).then((result) => {
                    if (result) back();
                  })
                }
              >
                Remove workspace and history
              </Button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
};
