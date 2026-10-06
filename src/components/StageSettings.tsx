import type { Detection, Settings, StageConfig } from "../lib/types";
import { modelEffortError } from "../../backend/domain";
export const StageSettings = ({
  settings,
  onChange,
  providers = [],
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  providers?: Detection[];
}) => {
  const configs: [
    keyof Pick<Settings, "antigravity" | "codex_plan" | "codex_implementation">,
    string,
    string,
  ][] = [
    ["antigravity", "ANTIGRAVITY PLAN", "antigravity"],
    ["codex_plan", "CODEX REVIEW PLAN", "codex"],
    ["codex_implementation", "CODEX IMPLEMENTATION", "codex"],
  ];
  return (
    <div className="stage-settings">
      {configs.map(([key, label, provider]) => {
        const c = settings[key];
        const detected = providers.find((p) => p.provider === provider);
        const efforts =
          detected?.efforts ||
          (provider === "antigravity"
            ? ["low", "medium", "high", "xhigh", "max"]
            : ["none", "minimal", "low", "medium", "high", "xhigh"]);
        const update = (v: Partial<StageConfig>) =>
          onChange({ ...settings, [key]: { ...c, ...v } });
        return (
          <section className="config-block" key={key}>
            <h3>{label}</h3>
            <label>
              Model
              <input
                list={`${key}-models`}
                value={c.model}
                placeholder="Official CLI default"
                onChange={(e) => update({ model: e.target.value })}
              />
              <datalist id={`${key}-models`}>
                {detected?.models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>
            <label>
              Reasoning / effort
              <select
                value={c.effort}
                onChange={(e) => update({ effort: e.target.value })}
              >
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
                value={c.timeout_secs}
                onChange={(e) =>
                  update({ timeout_secs: Number(e.target.value) })
                }
              />
            </label>
            {modelEffortError(provider, c.model, c.effort) && (
              <p className="failure">
                {modelEffortError(provider, c.model, c.effort)}
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
};
