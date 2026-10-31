import { useEffect, useState } from "react";
import { ChevronLeft, History, Plus, Search, Square, X } from "lucide-react";

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
import { ProviderIcon } from "../../components/ui/ProviderIcon";
import { Select } from "../../components/ui/Select";
import { WatchActions } from "./WatchActions";
import { WatchList } from "./WatchList";

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

  const [discoveryOrder, setDiscoveryOrder] = useState<"newest" | "oldest">(() =>
    localStorage.getItem("vibestar.issueWatch.discoveryOrder") === "oldest" ? "oldest" : "newest",
  );

  const [overview, setOverview] = useState(!initialWatchId);
  const [showDetails, setShowDetails] = useState(true);

  const [detailsWidth, setDetailsWidth] = usePaneSize("issueWatch.detailsWidth", 430, 360, 700);
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
  const showingPrevious = !!active && scan?.scan.id === active.id && !!detail?.baseline;

  const candidates = showingPrevious
    ? detail?.results || emptyCandidates
    : scan?.candidates || detail?.results || emptyCandidates;

  const resultsScanId = showingPrevious ? detail?.baseline?.id : scan?.scan.id;
  const model = detail?.revision.configuration.model;
  const unsupported = model && !detail?.provider_support[model.provider]?.supported;

  const provisional =
    !showingPrevious && !!scan && scan.scan.status !== "completed" && !scan.scan.batch?.complete;

  useEffect(() => {
    if (
      selected &&
      !candidates.some(
        (candidate) =>
          candidate.issue.id === selected && (showDismissed || !candidate.dismissed_at),
      )
    )
      setSelected("");
  }, [candidates, selected, showDismissed]);

  useEffect(() => {
    if (initialWatchId) setOverview(false);
  }, [initialWatchId]);

  const openWatch = (id: string) => {
    state.select(id);
    setSelected("");
    setTab("Results");
    setOverview(false);
  };

  const run = async (
    kind: "scan" | "retry" | "continue" = "scan",
    ids?: string[],
    next = false,
  ) => {
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
              ...(!ids ? { order: next ? scan?.scan.batch?.order : discoveryOrder } : {}),
              ...(next ? { after_scan_id: scan?.scan.id } : {}),
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
    (candidate) =>
      candidate.eligible &&
      ["pending", "unavailable", "invalid"].includes(candidate.semantic_state),
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
      {!overview && (
        <div className="watch-back">
          <Button variant="ghost" size="sm" onClick={() => setOverview(true)}>
            <ChevronLeft size={14} /> All watches
          </Button>
        </div>
      )}
      <PageHeader
        className="watch-page-heading"
        title={overview ? "Issue Watch" : detail?.watch.name || "Opening watch…"}
        description={
          overview
            ? "Find your next contribution. Your topics, repositories and saved results."
            : detail?.watch.repository.full_name || "Loading saved results…"
        }
        actions={
          overview ? (
            <Button variant="default" onClick={() => setEditor("new")}>
              <Plus size={14} /> New watch
            </Button>
          ) : detail ? (
            <>
              <WatchActions
                disabled={!!active || busy}
                archived={detail.watch.archived}
                edit={() => setEditor("edit")}
                archive={() => void organize()}
              />
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
                  <Search size={14} /> Scan now
                </Button>
              )}
            </>
          ) : undefined
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

      {overview ? (
        state.loading ? (
          <ListSkeleton label="Loading saved watches" />
        ) : (
          <WatchList
            watches={state.watches}
            archived={state.archived}
            setArchived={state.setArchived}
            open={openWatch}
            create={() => setEditor("new")}
            more={state.moreWatches}
            loadMore={state.loadWatches}
          />
        )
      ) : (
        <div className="watch-layout">
          <main className="watch-discovery">
            {detail ? (
              <>
                <div className="watch-effective-model">
                  <ProviderIcon
                    provider={model?.provider || "codex"}
                    model={model?.model}
                    size={14}
                  />
                  <span>
                    {model?.provider === "codex" ? "Codex" : "Antigravity"} · May use subscription
                    allowance
                  </span>
                  <details className="watch-scan-info">
                    <summary>Scan settings</summary>
                    <div>
                      <p>
                        {model?.model} · {model?.effort} reasoning · {model?.timeout_secs}s
                      </p>
                      <p>
                        Up to one AI screening request. Private GitHub content is shared with this
                        provider.
                      </p>
                      {scan?.run && (
                        <small>
                          Selected attempt · {scan.run.provider} / {scan.run.model} /{" "}
                          {scan.run.effort} · {scan.run.status}
                        </small>
                      )}
                    </div>
                  </details>
                </div>

                {unsupported && (
                  <p className="error-box">{detail.provider_support[model!.provider].reason}</p>
                )}

                <div className="watch-batch-controls">
                  <Select
                    label="Discovery order"
                    value={discoveryOrder}
                    disabled={!!active || busy}
                    onChange={(value) => {
                      const order = value === "oldest" ? "oldest" : "newest";
                      setDiscoveryOrder(order);
                      localStorage.setItem("vibestar.issueWatch.discoveryOrder", order);
                    }}
                    options={[
                      { value: "newest", label: "Newest issues first" },
                      { value: "oldest", label: "Oldest issues first" },
                    ]}
                  />
                  <span>10 issues per batch · saved results are kept</span>
                  {scan?.scan.batch?.next_page && scan.scan.batch.order === discoveryOrder && (
                    <Button
                      size="sm"
                      disabled={busy || !!active || !!unsupported || detail.watch.archived}
                      onClick={() => void run("scan", undefined, true)}
                    >
                      Next 10
                    </Button>
                  )}
                </div>

                {active && (
                  <section className="watch-progress" role="status" aria-live="polite">
                    <span className="watch-pulse" />
                    <div>
                      <strong>{active.phase}</strong>
                      <p>
                        {active.coverage.discovered} discovered · {active.coverage.checked}{" "}
                        inspected · {active.coverage.excluded} excluded · {active.coverage.requests}{" "}
                        GitHub requests
                      </p>

                      <small>
                        {active.semantic_attempts
                          ? "AI screening requested · Usage records reported consumption."
                          : "AI not started"}
                        {showingPrevious ? " · Showing previous complete results" : ""}
                      </small>
                    </div>
                  </section>
                )}

                <div className="watch-history-toolbar">
                  <label>
                    <History size={13} />
                    <span className="sr-only">Scan history</span>
                    <Select
                      label="Scan history"
                      value={state.scanId}
                      searchable
                      onChange={(id) => {
                        state.setScanId(id);
                        setSelected("");
                      }}
                      options={[
                        { value: "", label: "Latest attempt" },
                        ...state.history.map((attempt) => ({
                          value: attempt.id,
                          label: `${new Date(attempt.started_at).toLocaleString()} · ${attempt.status}`,
                          description: `Criteria revision ${attempt.revision}`,
                        })),
                      ]}
                    />
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
                </div>

                {scan && !active && (
                  <section
                    className={`watch-coverage-banner ${scan.scan.status === "completed" ? "complete" : "partial"}`}
                    role="status"
                  >
                    <strong>
                      {scan.scan.batch?.complete && scan.scan.status === "partial"
                        ? `Batch ${scan.scan.batch.page} complete · more repository coverage remains`
                        : scan.scan.status === "completed"
                          ? "Scan complete"
                          : `${scan.scan.status.replaceAll("_", " ")} · Coverage is incomplete`}
                    </strong>

                    <details className="watch-scan-evidence">
                      <summary>Coverage and usage</summary>
                      <p>
                        {scan.scan.coverage.checked} issues checked of{" "}
                        {scan.scan.coverage.search_total ?? "unknown"} search results ·{" "}
                        {scan.scan.coverage.excluded} hard exclusions ·{" "}
                        {scan.scan.coverage.requests} GitHub requests
                      </p>
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
                    </details>
                    {scan.scan.error && <p>{scan.scan.error}</p>}

                    {scan.scan.status === "partial" && pending.length > 0 && (
                      <Button
                        size="sm"
                        disabled={busy || !!unsupported}
                        onClick={() =>
                          setSelection(
                            pending
                              .slice(
                                0,
                                Math.min(
                                  10,
                                  detail.revision.configuration.limits.max_semantic_candidates,
                                ),
                              )
                              .map((candidate) => candidate.issue.id),
                          )
                        }
                      >
                        Continue Analysis · choose candidates
                      </Button>
                    )}

                    {["failed", "blocked", "cancelled", "interrupted"].includes(
                      scan.scan.status,
                    ) && (
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
                        discoveryOrder={scan?.scan.batch?.order}
                        selected={selected}
                        onSelect={(id) => {
                          if (
                            candidates.find((candidate) => candidate.issue.id === id)?.dismissed_at
                          )
                            setShowDismissed(true);
                          setSelected(id);
                          setShowDetails(true);
                        }}
                        provisional={provisional}
                        showDismissed={showDismissed}
                        status={showingPrevious ? "completed" : active?.status || scan?.scan.status}
                        onError={state.setError}
                      />
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
                      <p>
                        New matches use stored completed scan history. The issue creation date is
                        separate. Vibestar never claims or assigns issues.
                      </p>
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
                            Source hashes describe retained snapshots after shared process
                            redaction, not raw GitHub response bytes. No stale tracker set is
                            treated as current verification.
                          </p>
                        </>
                      ) : (
                        <p>
                          No saved scan yet. Saving and opening this watch do not collect GitHub
                          data.
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

          {showDetails && selected && resultsScanId && tab === "Results" && (
            <>
              <ResizeHandle
                label="Issue details width"
                value={detailsWidth}
                onChange={setDetailsWidth}
                min={360}
                max={700}
                reverse
              />

              <div className="watch-details-container" style={{ width: detailsWidth }}>
                <IssueCandidateDetails
                  watchId={state.watchId}
                  scanId={resultsScanId}
                  issueId={selected}
                  revision={`${resultsScanId}:${scan?.scan.ended_at || scan?.scan.status}:${dispositionRevision}`}
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
      )}

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
            openWatch(id);
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
