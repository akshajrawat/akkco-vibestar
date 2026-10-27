import { useRef, useState } from "react";

import type { Settings } from "../../../backend/domain";
import { rpc, errorMessage } from "../../lib/api";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { useProviders } from "../../hooks/useWorkspace";
import { containDialogFocus } from "../../lib/keyboard";
import { AgentConfiguration } from "../providers/StageSettings";
import { Button } from "../../components/ui/button";
import { Select } from "../../components/ui/Select";
import { ProviderIcon } from "../../components/ui/ProviderIcon";

export const PRBatchDialog = ({
  rows,
  configuration,
  close,
  refresh,
}: {
  rows: {
    url: string;
    title: string;
    state: string;
    jobId?: string;
    attention: boolean;
    stale: boolean;
  }[];
  configuration: Settings["utility_ai"];
  close: () => void;
  refresh: () => Promise<void>;
}) => {
  const [scope, setScope] = useState<"open" | "attention" | "stale" | "selected">("open");

  const [selected, setSelected] = useState(
    rows
      .filter((row) => row.state === "OPEN")
      .slice(0, 5)
      .map((row) => row.url),
  );

  const [model, setModel] = useState(configuration);
  const [cap, setCap] = useState(5);

  const [preview, setPreview] = useState<{
    job_ids: string[];
    reusable: number;
    checked_at: string;
  }>();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef({ signature: "", id: "" });
  const dialog = useDialogFocus();
  const { providers } = useProviders();

  const visible = rows.filter(
    (row) =>
      scope === "selected" ||
      (scope === "open" ? row.state === "OPEN" : scope === "attention" ? row.attention : row.stale),
  );

  const inspect = async () => {
    setBusy(true);
    setError("");
    try {
      const ids = [];
      for (const url of selected) {
        const row = rows.find((row) => row.url === url)!;

        const job = row.jobId
          ? { id: row.jobId }
          : await rpc<{ id: string }>("scheduled.add", {
              url,
              task_id: null,
              interval_minutes: 60,
              verify_codex: false,
            });

        ids.push(job.id);
      }

      const result = await rpc<{ reusable: number; checked_at: string }>(
        "scheduled.batch.preview",
        { job_ids: ids, scope },
      );

      setPreview({ ...result, job_ids: ids });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const params = {
        job_ids: preview.job_ids,
        scope,
        max_analyses: cap,
        configuration: {
          provider: model.provider,
          config: {
            model: model.model,
            effort: model.effort,
            timeout_secs: model.timeout_secs,
          },
        },
        confirmed: true,
      };

      const signature = JSON.stringify(params);
      if (signature !== request.current.signature)
        request.current = { signature, id: crypto.randomUUID() };

      await rpc("scheduled.batch.start", {
        ...params,
        request_id: request.current.id,
      });

      await refresh();
      close();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <section
        ref={dialog}
        className="modal pr-batch-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Analyze All"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) close();
          containDialogFocus(event);
        }}
      >
        <h2>Analyze All</h2>
        <p>Select up to 20 PRs. The default batch contains at most five.</p>
        <fieldset disabled={busy}>
          <label>
            Scope
            <Select
              label="Scope"
              value={scope}
              onChange={(selection) => {
                const value = selection as typeof scope;
                setScope(value);
                setPreview(undefined);

                setSelected(
                  rows
                    .filter(
                      (row) =>
                        value === "selected" ||
                        (value === "open"
                          ? row.state === "OPEN"
                          : value === "attention"
                            ? row.attention
                            : row.stale),
                    )
                    .slice(0, 5)
                    .map((row) => row.url),
                );
              }}
              options={[
                { value: "open", label: "Open" },
                { value: "attention", label: "Needs attention" },
                { value: "stale", label: "Stale" },
                { value: "selected", label: "Selected" },
              ]}
            />
          </label>

          <div className="batch-selection">
            {visible.map((row) => (
              <label className="checkbox-label" key={row.url}>
                <input
                  type="checkbox"
                  checked={selected.includes(row.url)}
                  disabled={!selected.includes(row.url) && selected.length >= 20}
                  onChange={(event) => {
                    setSelected(
                      event.target.checked
                        ? [...selected, row.url]
                        : selected.filter((url) => url !== row.url),
                    );

                    setPreview(undefined);
                  }}
                />

                <span>
                  {row.title}
                  <small>{row.url.replace("https://github.com/", "")}</small>
                </span>
              </label>
            ))}
          </div>

          <p>
            {selected.length} PRs selected ·{" "}
            {preview
              ? `${preview.reusable} unchanged reports reusable at ${new Date(preview.checked_at).toLocaleTimeString()}`
              : "Inspect to count reusable unchanged reports."}
          </p>

          <label>
            Maximum AI analyses authorized
            <input
              type="number"
              min={0}
              max={20}
              value={cap}
              onChange={(event) => setCap(Number(event.target.value))}
            />
          </label>

          <label>
            Utility provider
            <Select
              label="Utility provider"
              value={model.provider}
              onChange={(provider) =>
                setModel({
                  ...model,
                  provider: provider as typeof model.provider,
                  model: "",
                })
              }
              options={["codex", "antigravity"].map((value) => ({
                value,
                label: value === "codex" ? "Codex" : "Antigravity",
                icon: <ProviderIcon provider={value} />,
              }))}
            />
          </label>

          <AgentConfiguration
            id="pr-batch-model"
            label="Utility model and effort"
            provider={model.provider}
            config={model}
            providers={providers}
            onChange={(config) => setModel({ ...config, provider: model.provider })}
          />
        </fieldset>

        <p className="subtle">
          Each PR is refreshed before analysis. Reuse is checked again; changed evidence can require
          AI within your cap. Cancellation keeps completed reports.
        </p>
        {busy && <p role="status">Inspecting GitHub or starting the authorized batch…</p>}
        {error && (
          <p className="error-box" role="alert">
            {error}
          </p>
        )}

        <div className="modal-actions">
          <Button variant="ghost" disabled={busy} onClick={close}>
            Cancel
          </Button>

          <Button disabled={busy || !selected.length} onClick={() => void inspect()}>
            Inspect selection · no AI
          </Button>

          <Button
            variant="default"
            disabled={busy || !preview || cap < 0 || cap > 20 || !Number.isInteger(cap)}
            onClick={() => void start()}
          >
            Start Analyze All
          </Button>
        </div>
      </section>
    </div>
  );
};
