import { AdeError, now, stageStatus, type ActivityBlocker } from "../../domain";
import { redact } from "../runtime/process";
import type { Engine } from "../engine";
import type { ExecutionState } from "./state";
import type { WorkflowOrchestrator } from "./workflow";
/** Owns shared execution slots and maintenance leases; every writer observes the same state. */
export class EngineScheduling {
  constructor(
    private readonly host: Pick<Engine, "changed" | "db" | "isActive" | "publish">,
    private readonly state: ExecutionState,
    private readonly operations: { pipeline: WorkflowOrchestrator["pipeline"] },
  ) {}
  repositoryOperation = <T>(
    operation: () => Promise<T>,
    label = "Repository preparation is running",
  ) => {
    this.assertAvailable();
    const result = Promise.resolve()
      .then(operation)
      .finally(() => {
        this.state.repositoryOperations.delete(result);
        this.host.changed();
      });
    this.state.repositoryOperations.set(result, label);
    return result;
  };
  withStorageMaintenance = async <T>(operation: () => Promise<T>) => {
    const blockers = this.cleanupBlockers();
    if (blockers.length)
      throw new AdeError("busy", "Storage cleanup is waiting for active operations to finish.", {
        blockers,
      });
    this.state.maintenance = true;
    try {
      return await operation();
    } finally {
      this.state.maintenance = false;
      this.host.changed();
      void this.drain();
    }
  };
  cleanupBlockers = (taskId?: string): ActivityBlocker[] => {
    const tasks = this.host.db.tasks();
    const label = (id: string) => {
      const task = tasks.find((t) => t.id === id);
      return task ? `Task #${task.issue_number}` : "Utility AI";
    };
    const blockers: ActivityBlocker[] = [];
    for (const [id, activity] of this.state.active) {
      if (activity.taskId && this.state.activities.has(`git:${activity.taskId}`)) continue;
      if (
        id.startsWith("utility:") &&
        (this.state.activities.has(`pr-watch:${id.slice(8)}`) ||
          this.state.activities.has(`issue-watch:${id.slice(8)}`))
      )
        continue;
      blockers.push({
        id: `run:${id}`,
        kind: "task",
        task_id: activity.taskId || (tasks.some((t) => t.id === id) ? id : undefined),
        label: activity.purpose
          ? `${activity.purpose}${activity.taskId ? ` for ${label(activity.taskId)}` : ""} is running`
          : `${label(id)} is running`,
        stoppable: true,
      });
    }
    for (const [id, activity] of this.state.interactive) {
      if (this.state.activities.has(`git:${id}`)) continue;
      blockers.push({
        id: `terminal:${id}`,
        kind: "terminal",
        task_id: id,
        label: `${label(id)} ${activity} is open`,
        stoppable: true,
      });
    }
    for (const task of tasks.filter(
      (t) => t.status === "queued" && !t.archived && !this.state.active.has(t.id),
    ))
      blockers.push({
        id: `run:${task.id}`,
        kind: "task",
        task_id: task.id,
        label: `${label(task.id)} is queued`,
        stoppable: true,
      });
    for (const { blocker } of this.state.activities.values()) blockers.push(blocker);
    if (this.state.maintenance)
      blockers.push({
        id: "storage-maintenance",
        kind: "maintenance",
        label: "Storage cleanup is already running",
        stoppable: false,
      });
    for (const [id, activity] of this.state.taskMaintenance)
      blockers.push({
        id: `cleanup:${id}`,
        kind: "maintenance",
        task_id: id,
        label: `${label(id)} · ${activity}`,
        stoppable: false,
      });
    if (!taskId)
      for (const [index, description] of [...this.state.repositoryOperations.values()].entries())
        blockers.push({
          id: `repository-operation:${index}`,
          kind: "repository",
          label: description,
          stoppable: false,
        });
    return blockers.filter(
      (b) => !taskId || b.task_id === taskId || b.id === "storage-maintenance",
    );
  };
  trackActivity = (blocker: ActivityBlocker, stop: () => Promise<void>) => {
    this.assertAvailable();
    if (blocker.task_id && this.state.taskMaintenance.has(blocker.task_id))
      throw new AdeError("busy", "Task data cleanup is running", {
        blockers: this.cleanupBlockers(blocker.task_id),
      });
    this.state.activities.set(blocker.id, { blocker, stop });
    this.host.changed();
    return () => {
      this.state.activities.delete(blocker.id);
      this.host.changed();
    };
  };
  stopActivity = async (id: string) => {
    if (id.startsWith("run:")) {
      const key = id.slice(4);
      const active = this.state.active.get(key);
      if (active) {
        active.controller.abort();
        await active.promise;
      } else if (
        this.host.db.tasks().some((t) => t.id === key && t.status === "queued" && !t.archived)
      )
        this.cancel(key);
    } else await this.state.activities.get(id)?.stop();
  };
  withTaskMaintenance = async <T>(
    id: string,
    operation: () => Promise<T>,
    activity = "Data cleanup is running",
  ) => {
    this.assertAvailable();
    const blockers = this.cleanupBlockers(id);
    if (blockers.length)
      throw new AdeError(
        "busy",
        "Task data cleanup is waiting for this task's active operations to finish.",
        { blockers },
      );
    this.state.taskMaintenance.set(id, activity);
    try {
      return await operation();
    } finally {
      this.state.taskMaintenance.delete(id);
      this.host.changed(id);
      void this.drain();
    }
  };
  assertAvailable = () => {
    if (this.state.maintenance || this.state.closed)
      throw new AdeError(
        "busy",
        "Vibestar storage is being maintained. Try again when it finishes.",
      );
  };
  withExecutionSlot = async <T>(
    key: string,
    purpose: string,
    signal: AbortSignal,
    run: (signal: AbortSignal) => Promise<T>,
    taskId?: string,
  ) => {
    this.assertAvailable();
    if (this.state.active.has(key) || this.state.active.size >= this.host.db.settings().concurrency)
      throw new AdeError(
        "busy",
        "The configured execution slots are occupied. Retry this action explicitly when a slot is available.",
      );
    const controller = new AbortController();
    const result = Promise.resolve().then(() => run(AbortSignal.any([signal, controller.signal])));
    const promise = result
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        this.state.active.delete(key);
        this.host.changed(taskId);
        void this.drain();
      });
    this.state.active.set(key, { controller, promise, purpose, taskId });
    try {
      return await result;
    } finally {
      await promise;
    }
  };
  acquireTaskWorkspace = (id: string, label: string) => {
    this.assertAvailable();
    if (this.state.taskMaintenance.has(id))
      throw new AdeError("busy", "Task data cleanup is running");
    if (this.host.isActive(id) || this.host.db.task(id).status === "queued")
      throw new AdeError("busy", "Wait for task execution to finish before opening its terminal");
    this.state.interactive.set(id, label);
    this.host.changed(id);
    return () => {
      this.state.interactive.delete(id);
      this.host.changed(id);
      void this.drain();
    };
  };
  acquireTerminal = (id: string) => this.acquireTaskWorkspace(id, "terminal session");
  drain = async () => {
    if (this.state.draining || this.state.closed || this.state.maintenance) return;
    this.state.draining = true;
    try {
      const limit = this.host.db.settings().concurrency;
      for (const t of this.host.db
        .tasks()
        .reverse()
        .filter((t) => t.status === "queued" && !t.archived)) {
        if (this.state.active.size >= limit) break;
        if (this.host.isActive(t.id) || this.state.taskMaintenance.has(t.id)) continue;
        const controller = new AbortController();
        t.status = stageStatus(t.stage);
        this.host.db.saveTask(t);
        const promise = Promise.resolve()
          .then(() => this.operations.pipeline(t, controller.signal))
          .catch((e) => {
            const latest = this.host.db.task(t.id);
            this.host.db.saveTask({
              ...latest,
              ...(latest.stage === 0 && latest.preparation_timing
                ? {
                    preparation_timing: {
                      ...latest.preparation_timing,
                      ended_at: now(),
                    },
                  }
                : {}),
              status: controller.signal.aborted
                ? this.state.closed
                  ? "interrupted"
                  : "cancelled"
                : e instanceof AdeError && e.kind === "verification_blocked"
                  ? "verification_blocked"
                  : "failed",
              error: redact(e instanceof Error ? e.message : String(e)),
              updated_at: now(),
            });
          })
          .finally(() => {
            this.state.active.delete(t.id);
            this.host.changed(t.id);
            void this.drain();
          });
        this.state.active.set(t.id, { controller, promise });
      }
    } catch (error) {
      if (!(error instanceof AdeError && error.kind === "corrupt_record")) throw error;
      this.host.publish({ event: "core.error", text: error.message });
    } finally {
      this.state.draining = false;
    }
  };
  cancel = (id: string) => {
    if (this.state.interactive.has(id))
      throw new AdeError("busy", "Close the task terminal before changing execution state");
    const active = this.state.active.get(id);
    if (active) active.controller.abort();
    else {
      const t = this.host.db.task(id);
      if (t.workflow_version === 1 && !t.workflow_start) return;
      this.host.db.saveTask({ ...t, status: "cancelled", updated_at: now() });
    }
    this.host.changed(id);
  };
}
