import { useEffect, useState } from "react";
import {
  Bookmark,
  ChevronLeft,
  ChevronRight,
  History,
  Pencil,
  Plus,
  Search,
  Square,
  X,
} from "lucide-react";
import type { Snapshot } from "../../lib/types";
import type { CandidateSummary, WatchSource } from "../../../backend/issue-watch/contracts";
import { useIssueWatch } from "./useIssueWatch";
import { rpc, errorMessage } from "../../lib/api";
import { tokenUsage } from "../../lib/format";
import { usePaneSize } from "../../hooks/usePaneSize";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { containDialogFocus, navigateTabs } from "../../lib/keyboard";
import { Button } from "../../components/ui/button";
import { EmptyState, ListSkeleton, PageHeader } from "../../components/ui/PageHeader";
import { ResizeHandle } from "../../components/shared/ResizeHandle";
import { UsageView } from "../usage/UsageView";
import { LogView } from "../chat/LogView";
import { WatchEditor } from "./WatchEditor";
import { ScanResults } from "./ScanResults";
import { IssueCandidateDetails } from "./IssueCandidateDetails";
import { IssueMarkdown } from "./IssueMarkdown";
const emptyCandidates: CandidateSummary[] = [];

export const IssueWatchPage = ({
  snapshot,
  initialWatchId,
  startTask,
}: {
  snapshot: Snapshot;
  initialWatchId?: string | null;
  startTask: (url: string, notes: string) => void;
}) => {
  const enabled = snapshot.capabilities?.manual_issue_watch === true;
  const state = useIssueWatch(enabled, initialWatchId);
  const [editor, setEditor] = useState<"new" | "edit" | null>(null);
  const [selected, setSelected] = useState("");
  const [tab, setTab] = useState("Results");
  const [busy, setBusy] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [showWatches, setShowWatches] = useState(
    () => localStorage.getItem("vibestar.issueWatch.watchesCollapsed") !== "true",
  );
  const [showDetails, setShowDetails] = useState(
    () => localStorage.getItem("vibestar.issueWatch.detailsCollapsed") !== "true",
  );
  const [watchWidth, setWatchWidth] = usePaneSize("issueWatch.watchWidth", 226, 180, 360);
  const [detailsWidth, setDetailsWidth] = usePaneSize("issueWatch.detailsWidth", 370, 280, 700);
  const [selection, setSelection] = useState<string[] | null>(null);
  const [source, setSource] = useState<WatchSource | null>(null);
  const [dispositionRevision, setDispositionRevision] = useState(0);
  const dialog = useDialogFocus(selection !== null || source !== null);
  const [request, setRequest] = useState({
    payload: "",
    id: "",
    completed: false,
  });
  const detail = state.detail?.watch.id === state.watchId ? state.detail : null;
  const scan = state.scan?.scan.watch_id === state.watchId ? state.scan : null;
  const active = detail?.active;
  const candidates = scan?.candidates || detail?.results || emptyCandidates;
  const model = detail?.revision.configuration.model;
  const unsupported = model && !detail?.provider_support[model.provider]?.supported;
  const provisional = !!scan && scan.scan.status !== "completed";
  useEffect(() => {
    if (
      !candidates.some(
        (candidate) =>
          candidate.issue.id === selected && (showDismissed || !candidate.dismissed_at),
      )
    )
      setSelected(
        candidates.find((candidate) => showDismissed || !candidate.dismissed_at)?.issue.id || "",
      );
  }, [candidates, selected, showDismissed]);
  useEffect(() => {
    localStorage.setItem("vibestar.issueWatch.watchesCollapsed", String(!showWatches));
    localStorage.setItem("vibestar.issueWatch.detailsCollapsed", String(!showDetails));
  }, [showWatches, showDetails]);
  const run = async (kind: "scan" | "retry" | "continue" = "scan", ids?: string[]) => {
    if (!detail) return;
    setBusy(true);
    state.setError("");
    try {
      const payload =
        kind === "scan"
          ? {
              watch_id: detail.watch.id,
              expected_revision: detail.watch.current_revision,
              ...(ids ? { candidate_ids: ids } : {}),
            }
          : {
              watch_id: detail.watch.id,
              scan_id: scan?.scan.id,
              ...(ids ? { candidate_ids: ids } : {}),
            };
      const serialized = JSON.stringify({ kind, ...payload });
      const identity =
        request.payload === serialized && !request.completed ? request.id : crypto.randomUUID();
      setRequest({ payload: serialized, id: identity, completed: false });
      const operation = await rpc<{ scan_id: string }>(`issueWatch.${kind}`, {
        ...payload,
        request_id: identity,
      });
      setRequest({ payload: serialized, id: identity, completed: true });
      state.setScanId(operation.scan_id);
      setTab("Results");
      setSelection(null);
      await state.refresh();
    } catch (e) {
      state.setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!detail || !active) return;
    setBusy(true);
    try {
      await rpc("issueWatch.cancel", {
        watch_id: detail.watch.id,
        scan_id: active.id,
      });
      await state.refresh();
    } catch (e) {
      state.setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const organize = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      await rpc("issueWatch.archive", {
        watch_id: detail.watch.id,
        expected_revision: detail.watch.current_revision,
        archived: !detail.watch.archived,
      });
      state.setArchived(!detail.watch.archived);
      await state.refresh();
    } catch (e) {
      state.setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const pending = candidates.filter(
    (candidate) => candidate.eligible && candidate.semantic_state !== "completed",
  );
  if (!enabled)
    return (
      <section className="watch-update-required">
        <Search size={24} />
        <h1>Issue Watch</h1>
        <p>Update the execution helper in Settings → Execution to use manual Issue Watch.</p>
        <p className="subtle">
          This helper has not confirmed the manual-only contract. No scan or model call was started.
        </p>
      </section>
    );
  return (
    <section className="issue-watch-page">
      <PageHeader
        className="watch-page-heading"
        title="Issue Watch"
        description="Find contributions that match your criteria, with current source evidence."
        actions={
          <>
            {active && (
              <Button
                className="watch-mobile-cancel"
                variant="destructive"
                disabled={busy}
                onClick={() => void cancel()}
                aria-label="Cancel active scan"
              >
                <Square size={12} />
                Cancel scan
              </Button>
            )}
            <Button variant="default" onClick={() => setEditor("new")}>
              <Plus size={14} />
              New watch
            </Button>
          </>
        }
      />
      {state.error && (
        <div className="error-box watch-error" role="alert">
          <span>{state.error}</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Dismiss Issue Watch error"
            onClick={() => state.setError("")}
          >
            <X size={14} />
          </Button>
        </div>
      )}
      <div className="watch-layout">
        {(state.watches.length > 0 || state.archived) && (
          <div className="watch-panel-toggles">
            <Button
              variant="ghost"
              size="icon"
              aria-label={showWatches ? "Collapse saved watches" : "Show saved watches"}
              onClick={() => setShowWatches(!showWatches)}
            >
              {showWatches ? <ChevronLeft size={14} /> : <Bookmark size={14} />}
            </Button>
          </div>
        )}
        {showWatches && (state.watches.length > 0 || state.archived) && (
          <>
            <aside className="watch-saved" style={{ width: watchWidth }} aria-label="Saved watches">
              <div className="watch-saved-heading">
                <h2>
                  Saved watches <span>{state.watches.length}</span>
                </h2>
                <label>
                  <input
                    type="checkbox"
                    checked={state.archived}
                    onChange={(event) => state.setArchived(event.target.checked)}
                  />
                  Archived
                </label>
              </div>
              <div className="watch-saved-list">
                {state.watches.map((watch) => {
                  const counts = watch.latest?.summary || {};
                  const newCount =
                    (counts.initial_discovery || 0) +
                    (counts.newly_matching || 0) +
                    (counts.new_issue || 0) +
                    (counts.reentered || 0);
                  return (
                    <button
                      key={watch.id}
                      className={watch.id === state.watchId ? "selected" : ""}
                      onClick={() => {
                        state.select(watch.id);
                        setSelected("");
                        setTab("Results");
                      }}
                      aria-pressed={watch.id === state.watchId}
                    >
                      <div>
                        <Bookmark size={13} />
                        <strong>{watch.name}</strong>
                        {newCount > 0 && <span className="watch-count">{newCount}</span>}
                      </div>
                      <span>{watch.repository.full_name}</span>
                      <small>
                        {watch.revision?.configuration.model.provider ||
                          "Configuration unavailable"}{" "}
                        · {watch.revision?.configuration.model.model}
                      </small>
                      <footer>
                        <span className={watch.active ? "watch-running" : ""}>
                          {watch.active
                            ? watch.active.phase
                            : watch.latest?.status || "Never scanned"}
                        </span>
                        <time>
                          {watch.latest?.ended_at
                            ? new Date(watch.latest.ended_at).toLocaleDateString()
                            : ""}
                        </time>
                      </footer>
                    </button>
                  );
                })}
                {!state.watches.length && (
                  <p className="watch-empty">
                    {state.archived
                      ? "No archived watches."
                      : "Create a watch to save your repository, filters and model. Nothing runs until Scan Now."}
                  </p>
                )}
                {state.moreWatches && (
                  <Button variant="ghost" size="sm" onClick={state.loadWatches}>
                    Load more watches
                  </Button>
                )}
              </div>
            </aside>
            <ResizeHandle
              label="Saved watches width"
              value={watchWidth}
              onChange={setWatchWidth}
              min={180}
              max={360}
            />
          </>
        )}
        <main className="watch-discovery">
          {detail ? (
            <>
              <header className="watch-toolbar">
                <div>
                  <h2>{detail.watch.name}</h2>
                  <p>
                    {detail.watch.repository.full_name}{" "}
                    <span>· Revision {detail.watch.current_revision}</span>
                  </p>
                </div>
                <div className="watch-toolbar-actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!!active}
                    onClick={() => setEditor("edit")}
                  >
                    <Pencil size={13} />
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!!active || busy}
                    onClick={() => void organize()}
                  >
                    {detail.watch.archived ? "Restore" : "Archive"}
                  </Button>
                  {active ? (
                    <Button variant="destructive" disabled={busy} onClick={() => void cancel()}>
                      <Square size={12} />
                      {active.status === "cancelling" ? "Cancelling…" : "Cancel scan"}
                    </Button>
                  ) : (
                    <Button
                      variant="default"
                      disabled={busy || detail.watch.archived || !!unsupported}
                      onClick={() => void run()}
                    >
                      <Search size={13} />
                      Scan Now
                    </Button>
                  )}
                </div>
              </header>
              <div className="watch-effective-model">
                <span>
                  Next scan · {model?.provider} / {model?.model} / {model?.effort}
                </span>
                <small>
                  At most one semantic invocation · {model?.timeout_secs}s · Private GitHub content
                  is sent to this provider
                </small>
                {scan?.run && (
                  <small>
                    Selected attempt · {scan.run.provider} / {scan.run.model} / {scan.run.effort} ·{" "}
                    {scan.run.status}
                  </small>
                )}
              </div>
              {unsupported && (
                <p className="error-box">{detail.provider_support[model!.provider].reason}</p>
              )}
              {active && (
                <section className="watch-progress" role="status" aria-live="polite">
                  <span className="watch-pulse" />
                  <div>
                    <strong>{active.phase}</strong>
                    <p>
                      {active.coverage.checked} checked · {active.coverage.discovered} discovered ·{" "}
                      {active.coverage.excluded} excluded · Trackers{" "}
                      {active.coverage.exclusions_complete ? "verified" : "pending"}
                    </p>
                    <small>
                      {active.semantic_attempts
                        ? "Semantic invocation reserved / active; see Output and actual Usage."
                        : "AI not started"}
                    </small>
                  </div>
                </section>
              )}
              <div className="watch-history-toolbar">
                <label>
                  <History size={13} />
                  <span className="sr-only">Scan history</span>
                  <select
                    aria-label="Scan history"
                    value={state.scanId}
                    onChange={(event) => {
                      state.setScanId(event.target.value);
                      setSelected("");
                    }}
                  >
                    <option value="">Latest attempt</option>
                    {state.history.map((attempt) => (
                      <option key={attempt.id} value={attempt.id}>
                        {new Date(attempt.started_at).toLocaleString()} · {attempt.status} · r
                        {attempt.revision}
                      </option>
                    ))}
                  </select>
                </label>
                {state.moreHistory && (
                  <Button variant="ghost" size="sm" onClick={state.loadHistory}>
                    Load older attempts
                  </Button>
                )}
                <span>
                  {detail.baseline
                    ? `Last complete: ${new Date(detail.baseline.ended_at || detail.baseline.started_at).toLocaleString()}`
                    : "Complete baseline not established"}
                </span>
                <Button variant="ghost" size="sm" onClick={() => setShowDetails(!showDetails)}>
                  {showDetails ? "Hide details" : "Show details"}
                  <ChevronRight size={13} />
                </Button>
              </div>
              {scan && !active && (
                <section
                  className={`watch-coverage-banner ${scan.scan.status === "completed" ? "complete" : "partial"}`}
                  role="status"
                >
                  <strong>
                    {scan.scan.status === "completed"
                      ? "Scan complete within the declared collection scope"
                      : `${scan.scan.status.replaceAll("_", " ")} · Coverage is incomplete`}
                  </strong>
                  <p>
                    {scan.scan.coverage.checked} issues checked of{" "}
                    {scan.scan.coverage.search_total ?? "unknown"} search results ·{" "}
                    {scan.scan.coverage.excluded} hard exclusions · {scan.scan.coverage.requests}{" "}
                    GitHub requests
                  </p>
                  {scan.scan.error && <p>{scan.scan.error}</p>}
                  <small>
                    {provisional
                      ? "Provisional results; the last complete baseline is preserved. "
                      : "GitHub search can lag and is not an atomic repository snapshot. "}
                    {scan.scan.semantic_attempts === 0
                      ? "GitHub-only screening · No AI usage"
                      : scan.usage.length
                        ? tokenUsage(scan.usage[0])
                        : "Semantic slot reserved · No reported usage"}
                  </small>
                  {scan.scan.status === "partial" && pending.length > 0 && (
                    <Button
                      size="sm"
                      disabled={busy || !!unsupported}
                      onClick={() =>
                        setSelection(
                          pending
                            .slice(0, detail.revision.configuration.limits.max_semantic_candidates)
                            .map((candidate) => candidate.issue.id),
                        )
                      }
                    >
                      Continue Analysis · choose candidates
                    </Button>
                  )}
                  {["failed", "blocked", "cancelled", "interrupted"].includes(scan.scan.status) && (
                    <Button
                      size="sm"
                      disabled={busy || !!unsupported || detail.watch.archived}
                      onClick={() => void run("retry")}
                    >
                      Retry explicitly
                    </Button>
                  )}
                </section>
              )}
              <div
                className="watch-view-tabs"
                role="tablist"
                aria-label="Issue Watch views"
                onKeyDown={navigateTabs}
              >
                {["Results", "Coverage", "Output", "Usage"].map((view) => (
                  <button
                    role="tab"
                    aria-selected={tab === view}
                    tabIndex={tab === view ? 0 : -1}
                    className={tab === view ? "selected" : ""}
                    key={view}
                    onClick={() => setTab(view)}
                  >
                    {view}
                  </button>
                ))}
                <label>
                  <input
                    type="checkbox"
                    checked={showDismissed}
                    onChange={(event) => setShowDismissed(event.target.checked)}
                  />
                  Show dismissed
                </label>
              </div>
              <div className="watch-view-content" role="tabpanel" aria-label={tab}>
                {tab === "Results" ? (
                  <>
                    <ScanResults
                      candidates={candidates}
                      selected={selected}
                      onSelect={(id) => {
                        setSelected(id);
                        setShowDetails(true);
                      }}
                      provisional={provisional}
                      showDismissed={showDismissed}
                    />
                    <footer className="watch-scope-note">
                      Counts include dismissed results. New matching describes eligibility history;
                      each issue retains its actual creation date. No issue is claimed or assigned
                      by Vibestar.
                    </footer>
                  </>
                ) : tab === "Output" ? (
                  scan?.run ? (
                    <LogView
                      taskId={`issue-watch:${scan.scan.id}`}
                      owner="issueWatch"
                      watchId={detail.watch.id}
                      scanId={scan.scan.id}
                      runs={[scan.run]}
                      events={[]}
                    />
                  ) : (
                    <p className="watch-empty">
                      No semantic CLI run started for this attempt. GitHub-only evidence does not
                      consume AI allowance.
                    </p>
                  )
                ) : tab === "Usage" ? (
                  <UsageView records={scan?.usage || []} />
                ) : (
                  <div className="watch-coverage-details">
                    {scan ? (
                      <>
                        <h3>Declared scope and coverage</h3>
                        <code>{scan.scan.coverage.query || "No search completed"}</code>
                        <dl className="watch-facts">
                          {(
                            [
                              ["Discovery", scan.scan.coverage.search_complete],
                              ["Required trackers", scan.scan.coverage.exclusions_complete],
                              ["Discussion / PR / policy", scan.scan.coverage.evidence_complete],
                              ["Semantic screening", scan.scan.coverage.semantic_complete],
                            ] as const
                          ).map(([label, complete]) => (
                            <div key={label}>
                              <dt>{label}</dt>
                              <dd>
                                {complete
                                  ? "Verified within declared scope"
                                  : "Incomplete / unknown"}
                              </dd>
                            </div>
                          ))}
                        </dl>
                        <ul>
                          {scan.scan.coverage.warnings.map((warning, index) => (
                            <li key={index}>{warning}</li>
                          ))}
                        </ul>
                        <h3>Tracker and policy snapshots</h3>
                        {scan.sources
                          .filter((entry) =>
                            ["tracker", "tracker_comment", "policy"].includes(entry.kind),
                          )
                          .map((entry) => (
                            <button
                              className="watch-source-card"
                              key={entry.key}
                              onClick={() =>
                                void rpc<WatchSource>("issueWatch.sourceDetail", {
                                  watch_id: detail.watch.id,
                                  scan_id: scan.scan.id,
                                  source_key: entry.key,
                                })
                                  .then(setSource)
                                  .catch((e) => state.setError(errorMessage(e)))
                              }
                            >
                              <strong>
                                {entry.kind.replaceAll("_", " ")} ·{" "}
                                {entry.complete ? "Verified" : "Incomplete"}
                              </strong>
                              <span>{entry.url}</span>
                              <small>
                                {entry.reference_count} parsed references ·{" "}
                                {entry.body_bytes.toLocaleString()} retained bytes ·{" "}
                                {new Date(entry.fetched_at).toLocaleString()}
                              </small>
                            </button>
                          ))}
                        <p className="subtle">
                          Source hashes describe retained snapshots after shared process redaction,
                          not raw GitHub response bytes. No stale tracker set is treated as current
                          verification.
                        </p>
                      </>
                    ) : (
                      <p>
                        No saved scan yet. Saving and opening this watch do not collect GitHub data.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : !state.error && (state.loading || (state.watchId && state.watches.length > 0)) ? (
            <ListSkeleton label="Opening saved watches" />
          ) : (
            <EmptyState
              icon={<Search size={26} />}
              title="Find your next open-source contribution"
              description="Save a repository, choose your filters, and scan when you want. Inspect claimability and source evidence before starting a task."
              action={
                <>
                  <Button variant="default" onClick={() => setEditor("new")}>
                    <Plus size={14} />
                    Create a watch
                  </Button>
                  <Button variant="ghost" onClick={() => state.setArchived(!state.archived)}>
                    {state.archived ? "Show active watches" : "Show archived watches"}
                  </Button>
                </>
              }
            />
          )}
        </main>
        {showDetails && selected && scan && tab === "Results" && (
          <>
            <ResizeHandle
              label="Issue details width"
              value={detailsWidth}
              onChange={setDetailsWidth}
              min={280}
              max={700}
              reverse
            />
            <div className="watch-details-container" style={{ width: detailsWidth }}>
              <IssueCandidateDetails
                watchId={state.watchId}
                scanId={scan.scan.id}
                issueId={selected}
                revision={`${scan.scan.ended_at || scan.scan.status}:${dispositionRevision}`}
                provisional={provisional}
                startTask={startTask}
                recheck={(id) => void run("scan", [id])}
                close={() => setShowDetails(false)}
                dismissed={() => {
                  setDispositionRevision((value) => value + 1);
                  void state.refresh();
                }}
              />
            </div>
          </>
        )}
      </div>
      {editor && (
        <WatchEditor
          key={`${editor}:${detail?.watch.id || "new"}`}
          snapshot={snapshot}
          initial={
            editor === "edit" && detail
              ? { watch: detail.watch, revision: detail.revision }
              : undefined
          }
          close={() => setEditor(null)}
          saved={(id) => {
            state.select(id);
            setEditor(null);
            void state.refresh();
          }}
        />
      )}
      {selection !== null && (
        <div className="modal-backdrop">
          <section
            className="modal watch-continue-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Continue Analysis"
            ref={dialog}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !busy) setSelection(null);
              containDialogFocus(event);
            }}
          >
            <div className="modal-heading">
              <h2>Continue Analysis</h2>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close continuation"
                onClick={() => setSelection(null)}
              >
                <X size={14} />
              </Button>
            </div>
            <p>
              This is a new explicit attempt with at most one additional {model?.provider}{" "}
              invocation using {model?.model} / {model?.effort}. Trackers and hard facts are fetched
              again; a scoped attempt preserves the full baseline.
            </p>
            <div className="watch-continue-list">
              {pending.map((candidate) => (
                <label key={candidate.issue.id}>
                  <input
                    type="checkbox"
                    checked={selection.includes(candidate.issue.id)}
                    onChange={(event) =>
                      setSelection(
                        event.target.checked
                          ? [...selection, candidate.issue.id]
                          : selection.filter((id) => id !== candidate.issue.id),
                      )
                    }
                  />
                  #{candidate.issue.number} · {candidate.issue.title}
                </label>
              ))}
            </div>
            <p className="subtle">
              {selection.length} selected · At most{" "}
              {detail?.revision.configuration.limits.max_semantic_candidates} semantic candidates
              fit each invocation; packet limits may omit more.
            </p>
            <div className="modal-actions">
              <Button variant="ghost" onClick={() => setSelection(null)}>
                Cancel
              </Button>
              <Button
                variant="default"
                disabled={busy || !selection.length}
                onClick={() => void run("continue", selection)}
              >
                Continue Analysis
              </Button>
            </div>
          </section>
        </div>
      )}
      {source && (
        <div className="modal-backdrop">
          <section
            className="modal watch-source-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Saved source evidence"
            ref={dialog}
            onKeyDown={(event) => {
              if (event.key === "Escape") setSource(null);
              containDialogFocus(event);
            }}
          >
            <div className="modal-heading">
              <h2>Saved {source.kind.replaceAll("_", " ")}</h2>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close source evidence"
                onClick={() => setSource(null)}
              >
                <X size={14} />
              </Button>
            </div>
            <p>{source.url}</p>
            <small>
              Retrieved {new Date(source.fetched_at).toLocaleString()} ·{" "}
              {source.complete ? "Verified" : "Incomplete"} · {source.references.length} references
            </small>
            <IssueMarkdown text={source.text} onError={state.setError} />
            <details>
              <summary>Parsed exclusions and retained digest</summary>
              <code>{source.hash}</code>
              <ul>
                {source.references.map((reference) => (
                  <li key={`${reference.repository}#${reference.number}`}>
                    {reference.repository}#{reference.number}
                  </li>
                ))}
              </ul>
            </details>
          </section>
        </div>
      )}
    </section>
  );
};
