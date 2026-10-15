import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, PanelRight, Square, Maximize2, X } from "lucide-react";
import { rpc, errorMessage, parseArgv } from "../../lib/api";
import { useTaskView, updateTaskView } from "../../lib/taskView";
import { usePaneSize } from "../../lib/usePaneSize";
import { navigateTabs } from "../../lib/keyboard";
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
import { ResizeHandle } from "../ResizeHandle";
import { PublicationDialog } from "./PublicationDialog";
import { LocalCommitDialog } from "./LocalCommitDialog";
import type { RepairDetail, RepairPublication } from "./types";

const layers = {
  original: "Original PR changes",
  upstream: "Upstream integration",
  repair: "Review repair changes",
} as const;
const docks = ["Changes", "Tests", "Agent Output", "Logs", "Usage", "Terminal"];

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
  const [publication, setPublication] = useState<RepairPublication>();
  const [localCommit, setLocalCommit] = useState(false);
  const [layer, setLayer] = useState<keyof typeof layers>("repair");
  const [diff, setDiff] = useState<Diff | null>(null);
  const [argv, setArgv] = useState('["git", "diff", "--check"]');
  const [reviews, setReviews] = useState<
    { path: string; hash: string; reviewed: boolean }[]
  >([]);
  const [cleanup, setCleanup] = useState(false);
  const cleanupDialog = useDialogFocus(cleanup);
  const view = useTaskView(id);
  const [height, setHeight] = usePaneSize("repairDockHeight", 310, 180, 800);
  const [width, setWidth] = usePaneSize("repairContextWidth", 330, 240, 700);
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
    setDiff(null);
    if (prepared)
      void rpc<Diff>("repair.diff", { id, layer })
        .then((value) => {
          if (alive) setDiff(value);
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
      setBusy(false);
    }
  };
  const dock = (name: string) =>
    updateTaskView(id, { dockTab: name, terminalDock: true });
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
  return (
    <div
      className={`workspace repair-workspace ${view.terminalDock && view.dockMaximized ? "dock-maximized" : ""}`}
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
          <span>{session.identity.upstream.name}</span>
          <strong>PR #{session.identity.number} · Review repair</strong>
          <span className="spacer" />
          <Status status={session.status} />
          {detail.active && (
            <Button
              variant="ghost"
              size="sm"
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
          <Button
            variant="ghost"
            size="icon"
            aria-label="Toggle repair context pane"
            aria-pressed={view.contextPane === "pipeline"}
            onClick={() =>
              updateTaskView(id, {
                contextPane: view.contextPane === "none" ? "pipeline" : "none",
              })
            }
          >
            <PanelRight size={14} />
          </Button>
        </div>
        <div className="workspace-actions">
          <OpenInEditor
            id={id}
            kind="repair"
            path={workspace.worktree_path}
            disabled={!workspace.branch_owned}
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={!prepared}
            onClick={() => dock("Changes")}
          >
            Review Changes
          </Button>
          <Button size="sm" variant="ghost" onClick={() => dock("Tests")}>
            Tests
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => dock("Agent Output")}
          >
            Agent Output
          </Button>
        </div>
      </header>
      <CurrentRun
        detail={{
          runs: detail.runs,
          events: detail.events,
          usage: detail.usage,
          status: session.status,
          updated_at: session.updated_at,
        }}
        output={() => dock("Agent Output")}
        stop={() => void act("repair.cancel")}
        usage={() => dock("Usage")}
      />
      {(error || session.error) && (
        <div className="error-box" role="alert">
          {error || session.error}
          <Button variant="ghost" size="sm" onClick={() => setError("")}>
            Dismiss
          </Button>
        </div>
      )}
      <div className="repair-body">
        <div className="repair-conversation">
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
              {session.context.snapshot?.linkedIssues?.map((issue, index) => (
                <AgentResponse
                  key={index}
                  text={`${String(issue.title || "Linked issue")}\n\n${String(issue.body || "")}`}
                />
              ))}
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
                The isolated repair worktree and conflicted index are preserved.
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
                  session.verification?.summary || "Verification unavailable"
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
                        <strong>{implementation?.status || "No result"}</strong>{" "}
                        · Independent review:{" "}
                        <strong>{verification?.status || "unverified"}</strong>
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
                <code>{workspace.merge_commit || "Already integrated"}</code>
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
                {detail.tests.filter((test) => test.status === "passed").length}{" "}
                observed commands passed ·{" "}
                {detail.tests.filter((test) => test.status === "failed").length}{" "}
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
                      { expected_hash: session.review_hash, confirmed: true },
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
                <Button variant="ghost" onClick={() => dock("Tests")}>
                  Review test evidence
                </Button>
              </div>
            </article>
          )}
          {session.status === "stale_remote_head" && (
            <article className="repair-gate warning">
              <h2>Remote PR head changed</h2>
              <p>
                This repair and its history are preserved. Analyze the current
                PR explicitly before preparing a new repair.
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
                      {item.destination.repository}:{item.destination.branch}
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
              <Button disabled={busy} onClick={() => void act("repair.start")}>
                Continue repair explicitly
              </Button>
            )}
          {!detail.active &&
            !["published", "merge_conflict", "stale_remote_head"].includes(
              session.status,
            ) && (
              <form
                className="repair-composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!view.draft.trim()) return;
                  void act("repair.start", { instructions: view.draft }).then(
                    (value) => {
                      if (value) updateTaskView(id, { draft: "" });
                    },
                  );
                }}
              >
                <label>
                  Request Further Fix
                  <textarea
                    aria-label="PR repair follow-up"
                    value={view.draft}
                    rows={3}
                    onChange={(e) =>
                      updateTaskView(id, { draft: e.target.value })
                    }
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        e.currentTarget.form?.requestSubmit();
                      }
                    }}
                    placeholder="Describe an explicit follow-up for Codex, followed by independent verification…"
                  />
                </label>
                <Button
                  type="submit"
                  disabled={
                    busy ||
                    !view.draft.trim() ||
                    session.status === "ready_to_publish"
                  }
                >
                  Request Further Fix
                </Button>
              </form>
            )}
        </div>
        {view.contextPane === "pipeline" && (
          <>
            <ResizeHandle
              label="Resize repair context pane"
              value={width}
              onChange={setWidth}
              min={240}
              max={700}
              reverse
            />
            <aside className="context-pane repair-context" style={{ width }}>
              <h3>Review action checklist</h3>
              {session.actions.map((action) => (
                <article key={action.id}>
                  <strong>{action.classification.replaceAll("_", " ")}</strong>
                  <AgentResponse text={action.originalText} />
                  <small>
                    @{action.reviewer} · source {action.sourceId}
                  </small>
                </article>
              ))}
              <h3>Git identity</h3>
              <dl className="repository-facts">
                <dt>Fork / branch</dt>
                <dd>
                  {session.identity.head.name}:
                  <code>{session.identity.head.branch}</code>
                </dd>
                <dt>Original PR head</dt>
                <dd>
                  <code>{workspace.original_head}</code>
                </dd>
                <dt>Upstream base</dt>
                <dd>
                  {session.identity.base.branch}
                  <code>{workspace.fetched_base}</code>
                </dd>
                <dt>Worktree</dt>
                <dd>
                  <code>{workspace.worktree_path}</code>
                </dd>
                <dt>Local branch</dt>
                <dd>
                  <code>{workspace.branch_name}</code>
                </dd>
              </dl>
            </aside>
          </>
        )}
      </div>
      {view.terminalDock && (
        <>
          <ResizeHandle
            label="Resize repair utility dock"
            value={height}
            onChange={setHeight}
            min={180}
            max={800}
            vertical
            reverse
          />
          <section
            className="utility-dock"
            style={{ height: view.dockMaximized ? undefined : height }}
          >
            <div
              className="dock-tabs"
              role="tablist"
              aria-label="PR repair utilities"
              onKeyDown={navigateTabs}
            >
              {docks.map((name) => (
                <button
                  role="tab"
                  key={name}
                  aria-selected={view.dockTab === name}
                  tabIndex={view.dockTab === name ? 0 : -1}
                  className={view.dockTab === name ? "selected" : ""}
                  onClick={() => dock(name)}
                >
                  {name}
                </button>
              ))}
              <span className="spacer" />
              <Button
                variant="ghost"
                size="icon"
                aria-label="Maximize repair dock"
                onClick={() =>
                  updateTaskView(id, { dockMaximized: !view.dockMaximized })
                }
              >
                <Maximize2 size={12} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close repair dock"
                onClick={() => updateTaskView(id, { terminalDock: false })}
              >
                <X size={12} />
              </Button>
            </div>
            {view.dockTab === "Changes" && (
              <>
                <div className="repair-diff-layers">
                  {Object.entries(layers).map(([key, label]) => (
                    <Button
                      key={key}
                      size="sm"
                      variant={layer === key ? "secondary" : "ghost"}
                      onClick={() => setLayer(key as keyof typeof layers)}
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
                          : workspace.integrated_head ||
                            workspace.original_head,
                  }}
                  diff={diff}
                  revision={revision}
                  onError={onError}
                  owner="repair"
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
            )}
            {view.dockTab === "Tests" && (
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
                      <Status status={test.status} />{" "}
                      <code>{test.command}</code> · {test.evidence}
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
            )}
            {["Agent Output", "Logs"].includes(view.dockTab) && (
              <LogView
                taskId={id}
                runs={detail.runs}
                events={detail.events}
                owner="repair"
              />
            )}
            {view.dockTab === "Usage" && <UsageView records={detail.usage} />}
            {view.dockTab === "Terminal" && (
              <TaskTerminal
                task={{ id, worktree_path: workspace.worktree_path }}
                owner="repair"
                onError={onError}
              />
            )}
          </section>
        </>
      )}
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
      {!detail.active && (
        <Button variant="ghost" size="sm" onClick={() => setCleanup(true)}>
          Remove repair workspace
        </Button>
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
