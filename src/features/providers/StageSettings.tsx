import type { Detection, Settings, StageConfig } from "../../lib/types";
import {
  supportedEfforts,
  configurationError,
} from "../../../backend/execution/providers/contracts";
import { Select } from "../../components/ui/Select";
import { ProviderIcon } from "../../components/ui/ProviderIcon";

export const AgentConfiguration = ({
  config,
  provider,
  providers,
  onChange,
  label,
  id,
  allowDefault = true,
  maxTimeout = 86400,
}: {
  config: StageConfig;
  provider: string;
  providers: Detection[];
  onChange: (value: StageConfig) => void;
  label: string;
  id: string;
  allowDefault?: boolean;
  maxTimeout?: number;
}) => {
  const detected = providers.find((p) => p.provider === provider);
  const efforts = supportedEfforts(detected, config.model);
  const error = detected?.models.length ? configurationError(detected, config) : null;
  return (
    <section className="config-block">
      <h3>
        <ProviderIcon provider={provider} size={20} /> {label}
      </h3>
      <label>
        Model
        <Select
          id={`${id}-models`}
          label="Model"
          searchable
          value={config.model}
          onChange={(model) => {
            const available = supportedEfforts(detected, model);

            onChange({
              ...config,
              model,
              effort: available.includes(config.effort)
                ? config.effort
                : available[0] || config.effort,
            });
          }}
          options={[
            {
              value: "",
              label: allowDefault ? "Official CLI default" : "Select a discovered model",
              disabled: !allowDefault,
            },
            ...(config.model && !detected?.models.some((m) => m.id === config.model)
              ? [
                  {
                    value: config.model,
                    label: config.model,
                    description: "Availability unconfirmed",
                  },
                ]
              : []),
            ...(detected?.models.map((m) => ({
              value: m.id,
              label: m.label || m.id,
              icon: <ProviderIcon provider={provider} model={m.id} />,
            })) || []),
          ]}
        />
      </label>

      <label>
        Reasoning / effort
        <Select
          label="Reasoning / effort"
          value={config.effort}
          onChange={(effort) => onChange({ ...config, effort })}
          options={[
            ...(!efforts.includes(config.effort)
              ? [
                  {
                    value: config.effort,
                    label: config.effort,
                    description: detected ? "Unsupported or unknown" : "Models not loaded",
                  },
                ]
              : []),
            ...efforts.map((effort) => ({ value: effort, label: effort })),
          ]}
        />
      </label>

      <label>
        <span>
          Timeout <small>(seconds)</small>
        </span>
        <input
          type="number"
          min={10}
          max={maxTimeout}
          value={config.timeout_secs}
          onChange={(e) => onChange({ ...config, timeout_secs: Number(e.target.value) })}
        />
      </label>
      {error && <p className="failure">{error}</p>}
    </section>
  );
};

export const StageSettings = ({
  settings,
  onChange,
  providers = [],
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  providers?: Detection[];
}) => (
  <div className="stage-settings">
    {(
      [
        ["antigravity", "1 · Antigravity plan", "antigravity"],
        ["codex_plan", "2 · Codex refinement", "codex"],
        ["codex_implementation", "3 · Codex implementation", "codex"],
        ["antigravity_review", "4 · Antigravity final review", "antigravity"],
      ] as const
    ).map(([key, label, provider]) => (
      <AgentConfiguration
        key={key}
        id={key}
        label={label}
        provider={provider}
        providers={providers}
        config={settings[key] || settings.antigravity}
        onChange={(config) => onChange({ ...settings, [key]: config })}
      />
    ))}
  </div>
);
