import { useEffect, useRef, useState } from "react";
import type { Task, StageConfig } from "../lib/types";
import { defaultSettings } from "../../backend/domain";
import {
  supportedEfforts,
  configurationError,
} from "../../backend/execution/providers/contracts";
import { useProviders } from "../lib/useWorkspace";
import { useTaskView, updateTaskView } from "../lib/taskView";
import { Button } from "./ui/button";
export const followupConfiguration = (
  task: Task,
  view: ReturnType<typeof useTaskView>,
) => {
  const defaults = task.execution_settings || defaultSettings;
  const config =
    view.followupProvider === "codex"
      ? defaults.codex_implementation
      : defaults.antigravity;
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
        title="Provider for implementation follow-ups. Planning and final review use the saved stage configuration."
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Follow-up: {provider === "codex" ? "Codex" : "Antigravity"} ·{" "}
        {detected?.models.find((m) =>
          config.model ? m.id === config.model : m.isDefault,
        )?.label ||
          config.model ||
          "CLI default"}{" "}
        · {config.effort}
      </Button>
      {open && (
        <div
          className="model-picker"
          role="dialog"
          aria-label="Chat model configuration"
        >
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
                {name === "codex" ? "Codex" : "Antigravity"}
              </button>
            ))}
          </div>
          <strong>Model</strong>
          <div className="model-options" role="listbox" aria-label="Task model">
            <button
              type="button"
              role="option"
              aria-selected={!config.model}
              onClick={() => update({ model: "" })}
            >
              Official CLI default
            </button>
            {detected?.models.map((m) => (
              <button
                type="button"
                role="option"
                aria-selected={config.model === m.id}
                key={m.id}
                onClick={() => update({ model: m.id })}
              >
                {m.label || m.id}
              </button>
            ))}
          </div>
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
        </div>
      )}
    </div>
  );
};
