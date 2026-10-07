import type { Detection, Settings, StageConfig } from "../lib/types";
import {
  supportedEfforts,
  configurationError,
} from "../../backend/execution/providers/contracts";
export const AgentConfiguration = ({
  config,
  provider,
  providers,
  onChange,
  label,
  id,
}: {
  config: StageConfig;
  provider: string;
  providers: Detection[];
  onChange: (value: StageConfig) => void;
  label: string;
  id: string;
}) => {
  const detected = providers.find((p) => p.provider === provider);
  const efforts = supportedEfforts(detected, config.model);
  const error = detected?.models.length
    ? configurationError(detected, config)
    : null;
  return (
    <section className="config-block">
      <h3>{label}</h3>
      <label>
        Model
        <input
          list={`${id}-models`}
          value={config.model}
          placeholder="Official CLI default"
          onChange={(e) => onChange({ ...config, model: e.target.value })}
        />
        <datalist id={`${id}-models`}>
          {detected?.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label || m.id}
            </option>
          ))}
        </datalist>
      </label>
      <label>
        Reasoning / effort
        <select
          value={config.effort}
          onChange={(e) => onChange({ ...config, effort: e.target.value })}
        >
          {!efforts.includes(config.effort) && (
            <option value={config.effort}>
              {config.effort}{" "}
              {detected ? "(unsupported or unknown)" : "(discovering…)"}
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
          max={86400}
          value={config.timeout_secs}
          onChange={(e) =>
            onChange({ ...config, timeout_secs: Number(e.target.value) })
          }
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
        ["antigravity", "ANTIGRAVITY PLAN", "antigravity"],
        ["codex_plan", "CODEX REVIEW PLAN", "codex"],
        ["codex_implementation", "CODEX IMPLEMENTATION", "codex"],
      ] as const
    ).map(([key, label, provider]) => (
      <AgentConfiguration
        key={key}
        id={key}
        label={label}
        provider={provider}
        providers={providers}
        config={settings[key]}
        onChange={(config) => onChange({ ...settings, [key]: config })}
      />
    ))}
  </div>
);
