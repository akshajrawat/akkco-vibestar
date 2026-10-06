import { useEffect, useState } from "react";
import type { Task, Settings, Detection } from "../lib/types";
import { rpc, errorMessage } from "../lib/api";
import { defaultSettings, modelEffortError } from "../../backend/domain";
import { Button } from "./ui/button";
export const ComposerSettings = ({
  task,
  active,
  onError,
}: {
  task: Task;
  active: boolean;
  onError: (error: string) => void;
}) => {
  const [settings, setSettings] = useState<Settings>(
    task.execution_settings || structuredClone(defaultSettings),
  );
  const [providers, setProviders] = useState<Detection[]>([]);
  const [stage, setStage] = useState<
    "antigravity" | "codex_plan" | "codex_implementation"
  >("codex_implementation");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void rpc<Detection[]>("providers.detect")
      .then((value) => {
        if (alive) setProviders(value);
      })
      .catch((e) => {
        if (alive) onError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [onError]);
  const config = settings[stage];
  const provider = stage === "antigravity" ? "antigravity" : "codex";
  const detected = providers.find((p) => p.provider === provider);
  const error = modelEffortError(provider, config.model, config.effort);
  const changed =
    JSON.stringify(settings) !==
    JSON.stringify(task.execution_settings || defaultSettings);
  const save = async () => {
    setBusy(true);
    try {
      await rpc("task.configure", { id: task.id, settings });
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="composer-settings">
      <select
        aria-label="Provider and stage"
        value={stage}
        onChange={(e) => setStage(e.target.value as typeof stage)}
      >
        <option value="antigravity">Antigravity · Plan</option>
        <option value="codex_plan">Codex · Refine plan</option>
        <option value="codex_implementation">Codex · Implement</option>
      </select>
      <input
        aria-label="Task model"
        list={`composer-models-${task.id}`}
        value={config.model}
        placeholder="CLI default model"
        disabled={active}
        onChange={(e) =>
          setSettings((s) => ({
            ...s,
            [stage]: { ...s[stage], model: e.target.value },
          }))
        }
      />
      <datalist id={`composer-models-${task.id}`}>
        {detected?.models.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>
      <select
        aria-label="Task reasoning effort"
        value={config.effort}
        disabled={active}
        onChange={(e) =>
          setSettings((s) => ({
            ...s,
            [stage]: { ...s[stage], effort: e.target.value },
          }))
        }
      >
        {(
          detected?.efforts ||
          (provider === "codex"
            ? ["none", "minimal", "low", "medium", "high", "xhigh"]
            : ["low", "medium", "high", "xhigh", "max"])
        ).map((effort) => (
          <option key={effort}>{effort}</option>
        ))}
      </select>
      {changed && (
        <Button
          size="sm"
          disabled={active || busy || !!error}
          onClick={() => void save()}
        >
          Save task models
        </Button>
      )}
      {error && <span className="failure">{error}</span>}
      <small>
        {active
          ? "Stop the active run or terminal to change task models"
          : "Settings apply only to this task; stages remain independent"}
      </small>
    </div>
  );
};
