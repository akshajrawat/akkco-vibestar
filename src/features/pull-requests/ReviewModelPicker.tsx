import { useState } from "react";
import { ChevronDown, X } from "lucide-react";

import type { Settings } from "../../../backend/domain";
import {
  supportedEfforts,
  configurationError,
} from "../../../backend/execution/providers/contracts";
import { useProviders } from "../../hooks/useWorkspace";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { containDialogFocus } from "../../lib/keyboard";
import { Button } from "../../components/ui/button";
import { Select } from "../../components/ui/Select";
import { ProviderIcon } from "../../components/ui/ProviderIcon";

type Configuration = Settings["utility_ai"];

const ModelOptions = ({
  value,
  onChange,
  reset,
  close,
}: {
  value: Configuration;
  onChange: (value: Configuration) => void;
  reset: () => void;
  close: () => void;
}) => {
  const { providers, loading } = useProviders();
  const dialog = useDialogFocus();
  const detected = providers.find((entry) => entry.provider === value.provider);
  const efforts = supportedEfforts(detected, value.model);
  const error = detected?.models.length ? configurationError(detected, value) : null;
  return (
    <section
      className="pr-model-options"
      ref={dialog}
      role="dialog"
      aria-label="PR review model"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }

        containDialogFocus(event);
      }}
    >
      <header>
        <strong>Review model</strong>
        <Button size="icon" variant="ghost" aria-label="Close model selector" onClick={close}>
          <X size={14} />
        </Button>
      </header>
      <label>
        Provider
        <Select
          label="Review provider"
          value={value.provider}
          onChange={(provider) => {
            const selected = provider as Configuration["provider"];

            const available = supportedEfforts(
              providers.find((entry) => entry.provider === selected),
              "",
            );

            onChange({
              ...value,
              provider: selected,
              model: "",
              effort: available.includes(value.effort) ? value.effort : available[0] || "medium",
            });
          }}
          options={(["codex", "antigravity"] as const).map((provider) => ({
            value: provider,
            label: provider === "codex" ? "Codex" : "Antigravity",
            icon: <ProviderIcon provider={provider} />,
          }))}
        />
      </label>
      <label>
        Model
        <Select
          label="Review model"
          searchable
          value={value.model}
          onChange={(model) => {
            const available = supportedEfforts(detected, model);

            onChange({
              ...value,
              model,
              effort: available.includes(value.effort)
                ? value.effort
                : available[0] || value.effort,
            });
          }}
          options={[
            { value: "", label: "CLI default" },
            ...(value.model && !detected?.models.some((entry) => entry.id === value.model)
              ? [{ value: value.model, label: value.model }]
              : []),
            ...(detected?.models.map((entry) => ({
              value: entry.id,
              label: entry.label || entry.id,
              icon: <ProviderIcon provider={value.provider} model={entry.id} />,
            })) || []),
          ]}
        />
      </label>
      <label>
        Reasoning
        <Select
          label="Review reasoning"
          value={value.effort}
          onChange={(effort) => onChange({ ...value, effort })}
          options={[...new Set([value.effort, ...efforts])].map((effort) => ({
            value: effort,
            label: effort,
          }))}
        />
      </label>
      <label>
        Time limit
        <Select
          label="Review time limit"
          value={String(value.timeout_secs)}
          onChange={(seconds) => onChange({ ...value, timeout_secs: Number(seconds) })}
          options={[...new Set([value.timeout_secs, 120, 300, 600, 1800])]
            .sort((a, b) => a - b)
            .map((seconds) => ({
              value: String(seconds),
              label: seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} sec`,
            }))}
        />
      </label>
      {loading && <small>Loading available models…</small>}
      {error && <p className="warning">{error}</p>}
      <Button size="sm" variant="ghost" onClick={reset}>
        Use settings default
      </Button>
    </section>
  );
};

export const ReviewModelPicker = ({
  value,
  onChange,
  reset,
}: {
  value: Configuration;
  onChange: (value: Configuration) => void;
  reset: () => void;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="pr-model-control">
      <Button
        size="sm"
        variant="ghost"
        aria-label="Choose PR review model"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={`${value.provider} · ${value.model || "CLI default"} · ${value.effort}`}
      >
        <ProviderIcon provider={value.provider} model={value.model} size={15} />
        <span>{value.model || (value.provider === "codex" ? "Codex" : "Antigravity")}</span>
        <ChevronDown size={12} />
      </Button>
      {open && (
        <ModelOptions
          value={value}
          onChange={onChange}
          reset={() => {
            reset();
            setOpen(false);
          }}
          close={() => setOpen(false)}
        />
      )}
    </div>
  );
};
