import { useEffect, useState } from "react";
import type { UsageRecord } from "../../backend/execution/usage";
import { rpc, errorMessage, tokenUsage, subscribe, duration } from "../lib/api";
import {
  limitDeltas,
  readLimits,
  windowLabel,
  usageRuntime,
} from "../lib/usage";
import { Button } from "./ui/button";
import { useProviders } from "../lib/useWorkspace";
import { Activity, Search } from "lucide-react";
import { EmptyState, ListSkeleton, PageHeader } from "./ui/PageHeader";
import { UsageCharts } from "./usage/UsageCharts";

export const UsageView = ({
  taskId,
  records,
  runId,
  openRun,
}: {
  taskId?: string;
  records?: UsageRecord[];
  runId?: string;
  openRun?: (row: UsageRecord) => void;
}) => {
  const scoped = !!taskId || !!records;
  const [rows, setRows] = useState(records || []);
  const [selectedRun, setSelectedRun] = useState(runId || "");
  const [expandedRun, setExpandedRun] = useState("");
  const [query, setQuery] = useState("");
  const [loaded, setLoaded] = useState(!!records);
  const [refreshing, setRefreshing] = useState(false);
  const [historyPage, setHistoryPage] = useState({ key: "", index: 0 });
  const { providers, refresh: refreshProviders, loading } = useProviders();
  const [days, setDays] = useState(0);
  const [group, setGroup] = useState("provider");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [info, setInfo] = useState<{ database: string; warning?: string }>();
  const [, tick] = useState(0);
  useEffect(() => {
    void rpc<NonNullable<typeof info>>("usage.info")
      .then(setInfo)
      .catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(() => {
    if (records) {
      setRows(records);
      setLoaded(true);
      setRefreshing(false);
      return;
    }
    let alive = true;
    let fetching = false;
    const fetch = () => {
      if (fetching) return;
      fetching = true;
      setRefreshing(true);
      return rpc<UsageRecord[]>("usage.list", { task_id: taskId })
        .then((r) => {
          if (alive) {
            setRows(r);
            setError("");
            setLoaded(true);
          }
        })
        .catch((e) => {
          if (alive) {
            setError(errorMessage(e));
            setLoaded(true);
          }
        })
        .finally(() => {
          fetching = false;
          if (alive) setRefreshing(false);
        });
    };
    void fetch();
    const timer = setInterval(() => void fetch(), 5000);
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const subscription = subscribe((e) => {
      if (
        ["usage.changed", "changed"].includes(e.event) &&
        (!taskId || !e.task_id || e.task_id === taskId) &&
        !refreshTimer
      )
        refreshTimer = setTimeout(() => {
          refreshTimer = undefined;
          void fetch();
        }, 350);
    });
    return () => {
      alive = false;
      clearInterval(timer);
      if (refreshTimer) clearTimeout(refreshTimer);
      void subscription.then((fn) => fn());
    };
  }, [taskId, revision, records]);
  const running = rows.some((r) => r.status === "running");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const cutoff = days
    ? days === 1
      ? new Date().setHours(0, 0, 0, 0)
      : Date.now() - days * 86400000
    : 0;
  const visible = rows.filter(
    (r) =>
      Date.parse(r.started_at) >= cutoff &&
      (!selectedRun || r.id === selectedRun) &&
      (!query ||
        [r.provider, r.model, r.purpose, r.repository, r.task_id, r.status]
          .join(" ")
          .toLowerCase()
          .includes(query.toLowerCase())) &&
      Object.entries(filters).every(
        ([key, value]) =>
          !value || String(r[key as keyof UsageRecord]) === value,
      ),
  );
  const runtime = visible.reduce((n, r) => n + usageRuntime(r), 0);
  const filterKey = JSON.stringify({ days, selectedRun, query, filters });
  const pageSize = 50;
  const pages = Math.max(1, Math.ceil(visible.length / pageSize));
  const page = Math.min(
    historyPage.key === filterKey ? historyPage.index : 0,
    pages - 1,
  );
  const tokenColumns = (
    [
      "input_tokens",
      "cached_input_tokens",
      "output_tokens",
      "reasoning_tokens",
      "total_tokens",
    ] as const
  ).map((field) => {
    const reported = visible.filter((row) => row[field] != null);
    return {
      field,
      coverage: reported.length,
      total: reported.length
        ? reported.reduce((sum, row) => sum + row[field]!, 0)
        : null,
    };
  });
  const tokenScale = Math.max(
    1,
    ...tokenColumns
      .filter((column) => column.field !== "total_tokens")
      .map((column) => column.total ?? 0),
  );
  const groups = new Map<string, { count: number; runtime: number }>();
  for (const row of visible) {
    const key = String(row[group as keyof UsageRecord] || "Unlinked");
    const value = groups.get(key) || { count: 0, runtime: 0 };
    groups.set(key, {
      count: value.count + 1,
      runtime: value.runtime + usageRuntime(row),
    });
  }
  const latest = [
    providers.find((p) => p.provider === "codex")?.subscriptionLimits,
    ...rows
      .filter((r) => r.provider === "codex")
      .flatMap((r) => [
        readLimits(r.subscription_limits_after),
        readLimits(r.subscription_limits),
      ]),
  ]
    .filter((v) => v !== undefined)
    .sort((a, b) => Date.parse(b.reportedAt) - Date.parse(a.reportedAt))[0];
  const time = (ms: number) =>
    duration(new Date(0).toISOString(), new Date(ms).toISOString());
  return (
    <div className={`usage-panel ${!scoped ? "page usage-dashboard" : ""}`}>
      <PageHeader
        title={taskId ? "Task usage" : "Local AI usage"}
        description="Observed runtime, provider-reported tokens and official subscription snapshots."
        actions={
          <Button
            size="sm"
            onClick={() => {
              setRevision((n) => n + 1);
              void refreshProviders();
            }}
            busy={loading || refreshing}
          >
            Refresh
          </Button>
        }
      />
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      {info?.warning && <p className="warning">{info.warning}</p>}
      {!loaded && <ListSkeleton label="Loading usage records" />}
      {rows.length > 0 && (
        <>
          {taskId && (
            <label className="usage-run-select">
              Run{" "}
              <select
                aria-label="Usage run"
                value={selectedRun}
                onChange={(e) => setSelectedRun(e.target.value)}
              >
                <option value="">All task runs</option>
                {rows.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.purpose} · {r.provider} · {r.model || "CLI default"}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!scoped && (
            <>
              <div className="library-tabs">
                {[
                  [1, "Today"],
                  [7, "7 days"],
                  [30, "30 days"],
                  [0, "All time"],
                ].map(([v, label]) => (
                  <button
                    type="button"
                    key={v}
                    className={days === v ? "selected" : ""}
                    onClick={() => setDays(Number(v))}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="usage-filters">
                {(
                  [
                    "provider",
                    "model",
                    "purpose",
                    "repository",
                    "task_id",
                    "status",
                  ] as const
                ).map((key) => (
                  <label key={key}>
                    {key === "task_id" ? "Task" : key}
                    <select
                      aria-label={`Usage ${key} filter`}
                      value={filters[key] || ""}
                      onChange={(e) =>
                        setFilters({ ...filters, [key]: e.target.value })
                      }
                    >
                      <option value="">All</option>
                      {[...new Set(rows.map((r) => String(r[key] || "")))]
                        .filter(Boolean)
                        .sort()
                        .map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                    </select>
                  </label>
                ))}
              </div>
            </>
          )}
          <div className="usage-stats">
            <div>
              <small>Reported total tokens</small>
              <strong>
                {visible.some((row) => row.total_tokens !== null)
                  ? visible
                      .reduce((sum, row) => sum + (row.total_tokens ?? 0), 0)
                      .toLocaleString()
                  : "Unavailable"}
              </strong>
              <small>
                {visible.filter((row) => row.total_tokens !== null).length}/
                {visible.length} runs reported totals
              </small>
            </div>
            <div>
              <small>AI runs</small>
              <strong>{visible.length}</strong>
            </div>
            <div>
              <small>Total model runtime</small>
              <strong>{time(runtime)}</strong>
            </div>
            <div>
              <small>Failures</small>
              <strong
                className={
                  visible.some((r) => r.status === "failed") ? "failure" : ""
                }
              >
                {visible.filter((r) => r.status === "failed").length}
              </strong>
            </div>
            <div>
              <small>Cancelled / interrupted</small>
              <strong>
                {
                  visible.filter((r) =>
                    ["cancelled", "interrupted"].includes(r.status),
                  ).length
                }
              </strong>
            </div>
          </div>
          <div className="usage-tokens" aria-label="Reported token channels">
            {tokenColumns.map(({ field, total, coverage }) => {
              const label = {
                input_tokens: "Input",
                cached_input_tokens: "Cached",
                output_tokens: "Output",
                reasoning_tokens: "Reasoning",
                total_tokens: "Total",
              }[field];
              return (
                <div key={field}>
                  <small>{label}</small>
                  <strong>{total?.toLocaleString() ?? "Unavailable"}</strong>
                  {field !== "total_tokens" && (
                    <div
                      className={`token-channel-track ${total === null ? "unavailable" : ""}`}
                      role="img"
                      aria-label={`${label}: ${total?.toLocaleString() ?? "Unavailable"} tokens · ${coverage}/${visible.length} runs reported`}
                    >
                      <span
                        style={{
                          width: `${((total ?? 0) / tokenScale) * 100}%`,
                        }}
                      />
                    </div>
                  )}
                  <small>
                    {coverage}/{visible.length} runs reported
                  </small>
                </div>
              );
            })}
          </div>
          {visible.length > 0 && (
            <small className="subtle">
              Each token column sums only reported values. Coverage can differ
              between columns; missing totals are not calculated. Bars compare
              reported values on a common scale. Cached and reasoning channels
              can overlap other channels.
            </small>
          )}
          {!scoped && <UsageCharts rows={visible} />}
          {!scoped && (
            <section className="allowance-panel">
              <div className="section-heading">
                <strong>
                  Codex · latest official allowance
                  {latest?.planType ? ` · ${latest.planType}` : ""}
                </strong>
              </div>
              {latest ? (
                <>
                  {latest.windows.map((w) => (
                    <div
                      className={`allowance-window ${w.usedPercent >= 100 ? "failure" : w.usedPercent >= 80 ? "warning" : ""}`}
                      key={w.windowDurationMins}
                    >
                      <span>{windowLabel(w.windowDurationMins)}</span>
                      <progress
                        max={100}
                        value={w.usedPercent}
                        aria-label={`${windowLabel(w.windowDurationMins)} usage`}
                      />
                      <strong>{w.usedPercent}% used</strong>
                      <small>
                        Resets {new Date(w.resetsAt * 1000).toLocaleString()}
                      </small>
                    </div>
                  ))}
                  <small className="subtle">
                    Reported {new Date(latest.reportedAt).toLocaleString()}
                  </small>
                </>
              ) : (
                <p className="subtle">
                  Subscription allowance: Not exposed by CLI or currently
                  unavailable.
                </p>
              )}
              <p className="subtle">
                Antigravity · Subscription allowance not exposed by CLI
              </p>
            </section>
          )}
          {!scoped && (
            <details className="usage-additional">
              <summary>Additional breakdowns</summary>
              <div className="library-tabs">
                {["provider", "model", "purpose", "repository", "task_id"].map(
                  (key) => (
                    <button
                      type="button"
                      key={key}
                      className={group === key ? "selected" : ""}
                      onClick={() => setGroup(key)}
                    >
                      {key === "task_id" ? "Task" : key}
                    </button>
                  ),
                )}
              </div>
              <div className="usage-breakdown">
                {[...groups].map(([key, value]) => (
                  <div key={key}>
                    <strong>{key}</strong>
                    <span>
                      {value.count} runs · {time(value.runtime)}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}
          {!scoped && (
            <section className="usage-history">
              <div className="section-heading">
                <h2>Run history</h2>
                <label className="search-field">
                  <Search size={14} />
                  <input
                    aria-label="Search usage runs"
                    placeholder="Search runs…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
              </div>
              <div className="data-table-scroll">
                <table className="usage-table">
                  <thead>
                    <tr>
                      {[
                        "Provider / model",
                        "Purpose",
                        "Repository",
                        "Task",
                        "Duration",
                        "Reported tokens",
                        "Result",
                        "Started",
                      ].map((label) => (
                        <th key={label} scope="col">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visible
                      .slice(page * pageSize, (page + 1) * pageSize)
                      .map((row) => (
                        <tr key={row.id}>
                          <td>
                            <button
                              className="table-run-link"
                              onClick={() =>
                                setExpandedRun(
                                  expandedRun === row.id ? "" : row.id,
                                )
                              }
                              aria-expanded={expandedRun === row.id}
                            >
                              {row.provider}
                              <small>{row.model || "CLI default"}</small>
                            </button>
                          </td>
                          <td>{row.purpose}</td>
                          <td>{row.repository || "Unlinked"}</td>
                          <td>
                            {row.task_id ||
                              (row.repair_id ? "PR repair" : "Unlinked")}
                          </td>
                          <td>{time(usageRuntime(row))}</td>
                          <td title={tokenUsage(row)}>
                            {row.total_tokens?.toLocaleString() ??
                              "Unavailable"}
                          </td>
                          <td>
                            <span
                              className={`status-chip ${row.status === "completed" ? "success" : row.status === "failed" ? "failure" : "warning"}`}
                            >
                              {row.status}
                            </span>
                          </td>
                          <td>{new Date(row.started_at).toLocaleString()}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <nav
                className="usage-pagination"
                aria-label="Usage history pages"
              >
                <small>
                  {visible.length
                    ? `Showing ${page * pageSize + 1}–${Math.min((page + 1) * pageSize, visible.length)} of ${visible.length} runs`
                    : "No matching runs"}{" "}
                  · Page {page + 1} of {pages}
                </small>
                <div className="actions">
                  <Button
                    size="sm"
                    disabled={page === 0}
                    onClick={() =>
                      setHistoryPage({ key: filterKey, index: page - 1 })
                    }
                  >
                    Previous runs
                  </Button>
                  <Button
                    size="sm"
                    disabled={page + 1 >= pages}
                    onClick={() =>
                      setHistoryPage({ key: filterKey, index: page + 1 })
                    }
                  >
                    Next runs
                  </Button>
                </div>
              </nav>
            </section>
          )}
          <div className="usage-runs">
            {visible
              .filter((row) => scoped || row.id === expandedRun)
              .map((row) => (
                <details
                  className="usage-run"
                  key={row.id}
                  open={!scoped ? true : undefined}
                >
                  <summary>
                    <div>
                      <strong>{row.purpose}</strong>
                      <small>
                        {row.provider} · {row.model || "CLI default"} ·{" "}
                        {row.effort}
                      </small>
                    </div>
                    <span>{time(usageRuntime(row))}</span>
                    <span
                      className={`status-chip ${row.status === "completed" ? "success" : row.status === "failed" ? "failure" : row.status === "running" ? "running" : "warning"}`}
                    >
                      {row.status}
                    </span>
                  </summary>
                  {openRun && (row.task_id || row.repair_id) && (
                    <Button size="sm" onClick={() => openRun(row)}>
                      Open saved run
                    </Button>
                  )}
                  <dl className="repository-facts">
                    <dt>Started</dt>
                    <dd>{new Date(row.started_at).toLocaleString()}</dd>
                    <dt>Finished</dt>
                    <dd>
                      {row.ended_at
                        ? new Date(row.ended_at).toLocaleString()
                        : "Running"}
                    </dd>
                    <dt>Runtime</dt>
                    <dd>{time(usageRuntime(row))}</dd>
                    <dt>Provider / model</dt>
                    <dd>
                      {row.provider} · {row.model || "CLI default"} ·{" "}
                      {row.effort}
                    </dd>
                    <dt>Purpose</dt>
                    <dd>{row.purpose}</dd>
                    <dt>Repository</dt>
                    <dd>{row.repository || "Unlinked"}</dd>
                    <dt>Task</dt>
                    <dd>{row.task_id || "Unlinked"}</dd>
                    <dt>Run ID</dt>
                    <dd>
                      <code>{row.id}</code>
                    </dd>
                    <dt>Session</dt>
                    <dd>{row.provider_session_id || "Not reported"}</dd>
                    <dt>Tokens</dt>
                    <dd>{tokenUsage(row)}</dd>
                  </dl>
                  {row.error && (
                    <details>
                      <summary className="failure">Run error · details</summary>
                      <pre>{errorMessage(row.error)}</pre>
                    </details>
                  )}
                  {(
                    [
                      "subscription_limits",
                      "subscription_limits_after",
                    ] as const
                  ).map((key) => {
                    const limits = readLimits(row[key]);
                    return (
                      limits && (
                        <div key={key}>
                          <strong>
                            {key === "subscription_limits"
                              ? "Allowance before run"
                              : "Allowance after run"}
                            {limits.planType ? ` · ${limits.planType}` : ""}
                          </strong>
                          {limits.windows.map((w) => (
                            <p key={w.windowDurationMins}>
                              {windowLabel(w.windowDurationMins)} ·{" "}
                              {w.usedPercent}% used · resets{" "}
                              {new Date(w.resetsAt * 1000).toLocaleString()}
                            </p>
                          ))}
                        </div>
                      )
                    );
                  })}
                  {limitDeltas(row).map((w) => (
                    <p key={w.minutes}>
                      Subscription window usage delta ({windowLabel(w.minutes)}
                      ): {w.delta >= 0 ? "+" : ""}
                      {w.delta} percentage points ({w.before}% → {w.after}%).
                      Shared account activity can also affect this window.
                    </p>
                  ))}
                  {row.provider === "codex" && !limitDeltas(row).length && (
                    <small className="subtle">
                      Window delta unavailable · both snapshots must describe
                      the same subscription window.
                    </small>
                  )}
                  {row.provider === "antigravity" && (
                    <small className="subtle">
                      Subscription allowance not exposed by CLI
                    </small>
                  )}
                </details>
              ))}
          </div>
        </>
      )}
      {!visible.length && loaded && (
        <EmptyState
          icon={<Activity size={26} />}
          title={
            taskId
              ? "No AI usage recorded for this task yet."
              : rows.length
                ? "No runs match these filters."
                : "No AI usage recorded in this data root yet."
          }
          description="Your provider invocations will appear here with observed runtime and the token fields they report."
          action={
            rows.length > 0 ? (
              <Button
                onClick={() => {
                  setFilters({});
                  setQuery("");
                  setDays(0);
                  setSelectedRun("");
                }}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      )}
      <small className="subtle usage-source">
        Local telemetry only · no analytics sent
        {info?.database ? ` · Database: ${info.database}` : ""}
      </small>
    </div>
  );
};
