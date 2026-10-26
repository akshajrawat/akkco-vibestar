import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { z } from "zod";

import { AdeError, type StageConfig, type Task, type WorkspaceAssignment } from "../../domain";
import { managedPath } from "../../workspace/paths";
import type { AgentRunner } from "../agents/agent-runner";
import { type UtilityRequest } from "../agents/utility-ai";
import type { Engine } from "../engine";
import type { EngineScheduling } from "./scheduling";
import type { ExecutionState } from "./state";

/** Shares the existing runner and execution slots across repair, utility and finalization invocations. */
export class AgentOperations {
  constructor(
    private readonly host: Pick<Engine, "db" | "isActive" | "root" | "changed" | "drain">,
    private readonly state: ExecutionState,
    private readonly runner: AgentRunner,
    private readonly operations: { withExecutionSlot: EngineScheduling["withExecutionSlot"] },
  ) {}

  runRepair = (
    assignment: WorkspaceAssignment,
    provider: "codex" | "antigravity",
    config: StageConfig,
    prompt: string,
    schema: z.ZodType,
    contextPaths: string[],
    signal: AbortSignal,
  ) =>
    this.operations.withExecutionSlot(`repair:${assignment.id}`, "PR repair", signal, (combined) =>
      this.runner.run(
        { id: assignment.id, stage: provider === "codex" ? 3 : 5 },
        this.host.db.settings(),
        combined,
        {
          repair: assignment,
          prompt,
          purpose: provider === "codex" ? "PR Repair Implementation" : "PR Repair Verification",
          provider,
          config,
          schema,
          contextPaths,
        },
      ),
    );

  runUtility = async (
    request: UtilityRequest,
    config: import("../../domain").Settings["utility_ai"],
  ) => {
    const id = request.context?.scanId || request.context?.jobId || randomUUID();

    const task =
      request.workspace && request.context?.taskId
        ? this.host.db.task(request.context.taskId)
        : null;

    const key = task?.id || `utility:${id}`;
    if (
      this.state.closed ||
      this.state.maintenance ||
      (request.context?.taskId && this.state.taskMaintenance.has(request.context.taskId)) ||
      this.host.isActive(key) ||
      this.state.active.size >= this.host.db.settings().concurrency ||
      this.host.db.tasks().some((t) => t.status === "queued" && !t.archived)
    )
      throw new AdeError("busy", "Utility analysis is waiting for task execution capacity");
    const workspace = request.workspace || join(this.host.root, "cache", "utility", id);
    if (request.workspace && !task)
      throw new AdeError("isolation", "Utility filesystem context requires a linked isolated task");
    const controller = new AbortController();

    const output = Promise.resolve().then(async () => {
      if (!task) {
        await managedPath(this.host.root, workspace);
        await mkdir(workspace, { recursive: true, mode: 0o700 });
        await managedPath(this.host.root, workspace);
      }

      return this.runner.run(
        task ? { ...task, stage: 1 } : { id, stage: 1 },
        this.host.db.settings(),
        request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal,
        {
          prompt: request.prompt,
          purpose: request.purpose,
          workspace,
          schema: request.schema,
          jobId: request.context?.jobId,
          analysisId: request.context?.analysisId,
          watchId: request.context?.watchId,
          scanId: request.context?.scanId,
          telemetryTaskId: request.context?.taskId,
          questionId: request.context?.questionId,
          telemetryRepository: request.context?.repository,
          provider: config.provider,
          config,
        },
      );
    });

    const completed = output.finally(() => {
      this.state.active.delete(key);
      this.host.changed(task?.id);
      void this.host.drain();
    });

    const promise = completed.then(() => {}).catch(() => {});

    this.state.active.set(key, {
      controller,
      promise,
      taskId: request.context?.taskId,
      purpose: request.purpose,
    });

    return completed;
  };

  reviewFinalization = (task: Task, prompt: string, signal: AbortSignal) =>
    this.operations.withExecutionSlot(
      `git-review:${task.id}`,
      "Selected-file review",
      signal,
      (combined) =>
        this.runner.run(
          { ...task, stage: 5 },
          task.execution_settings ?? this.host.db.settings(),
          combined,
          { prompt, purpose: "git-finalization-review" },
        ),
      task.id,
    );
}
