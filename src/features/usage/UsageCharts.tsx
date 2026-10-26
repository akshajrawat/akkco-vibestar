import { useState } from "react";

import type { UsageRecord } from "../../../backend/execution/output/usage";
import { usageRuntime } from "../../lib/usage";

export const UsageCharts = ({ rows }: { rows: UsageRecord[] }) => {
  const [focused, setFocused] = useState({ tokens: "", runs: "" });
  const days = new Map<string, { runs: number; tokens: number; reported: number }>();
  const models = new Map<string, number>();
  const tasks = new Map<string, number>();
  for (const row of rows) {
    const day = row.started_at.slice(0, 10);
    const value = days.get(day) || { runs: 0, tokens: 0, reported: 0 };

    days.set(day, {
      runs: value.runs + 1,
      tokens: value.tokens + (row.total_tokens ?? 0),
      reported: value.reported + Number(row.total_tokens !== null),
    });

    const model = `${row.provider} · ${row.model || "CLI default"}`;
    models.set(model, (models.get(model) || 0) + usageRuntime(row));
    const task = row.task_id || (row.repair_id ? `Repair ${row.repair_id}` : "Unlinked runs");
    tasks.set(task, (tasks.get(task) || 0) + usageRuntime(row));
  }

  const daily = [...days].sort(([a], [b]) => a.localeCompare(b)).slice(-30);
  return (
    <div className="usage-charts">
      {(["tokens", "runs"] as const).map((field) => {
        const max = Math.max(1, ...daily.map(([, value]) => value[field]));
        return (
          <figure className="analytics-chart" key={field}>
            <figcaption>
              <strong>
                {field === "tokens" ? "Daily reported tokens" : "Run count over time"}
              </strong>
              <small>Latest 30 active dates · UTC</small>
            </figcaption>

            <div
              className="chart-bars"
              role="group"
              aria-label={field === "tokens" ? "Daily reported token totals" : "Daily run counts"}
            >
              {daily.map(([day, value]) => {
                const available = field === "runs" || value.reported > 0;
                const label = `${day}: ${available ? value[field].toLocaleString() : "Unavailable"} ${field}${field === "tokens" ? ` · ${value.reported}/${value.runs} runs reported totals` : ""}`;
                return (
                  <button
                    type="button"
                    key={day}
                    aria-label={label}
                    title={label}
                    onFocus={() => setFocused((current) => ({ ...current, [field]: label }))}
                    onMouseEnter={() => setFocused((current) => ({ ...current, [field]: label }))}
                    onBlur={() => setFocused((current) => ({ ...current, [field]: "" }))}
                    onMouseLeave={() => setFocused((current) => ({ ...current, [field]: "" }))}
                  >
                    <span
                      className={available ? "chart-bar" : "chart-bar unavailable"}
                      style={{
                        height: `${available ? Math.max(2, (value[field] / max) * 100) : 2}%`,
                      }}
                    />
                  </button>
                );
              })}
            </div>

            <div className="chart-axis">
              <span>{daily[0]?.[0]}</span>
              <span>{daily.at(-1)?.[0]}</span>
            </div>

            <p className="chart-tooltip" aria-live="polite">
              {focused[field] ||
                (field === "tokens"
                  ? "Provider totals only; missing totals remain unavailable."
                  : "Hover or focus a bar for the exact count.")}
            </p>
          </figure>
        );
      })}

      {(
        [
          ["Runtime by provider / model", models],
          ["Task runtime distribution", tasks],
        ] as const
      ).map(([label, values]) => {
        const sorted = [...values].sort((a, b) => b[1] - a[1]).slice(0, 8);
        const max = Math.max(1, ...sorted.map(([, value]) => value));
        return (
          <figure className="analytics-chart" key={label}>
            <figcaption>
              <strong>{label}</strong>
              <small>Top 8 by observed runtime</small>
            </figcaption>

            <div className="runtime-chart">
              {sorted.map(([key, value]) => (
                <div key={key} title={`${key}: ${value.toLocaleString()} ms`}>
                  <span>{key}</span>
                  <strong>
                    {(value / 60000).toLocaleString(undefined, {
                      maximumFractionDigits: 1,
                    })}{" "}
                    min
                  </strong>

                  <div className="runtime-track">
                    <i style={{ width: `${(value / max) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </figure>
        );
      })}
    </div>
  );
};
