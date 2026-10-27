import { useEffect, useRef, useState } from "react";

import type { Task, StageConfig } from "../../lib/types";
import { defaultSettings } from "../../../backend/domain";
import {
  supportedEfforts,
  configurationError,
} from "../../../backend/execution/providers/contracts";
import { useProviders } from "../../hooks/useWorkspace";
import { useTaskView, updateTaskView } from "../../lib/taskView";
import { Button } from "../../components/ui/button";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { containDialogFocus } from "../../lib/keyboard";
import { ProviderIcon } from "../../components/ui/ProviderIcon";
import { Select } from "../../components/ui/Select";

export const followupConfiguration = (task: Task, view: ReturnType<typeof useTaskView>) => {
  const defaults = task.execution_settings || defaultSettings;

  const config =
    view.followupProvider === "codex" ? defaults.codex_implementation : defaults.antigravity;

  return {
    provider: view.followupProvider,
    config: {
      ...config,
      model: view.followupModel ?? config.model,
      effort: view.followupEffort ?? config.effort,
    },
  };
};

export const ComposerSettings = ({ task }: { task: Task }) => {
  const view = useTaskView(task.id);
  const { provider, config } = followupConfiguration(task, view);
  const { providers, loading, refresh } = useProviders();
  const [open, setOpen] = useState(false);
  const dialog = useDialogFocus(open);
  const container = useRef<HTMLDivElement>(null);
  const detected = providers.find((p) => p.provider === provider);
  const efforts = supportedEfforts(detected, config.model);

  const update = (value: Partial<StageConfig>) =>
    updateTaskView(task.id, {
      ...(value.model !== undefined ? { followupModel: value.model } : {}),
      ...(value.effort !== undefined ? { followupEffort: value.effort } : {}),
    });

  useEffect(() => {
    if (!open) return;

    const dismiss = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [open]);

  return (
    <div
      className="composer-settings"
      ref={container}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <Button
        variant="ghost"
        size="sm"
        aria-label="Choose chat model"
        title="Choose provider, model and reasoning"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ProviderIcon provider={provider} model={config.model} />
        {provider === "codex" ? "Codex" : "Antigravity"} ·{" "}
        {detected?.models.find((m) => (config.model ? m.id === config.model : m.isDefault))
          ?.label ||
          config.model ||
          "CLI default"}
      </Button>

      {open && (
        <section
          ref={dialog}
          className="model-picker"
          role="dialog"
          aria-modal="true"
          aria-label="Chat model configuration"
          onKeyDown={containDialogFocus}
        >
          <h2>Conversation model</h2>
          <p className="subtle">
            Ask keeps the workspace read-only. Work follows the task’s approval gates.
          </p>

          <small
            className={
              detected?.installed === false || detected?.connected === false ? "warning" : "subtle"
            }
          >
            {!detected
              ? "Discover models to confirm CLI and account availability."
              : detected.installed === false
                ? "Official CLI is not installed."
                : detected.connected === false
                  ? "Account is disconnected. Connect it before sending."
                  : detected.accountLabel || "Availability reported by the official CLI"}
          </small>
          <strong>Provider</strong>
          <div className="library-tabs">
            {(["codex", "antigravity"] as const).map((name) => (
              <button
                type="button"
                key={name}
                className={name === provider ? "selected" : ""}
                onClick={() =>
                  updateTaskView(task.id, {
                    followupProvider: name,
                    followupModel: null,
                    followupEffort: null,
                  })
                }
              >
                <ProviderIcon provider={name} />
                {name === "codex" ? "Codex" : "Antigravity"}
              </button>
            ))}
          </div>
          <strong>Model</strong>
          <Select
            label="Task model"
            searchable
            value={config.model}
            options={[
              { value: "", label: "Official CLI default" },
              ...(config.model && !detected?.models.some((m) => m.id === config.model)
                ? [
                    {
                      value: config.model,
                      label: config.model,
                      description: "Availability unconfirmed",
                    },
                  ]
                : []),
              ...(detected?.models.map((m) => ({ value: m.id, label: m.label || m.id })) || []),
            ]}
            onChange={(model) => update({ model })}
          />
          <strong>Reasoning</strong>
          <div className="effort-options">
            {efforts.map((effort) => (
              <button
                type="button"
                key={effort}
                aria-pressed={config.effort === effort}
                onClick={() => update({ effort })}
              >
                {effort}
              </button>
            ))}
          </div>

          {detected?.models.length && configurationError(detected, config) ? (
            <p className="warning">{configurationError(detected, config)}</p>
          ) : null}

          <Button size="sm" disabled={loading} onClick={() => void refresh()}>
            {loading ? "Discovering…" : "Refresh models"}
          </Button>

          <Button size="sm" onClick={() => setOpen(false)}>
            Done
          </Button>
        </section>
      )}
    </div>
  );
};
