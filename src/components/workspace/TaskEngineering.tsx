import { useState } from "react";
import type { Detail, Repository, StageConfig } from "../../lib/types";
import { defaultSettings } from "../../../backend/domain";
import { configurationError } from "../../../backend/execution/providers/contracts";
import { useProviders } from "../../lib/useWorkspace";
import { stages, activeStatuses } from "../../lib/types";
import { duration } from "../../lib/api";
import {
  useTaskView,
  updateTaskView,
  openWorkspaceTool,
} from "../../lib/taskView";
import { Button } from "../ui/button";
import { RunPrompt } from "../RunPrompt";
import { AgentConfiguration } from "../StageSettings";

const FutureStageSettings = ({
  stage,
  provider,
  config: initial,
  busy,
  save,
  close,
}: {
  stage: number;
  provider: string;
  config: StageConfig;
  busy: boolean;
  save: (config: StageConfig) => Promise<unknown>;
  close: () => void;
}) => {
  const [config, setConfig] = useState(initial);
  const { providers, loading, refresh } = useProviders();
  const detected = providers.find((item) => item.provider === provider);
  const invalid = detected?.models.length
    ? configurationError(detected, config)
    : null;
  return (
    <div
      className="future-stage-settings"
      aria-label={`Future stage ${stage} settings`}
    >
      <p>
        {provider} remains this stage's provider. Saving changes starts no
        agent.
      </p>
      <AgentConfiguration
        id={`future-${stage}`}
        label="Future stage model"
        provider={provider}
        providers={providers}
        config={config}
        onChange={setConfig}
      />
      <small>
        {detected?.connected === false
          ? "Connect the provider before execution."
          : detected?.accountLabel ||
            "Account and model availability must be confirmed by the official CLI at execution."}
      </small>
      <div className="actions">
        <Button
          size="sm"
          disabled={busy || !!invalid}
          onClick={() =>
            void save(config).then((result) => {
              if (result) close();
            })
          }
        >
          Save future stage
        </Button>
        <Button size="sm" disabled={busy} onClick={close}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={loading}
          onClick={() => void refresh()}
        >
          Refresh models
        </Button>
      </div>
    </div>
  );
};

export const PipelineView = ({
  detail,
  busy,
  action,
  finalize,
}: {
  detail: Detail;
  busy: boolean;
  action: (method: string, params?: unknown) => Promise<unknown>;
  finalize: () => void;
}) => {
  const task = detail.task;
  const [editing, setEditing] = useState<number>();
  const idle =
    !detail.active &&
    !detail.executing &&
    !activeStatuses.includes(task.status) &&
    task.status !== "queued";
  const config = task.execution_settings || defaultSettings;
  return (
    <div className="engineering-panel">
      <p className="eyebrow">{task.status.replaceAll("_", " ")}</p>
      {task.approval_gate && (
        <p className="warning">
          Approval required · {task.approval_gate.replaceAll("_", " ")}
        </p>
      )}
      <ol className="pipeline-stages">
        {stages.slice(0, 6).map((label, stage) => {
          const run = [...detail.runs]
            .reverse()
            .find(
              (run) =>
                run.stage === stage &&
                !["scheduled", "Code Review Ask AI"].includes(
                  run.purpose || "",
                ),
            );
          const saved =
            task.stage_settings?.[stage as 1 | 2 | 3 | 5] ||
            (stage === 1 || stage === 5
              ? config?.antigravity
              : stage === 2
                ? config?.codex_plan
                : config?.codex_implementation);
          return (
            <li key={stage}>
              <div>
                <strong>{label}</strong>
                <small>
                  {run
                    ? run.status
                    : stage < task.stage
                      ? "Completed"
                      : stage === task.stage
                        ? task.status.replaceAll("_", " ")
                        : "Not started"}
                </small>
              </div>
              {[1, 2, 3, 5].includes(stage) && (
                <p>
                  {run?.provider ||
                    ([1, 5].includes(stage) ? "Antigravity" : "Codex")}{" "}
                  · {run?.model || saved?.model || "Official CLI default"} ·{" "}
                  {run?.effort || saved?.effort || "Unavailable"}
                  {run
                    ? ` · ${duration(run.started_at, run.ended_at)}`
                    : " · saved stage configuration"}
                </p>
              )}
              <div className="actions">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (stage === 1 || stage === 2) {
                      updateTaskView(task.id, { planStage: stage });
                      openWorkspaceTool(task.id, "plans");
                    } else if (stage === 4) openWorkspaceTool(task.id, "tests");
                    else {
                      updateTaskView(task.id, {
                        outputRun: run?.id || "preparation",
                      });
                      openWorkspaceTool(task.id, "run-details");
                    }
                  }}
                >
                  Inspect
                </Button>
                {stage > 0 && stage <= Math.min(task.stage, 5) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!idle || busy}
                    onClick={() =>
                      void action("task.retry", { id: task.id, stage })
                    }
                  >
                    {stage === 4 ? "Retry validation only" : "Retry stage"}
                  </Button>
                )}
                {[1, 2, 3, 5].includes(stage) &&
                  !run &&
                  stage >= task.stage && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!idle || busy}
                      onClick={() => setEditing(stage)}
                    >
                      Edit future model
                    </Button>
                  )}
              </div>
              {editing === stage && idle && !run && saved && (
                <FutureStageSettings
                  stage={stage}
                  provider={[1, 5].includes(stage) ? "antigravity" : "codex"}
                  config={saved}
                  busy={busy}
                  save={(config) =>
                    action("task.configureStage", {
                      id: task.id,
                      stage,
                      config,
                    })
                  }
                  close={() => setEditing(undefined)}
                />
              )}
            </li>
          );
        })}
      </ol>
      <p className="subtle">
        Stage settings were saved with this task. Completed runs show their
        effective model and effort. The chat model applies to explicit
        implementation follow-ups.
      </p>
      <div className="actions">
        {task.status === "ready_for_review" && (
          <Button disabled={!idle || busy} onClick={finalize}>
            Finalize…
          </Button>
        )}
        {![
          "completed",
          "awaiting_approval",
          "ready_for_review",
          "queued",
        ].includes(task.status) && (
          <Button
            disabled={!idle || busy}
            onClick={() => void action("task.retry")}
          >
            {task.status === "verification_blocked"
              ? "Retry saved validation"
              : "Resume"}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={!idle || busy}
          onClick={() =>
            void action("task.retry", { id: task.id, restart: true })
          }
        >
          Restart pipeline
        </Button>
      </div>
    </div>
  );
};

export const RunDetailsView = ({
  detail,
  repository,
  prompts,
}: {
  detail: Detail;
  repository?: Repository;
  prompts: () => void;
}) => {
  const view = useTaskView(detail.task.id);
  const run =
    detail.runs.find((run) => run.id === view.outputRun) || detail.runs.at(-1);
  return (
    <div className="engineering-panel">
      <label>
        Selected run
        <select
          aria-label="Inspect run"
          value={run?.id || ""}
          onChange={(e) =>
            updateTaskView(detail.task.id, { outputRun: e.target.value })
          }
        >
          {detail.runs.map((run) => (
            <option key={run.id} value={run.id}>
              {run.provider} · {run.purpose || `Stage ${run.stage}`} ·{" "}
              {run.status}
            </option>
          ))}
        </select>
      </label>
      {run && (
        <>
          <p>
            {run.provider} · {run.model || "Official CLI default"} ·{" "}
            {run.effort}
          </p>
          <p>
            {run.status} · {duration(run.started_at, run.ended_at)} · exit{" "}
            {run.exit_code ?? "unreported"}
          </p>
          <RunPrompt run={run} />
          <details>
            <summary>Execution metadata</summary>
            <pre>
              {JSON.stringify(
                {
                  id: run.id,
                  purpose: run.purpose,
                  stage: run.stage,
                  started_at: run.started_at,
                  ended_at: run.ended_at,
                  pid: run.pid,
                  conversation_id: run.conversation_id,
                  error: run.error,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </>
      )}
      <Button size="sm" onClick={prompts}>
        View sent prompts
      </Button>
      <h3>Workspace identity</h3>
      <dl className="repository-facts">
        {Object.entries({
          Source: repository?.path || "Unavailable",
          Ownership:
            repository?.source === "imported"
              ? "User-owned source checkout"
              : "Vibestar-managed clone",
          Worktree: detail.task.worktree_path || "Not prepared",
          Branch: detail.task.branch_name || "Not prepared",
          Base: `${detail.task.base_branch} · ${detail.task.base_commit_sha}`,
        }).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <code>{value}</code>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
};
