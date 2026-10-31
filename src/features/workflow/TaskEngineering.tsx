import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  LoaderCircle,
  AlertTriangle,
  XCircle,
  Circle,
  CircleSlash,
  CircleHelp,
  Clock3,
  MoreHorizontal,
} from "lucide-react";

import type { Detail, Repository, PipelineStageConfig } from "../../lib/types";
import { defaultSettings, pipelineConfiguration } from "../../../backend/domain";
import { configurationError } from "../../../backend/execution/providers/contracts";
import { useProviders } from "../../hooks/useWorkspace";
import { stages, activeStatuses } from "../../lib/types";
import { duration } from "../../lib/format";
import { useTaskView, updateTaskView, openWorkspaceTool } from "../../lib/taskView";
import { Button } from "../../components/ui/button";
import { ProviderIcon } from "../../components/ui/ProviderIcon";
import { Select } from "../../components/ui/Select";
import { RunPrompt } from "../chat/RunPrompt";
import { PipelineConfiguration } from "../providers/StageSettings";
import { runActivity } from "../chat/output/activity";
import { detailVerification } from "../../lib/verification";

const FutureStageSettings = ({
  stage,
  config: initial,
  busy,
  save,
  close,
}: {
  stage: number;
  config: PipelineStageConfig & { provider: "codex" | "antigravity" };
  busy: boolean;
  save: (config: PipelineStageConfig) => Promise<unknown>;
  close: () => void;
}) => {
  const [config, setConfig] = useState(initial);
  const { providers, loading, refresh } = useProviders();
  const detected = providers.find((item) => item.provider === config.provider);
  const invalid = detected?.models.length ? configurationError(detected, config) : null;
  return (
    <div className="future-stage-settings" aria-label={`Future stage ${stage} settings`}>
      <p>Choose the provider, model and effort for this stage. Saving starts no agent.</p>
      <PipelineConfiguration
        id={`future-${stage}`}
        label="Future stage configuration"
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

        <Button size="sm" variant="ghost" disabled={loading} onClick={() => void refresh()}>
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
}: {
  detail: Detail;
  busy: boolean;
  action: (method: string, params?: unknown) => Promise<unknown>;
  terminal: () => void;
  onError?: (message: string) => void;
}) => {
  const task = detail.task;
  const [editing, setEditing] = useState<number>();
  const [instructions, setInstructions] = useState<string[]>([]);
  const [summary, setSummary] = useState("");
  const startRequest = useRef({ signature: "", id: "" });

  const idle =
    !detail.active &&
    !detail.executing &&
    !activeStatuses.includes(task.status) &&
    task.status !== "queued";

  const config = task.execution_settings || defaultSettings;
  const [, tick] = useState(0);

  const running =
    ["preparing", "validating"].includes(task.status) ||
    detail.runs.some((run) => run.status === "running");

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => tick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const verification = detailVerification(detail);

  const approvalStage = task.approval_gate
    ? {
        antigravity_plan: 1,
        codex_plan: 2,
        implementation: 3,
        final_review: 5,
      }[task.approval_gate]
    : undefined;

  if (task.status === "preserved")
    return (
      <div className="engineering-panel">
        <h2>Work preserved</h2>
        <p>
          Conversation and execution history were removed. The retained ownership record protects
          this worktree and branch. Open it in your editor to continue outside this task.
        </p>
      </div>
    );
  return (
    <div className="engineering-panel">
      {task.status === "not_started" && (
        <section className="workflow-start">
          <h2>Workflow not started</h2>
          <p>Your task is ready. You can discuss the issue before running the workflow.</p>
          <details>
            <summary>Include reviewed conversation instructions</summary>
            <p className="subtle">
              Only selected messages and the summary below reach the workflow.
            </p>

            {detail.messages
              .filter(
                (message) => message.purpose === "chat" && message.status === "chat_completed",
              )
              .map((message) => (
                <label className="checkbox-label" key={message.id}>
                  <input
                    type="checkbox"
                    checked={instructions.includes(message.id)}
                    onChange={(event) =>
                      setInstructions(
                        event.target.checked
                          ? [...instructions, message.id]
                          : instructions.filter((id) => id !== message.id),
                      )
                    }
                  />

                  <span>
                    {message.role === "user" ? "You" : "Agent"}: {message.content.slice(0, 240)}
                  </span>
                </label>
              ))}

            <label>
              Reviewed summary or instructions
              <textarea
                rows={3}
                maxLength={32000}
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
              />
            </label>
          </details>

          <Button
            variant="default"
            disabled={!idle || busy}
            onClick={() => {
              const signature = JSON.stringify({
                message_ids: instructions,
                summary,
              });

              if (startRequest.current.signature !== signature)
                startRequest.current = { signature, id: crypto.randomUUID() };

              void action("task.startWorkflow", {
                id: task.id,
                request_id: startRequest.current.id,
                message_ids: instructions,
                summary,
              });
            }}
          >
            {busy ? "Checking workflow startup…" : "Start workflow"}
          </Button>
        </section>
      )}

      <ol className="pipeline-stages">
        {stages
          .slice(0, 6)
          .map((label, stage) => ({ label, stage }))
          .filter(({ stage }) => stage !== 4)
          .map(({ label, stage }) => {
            const run = [...detail.runs]
              .reverse()
              .find(
                (run) =>
                  run.stage === stage &&
                  ![
                    "scheduled",
                    "Code Review Ask AI",
                    "git-finalization-review",
                    "Read-only conversation",
                    "Workspace conversation",
                  ].includes(run.purpose || ""),
              );

            const saved = [1, 2, 3, 5].includes(stage)
              ? pipelineConfiguration(config || defaultSettings, stage, task.stage_settings)
              : undefined;

            const status =
              task.status === "not_started"
                ? "not_started"
                : stage === 5 && task.final_review_verdict === "changes_requested"
                  ? "changes_requested"
                  : task.status === "awaiting_approval" && stage === approvalStage
                    ? "awaiting_approval"
                    : run
                      ? run.status === "completed" && run.exit_code !== 0
                        ? "unknown"
                        : run.status
                      : stage === task.stage &&
                          ["failed", "cancelled", "interrupted", "verification_blocked"].includes(
                            task.status,
                          )
                        ? task.status === "verification_blocked"
                          ? "blocked"
                          : task.status
                        : stage === 0 && task.stage > 0 && task.base_commit_sha
                          ? "completed"
                          : stage === task.stage && !idle
                            ? "running"
                            : stage < task.stage
                              ? "unknown"
                              : "not_started";

            const tone =
              status === "completed"
                ? "success"
                : ["failed", "changes_requested"].includes(status)
                  ? "failure"
                  : status === "running"
                    ? "running"
                    : ["awaiting_approval", "blocked", "unknown"].includes(status)
                      ? "warning"
                      : "muted";

            const Icon =
              status === "completed"
                ? CheckCircle2
                : status === "running"
                  ? LoaderCircle
                  : ["failed", "changes_requested"].includes(status)
                    ? XCircle
                    : status === "awaiting_approval"
                      ? Clock3
                      : status === "blocked"
                        ? AlertTriangle
                        : status === "unknown"
                          ? CircleHelp
                          : ["cancelled", "interrupted"].includes(status)
                            ? CircleSlash
                            : Circle;

            return (
              <li
                key={stage}
                className={`pipeline-step ${status}`}
                aria-current={
                  status === "running" ||
                  status === "awaiting_approval" ||
                  (task.status === "awaiting_approval" && stage === approvalStage) ||
                  (stage === task.stage && status === "blocked")
                    ? "step"
                    : undefined
                }
              >
                <span className={`pipeline-icon ${tone}`} aria-hidden="true">
                  <Icon size={18} className={status === "running" ? "spinning" : ""} />
                </span>

                <div className="pipeline-stage-heading">
                  <strong>{label}</strong>

                  <small className={tone}>
                    {status === "unknown" ? "Evidence unavailable" : status.replaceAll("_", " ")}
                  </small>
                </div>

                {stage === 0 && (
                  <p>
                    Host ·{" "}
                    {task.preparation_timing &&
                    (task.preparation_timing.ended_at || task.status === "preparing")
                      ? duration(
                          task.preparation_timing.started_at,
                          task.preparation_timing.ended_at,
                        )
                      : "Duration unavailable"}
                  </p>
                )}

                {[1, 2, 3, 5].includes(stage) && (
                  <p>
                    <ProviderIcon
                      provider={run?.provider || saved?.provider || ""}
                      model={run?.model || saved?.model}
                      size={13}
                    />{" "}
                    {run?.provider || saved?.provider || "Unavailable"} ·{" "}
                    {run?.model || saved?.model || "Official CLI default"} ·{" "}
                    {run?.effort || saved?.effort || "Unavailable"}
                    {run
                      ? ` · ${run.ended_at || run.status === "running" ? duration(run.started_at, run.ended_at) : "Duration unavailable"}`
                      : ""}
                  </p>
                )}

                {stage === 5 && task.final_review_verdict && (
                  <p>
                    {
                      {
                        verified: "Code approved · verification complete",
                        code_approved_incomplete: "Code approved · verification incomplete",
                        changes_requested: "Changes requested · inspect findings and request fixes",
                        blocked: "Review blocked · inspect missing evidence",
                      }[task.final_review_verdict]
                    }
                  </p>
                )}

                {run && status === "running" && (
                  <p className="pipeline-current-action">{runActivity(detail.events, run)}</p>
                )}

                <details className="pipeline-stage-actions">
                  <summary aria-label={`Actions for ${label}`}>
                    <MoreHorizontal size={15} />
                  </summary>

                  <div className="actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        if (stage === 1 || stage === 2) {
                          updateTaskView(task.id, { planStage: stage });
                          openWorkspaceTool(task.id, "plans");
                        } else if (stage === 5) openWorkspaceTool(task.id, "final-review");
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

                    {stage > 0 &&
                      stage <= Math.min(task.stage, 5) &&
                      status !== "awaiting_approval" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!idle || busy}
                          onClick={() => void action("task.retry", { id: task.id, stage })}
                        >
                          Retry stage
                        </Button>
                      )}

                    {[1, 2, 3, 5].includes(stage) && !run && stage >= task.stage && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!idle || busy}
                        onClick={() => setEditing(stage)}
                      >
                        Edit future stage
                      </Button>
                    )}
                  </div>
                </details>

                {editing === stage && idle && !run && saved && (
                  <FutureStageSettings
                    stage={stage}
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

      {detail.artifacts.some((artifact) => artifact.stage === 3 && artifact.kind === "plan") && (
        <section className="workflow-checks" aria-label="Agent checks">
          <h3>Agent checks</h3>
          <p>Implementation and review run the required tests, lint and formatting.</p>
          <Button size="sm" variant="ghost" onClick={() => openWorkspaceTool(task.id, "tests")}>
            {
              verification.checks.filter(
                (check) => check.kind === "check" && check.outcome === "passed",
              ).length
            }{" "}
            passed · View check results
          </Button>
        </section>
      )}

      <div className="actions">
        {task.status === "ready_for_review" && (
          <Button disabled={!idle || busy} onClick={() => void action("task.complete")}>
            Mark task complete
          </Button>
        )}

        {![
          "completed",
          "awaiting_approval",
          "ready_for_review",
          "queued",
          "verification_blocked",
          "reviewed_with_gaps",
          "not_started",
        ].includes(task.status) && (
          <Button disabled={!idle || busy} onClick={() => void action("task.retry")}>
            Resume
          </Button>
        )}

        {task.status !== "not_started" && (
          <Button
            variant="ghost"
            size="sm"
            disabled={!idle || busy}
            onClick={() => void action("task.retry", { id: task.id, restart: true })}
          >
            Restart pipeline
          </Button>
        )}
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
  const run = detail.runs.find((run) => run.id === view.outputRun) || detail.runs.at(-1);
  return (
    <div className="engineering-panel run-details-panel">
      <label>
        Selected run
        <Select
          label="Inspect run"
          value={run?.id || ""}
          onChange={(outputRun) => updateTaskView(detail.task.id, { outputRun })}
          options={detail.runs.map((run) => ({
            value: run.id,
            label: `${run.provider} · ${run.purpose || `Stage ${run.stage}`} · ${run.status}`,
          }))}
        />
      </label>

      {run && (
        <>
          <section className="run-summary">
            <p>
              {run.provider} · {run.model || "Official CLI default"} · {run.effort}
            </p>

            <p>
              {run.status} · {duration(run.started_at, run.ended_at)}
              {run.status !== "running" && ` · exit ${run.exit_code ?? "unreported"}`}
            </p>
          </section>
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
