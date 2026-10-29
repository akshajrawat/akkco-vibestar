import type { Detection, Settings, StageConfig, PipelineStageConfig } from "../../lib/types";
import { pipelineConfiguration, pipelineStages } from "../../../backend/domain";
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
  onProviderChange,
}: {
  config: StageConfig;
  provider: string;
  providers: Detection[];
  onChange: (value: StageConfig) => void;
  label: string;
  id: string;
  allowDefault?: boolean;
  maxTimeout?: number;
  onProviderChange?: (provider: "codex" | "antigravity") => void;
}) => {
  const detected = providers.find((p) => p.provider === provider);
  const efforts = supportedEfforts(detected, config.model);
  const error = detected?.models.length ? configurationError(detected, config) : null;
  return (
    <section
      className={`config-block${onProviderChange ? " pipeline-config" : ""}`}
      aria-labelledby={`${id}-title`}
    >
      <h3 id={`${id}-title`}>
        <ProviderIcon provider={provider} size={20} /> {label}
      </h3>
      {onProviderChange && (
        <label>
          Provider
          <Select
            label="Provider"
            value={provider}
            onChange={(value) => onProviderChange(value as "codex" | "antigravity")}
            options={(["codex", "antigravity"] as const).map((value) => ({
              value,
              label: value === "codex" ? "Codex" : "Antigravity",
              icon: <ProviderIcon provider={value} />,
            }))}
          />
        </label>
      )}
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

export const PipelineConfiguration = ({
  config,
  providers,
  onChange,
  ...props
}: {
  config: PipelineStageConfig & { provider: "codex" | "antigravity" };
  providers: Detection[];
  onChange: (value: PipelineStageConfig & { provider: "codex" | "antigravity" }) => void;
  id: string;
  label: string;
}) => (
  <AgentConfiguration
    {...props}
    config={config}
    provider={config.provider}
    providers={providers}
    onChange={(value) => onChange({ ...value, provider: config.provider })}
    onProviderChange={(provider) => {
      const efforts = supportedEfforts(
        providers.find((entry) => entry.provider === provider),
        "",
      );

      onChange({
        ...config,
        provider,
        model: "",
        effort: efforts.includes(config.effort) ? config.effort : efforts[0] || "medium",
      });
    }}
  />
);

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
    {pipelineStages.map(({ stage, key, label }, index) => (
      <PipelineConfiguration
        key={key}
        id={key}
        label={`${index + 1} · ${label}`}
        providers={providers}
        config={pipelineConfiguration(settings, stage)}
        onChange={(config) =>
          onChange({
            ...settings,
            ...Object.fromEntries(
              pipelineStages.map((role) => [role.key, pipelineConfiguration(settings, role.stage)]),
            ),
            [key]: config,
          })
        }
      />
    ))}
  </div>
);
