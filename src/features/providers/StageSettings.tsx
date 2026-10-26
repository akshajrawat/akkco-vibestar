import type { Detection, Settings, StageConfig } from "../../lib/types";
import {
  supportedEfforts,
  configurationError,
} from "../../../backend/execution/providers/contracts";

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
      <h3>{label}</h3>
      <label>
        Model
        <select
          id={`${id}-models`}
          aria-label="Model"
          value={config.model}
          onChange={(e) => {
            const model = e.target.value;
            const available = supportedEfforts(detected, model);

            onChange({
              ...config,
              model,
              effort: available.includes(config.effort)
                ? config.effort
                : available[0] || config.effort,
            });
          }}
        >
          <option value="" disabled={!allowDefault}>
            {allowDefault ? "Official CLI default" : "Select a discovered model"}
          </option>

          {config.model && !detected?.models.some((m) => m.id === config.model) && (
            <option value={config.model}>{config.model} · availability not confirmed</option>
          )}

          {detected?.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label || m.id}
            </option>
          ))}
        </select>
      </label>

      <label>
        Reasoning / effort
        <select
          value={config.effort}
          onChange={(e) => onChange({ ...config, effort: e.target.value })}
        >
          {!efforts.includes(config.effort) && (
            <option value={config.effort}>
              {config.effort} {detected ? "(unsupported or unknown)" : "(models not loaded)"}
            </option>
          )}

          {efforts.map((e) => (
            <option key={e}>{e}</option>
          ))}
        </select>
      </label>

      <label>
        Timeout (seconds)
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
