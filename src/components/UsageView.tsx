import { useEffect, useState } from "react";
import type { UsageRecord } from "../../backend/execution/usage";
import { rpc, duration, errorMessage, tokenUsage } from "../lib/api";
import { Button } from "./ui/button";
import { useProviders } from "../lib/useWorkspace";
export const UsageView = ({
  taskId,
  records,
}: {
  taskId?: string;
  records?: UsageRecord[];
}) => {
  const [rows, setRows] = useState(records || []);
  const { providers: detections } = useProviders();
  const [days, setDays] = useState(0);
  const [group, setGroup] = useState("Provider");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (records) {
      setRows(records);
      return;
    }
    let alive = true;
    void rpc<UsageRecord[]>("usage.list", {
      task_id: taskId,
      ...(days ? { days } : {}),
    })
      .then((result) => {
        if (alive) {
          setRows(result);
          setError("");
        }
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [taskId, days, revision, records]);
  const runtime = rows.reduce((n, r) => n + (r.duration_ms || 0), 0);
  const fields = {
    Provider: "provider",
    Model: "model",
    Purpose: "purpose",
    Repository: "repository",
    Task: "task_id",
  } as const;
  const field = fields[group as keyof typeof fields];
  const groups = new Map<string, { count: number; runtime: number }>();
  for (const row of rows) {
    const key =
      row[field] ||
      (field === "model" ? "CLI default · model not reported" : "Unlinked");
    const total = groups.get(key) || { count: 0, runtime: 0 };
    groups.set(key, {
      count: total.count + 1,
      runtime: total.runtime + (row.duration_ms || 0),
    });
  }
  const reported = rows.filter((r) => r.total_tokens !== null);
  return (
    <section className="usage-view">
      <div className="page-title">
        <h2>{taskId || records ? "Task usage" : "Local AI usage"}</h2>
        {!records && (
          <Button size="sm" onClick={() => setRevision((v) => v + 1)}>
            Refresh
          </Button>
        )}
      </div>
      {!taskId && !records && (
        <div className="library-tabs">
          {[
            [1, "Today"],
            [7, "7 days"],
            [30, "30 days"],
            [0, "All time"],
          ].map(([value, label]) => (
            <button
              type="button"
              key={value}
              className={days === value ? "selected" : ""}
              onClick={() => setDays(Number(value))}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {error && <p className="error-box">{error}</p>}
      <p>
        <strong>Agent runs: {rows.length}</strong> · Total model runtime:{" "}
        {Math.floor(runtime / 60000)}m {Math.floor(runtime / 1000) % 60}s
      </p>
      <p className="subtle">
        Antigravity subscription allowance: Not exposed by CLI
      </p>
      {detections.find((d) => d.provider === "codex")?.subscriptionLimits ? (
        <div className="usage-breakdown">
          <p>Codex subscription allowance · official CLI report</p>
          {detections
            .find((d) => d.provider === "codex")!
            .subscriptionLimits!.windows.map((w) => (
              <p key={w.windowDurationMins}>
                <span>
                  {w.windowDurationMins >= 1440
                    ? `${w.windowDurationMins / 1440} day`
                    : `${w.windowDurationMins / 60} hour`}{" "}
                  window · {w.usedPercent}% used
                </span>
                <small>
                  Resets {new Date(w.resetsAt * 1000).toLocaleString()}
                </small>
              </p>
            ))}
        </div>
      ) : (
        <p className="subtle">
          Codex subscription allowance: Not exposed by CLI
        </p>
      )}
      {!!reported.length && (
        <p>
          Reported total tokens:{" "}
          {reported.reduce((n, r) => n + r.total_tokens!, 0).toLocaleString()}{" "}
          <small>
            ({reported.length} of {rows.length} runs reported a total)
          </small>
        </p>
      )}
      {!taskId && !records && (
        <>
          <div className="library-tabs">
            {Object.keys(fields).map((name) => (
              <button
                type="button"
                key={name}
                className={name === group ? "selected" : ""}
                onClick={() => setGroup(name)}
              >
                {name}
              </button>
            ))}
          </div>
          <div className="usage-breakdown">
            {[...groups].map(([name, total]) => (
              <p key={name}>
                <span>{name}</span>
                <small>
                  {total.count} runs · {Math.floor(total.runtime / 1000)}s
                </small>
              </p>
            ))}
          </div>
        </>
      )}
      <div className="usage-runs">
        {rows.map((row) => (
          <details key={row.id}>
            <summary>
              <span className={`usage-dot ${row.status}`} />
              <strong>{row.purpose}</strong>
              <span>
                {row.provider} · {row.model || "CLI default"} · {row.effort}
              </span>
              <small>
                {row.duration_ms === null
                  ? row.status
                  : duration(row.started_at, row.ended_at)}
              </small>
            </summary>
            <div>
              <p>
                {new Date(row.started_at).toLocaleString()} · {row.status} ·{" "}
                {row.repository || "No repository"}
              </p>
              <p>Tokens: {tokenUsage(row)}</p>
              {row.error && (
                <p className="failure">{errorMessage(row.error)}</p>
              )}
              {row.subscription_limits && (
                <p className="subtle">
                  Official subscription usage at run start:{" "}
                  {(
                    JSON.parse(row.subscription_limits) as NonNullable<
                      import("../../backend/execution/providers/contracts").ProviderDetection["subscriptionLimits"]
                    >
                  ).windows
                    .map(
                      (w) =>
                        `${w.usedPercent}% of ${w.windowDurationMins} minute window`,
                    )
                    .join(" · ")}
                </p>
              )}
            </div>
          </details>
        ))}
      </div>
      {!rows.length && (
        <p className="empty-row">
          AI runs appear here when Vibestar starts them. Deterministic
          inspections use no model.
        </p>
      )}
      <p className="subtle">
        Usage stays on this device. Token counts come from provider output;
        unreported counts remain unavailable.
      </p>
    </section>
  );
};
