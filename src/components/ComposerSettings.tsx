import type { Task, StageConfig } from "../lib/types";
import { defaultSettings } from "../../backend/domain";
import { useTaskView, updateTaskView } from "../lib/taskView";
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
  const update = (value: Partial<StageConfig>) =>
    updateTaskView(task.id, {
      ...(value.model !== undefined ? { followupModel: value.model } : {}),
      ...(value.effort !== undefined ? { followupEffort: value.effort } : {}),
    });
  return (
    <div className="composer-settings">
      <select
        aria-label="Follow-up provider"
        value={provider}
        onChange={(e) =>
          updateTaskView(task.id, {
            followupProvider: e.target.value as typeof provider,
            followupModel: null,
            followupEffort: null,
          })
        }
      >
        <option value="codex">Codex</option>
        <option value="antigravity">Antigravity</option>
      </select>
      <span>·</span>
      <input
        aria-label="Task model"
        placeholder="CLI default model"
        value={config.model}
        onChange={(e) => update({ model: e.target.value })}
      />
      <span>·</span>
      <select
        aria-label="Task reasoning effort"
        value={config.effort}
        onChange={(e) => update({ effort: e.target.value })}
      >
        {(provider === "codex"
          ? ["none", "minimal", "low", "medium", "high", "xhigh"]
          : ["low", "medium", "high", "xhigh", "max"]
        ).map((v) => (
          <option key={v}>{v}</option>
        ))}
      </select>
    </div>
  );
};
