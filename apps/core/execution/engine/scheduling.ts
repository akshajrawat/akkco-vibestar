import { AdeError, type ActivityBlocker } from "../../domain";
import type { Engine } from "../engine";
import type { ExecutionState } from "./state";

/** Owns shared execution slots and maintenance leases; every writer observes the same state. */
export class EngineScheduling {
  constructor(
    private readonly host: Pick<Engine, "changed" | "db" | "isActive" | "publish">,
    private readonly state: ExecutionState,
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
    if (blockers.length) {
      throw new AdeError("busy", "Storage cleanup is waiting for active operations to finish.", {
        blockers,
      });
    }

    this.state.maintenance = true;
    try {
      return await operation();
    } finally {
      this.state.maintenance = false;
      this.host.changed();
      void this.drain();
    }
  };

  cleanupBlockers = (idFilter?: string): ActivityBlocker[] => {
    const blockers: ActivityBlocker[] = [];

    for (const [id, activity] of this.state.active) {
      blockers.push({
        id: `run:${id}`,
        kind: "viber",
        label: activity.purpose ? `${activity.purpose} is running` : `${id} is running`,
        stoppable: true,
      });
    }

    for (const [id, activity] of this.state.interactive) {
      blockers.push({
        id: `terminal:${id}`,
        kind: "terminal",
        label: `${activity} is open`,
        stoppable: true,
      });
    }

    for (const { blocker } of this.state.activities.values()) {
      blockers.push(blocker);
    }

    if (this.state.maintenance) {
      blockers.push({
        id: "storage-maintenance",
        kind: "maintenance",
        label: "Storage cleanup is already running",
        stoppable: false,
      });
    }

    for (const [id, activity] of this.state.sessionMaintenance) {
      blockers.push({
        id: `cleanup:${id}`,
        kind: "maintenance",
        label: activity,
        stoppable: false,
      });
    }

    if (!idFilter) {
      for (const [index, description] of [...this.state.repositoryOperations.values()].entries()) {
        blockers.push({
          id: `repository-operation:${index}`,
          kind: "repository",
          label: description,
          stoppable: false,
        });
      }
    }

    return blockers.filter(
      (b) =>
        !idFilter ||
        b.id === idFilter ||
        b.id === `run:${idFilter}` ||
        b.id === "storage-maintenance",
    );
  };

  trackActivity = (blocker: ActivityBlocker, stop: () => Promise<void>) => {
    this.assertAvailable();
    if (blocker.session_id && this.state.sessionMaintenance.has(blocker.session_id)) {
      throw new AdeError("busy", "Data cleanup is running", {
        blockers: this.cleanupBlockers(blocker.session_id),
      });
    }

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
      }
    } else {
      await this.state.activities.get(id)?.stop();
    }
  };

  withSessionMaintenance = async <T>(
    id: string,
    operation: () => Promise<T>,
    activity = "Data cleanup is running",
  ) => {
    this.assertAvailable();
    const blockers = this.cleanupBlockers(id);
    if (blockers.length) {
      throw new AdeError("busy", "Data cleanup is waiting for active operations to finish.", {
        blockers,
      });
    }

    this.state.sessionMaintenance.set(id, activity);
    try {
      return await operation();
    } finally {
      this.state.sessionMaintenance.delete(id);
      this.host.changed(id);
      void this.drain();
    }
  };

  assertAvailable = () => {
    if (this.state.maintenance || this.state.closed) {
      throw new AdeError(
        "busy",
        "Vibestar storage is being maintained. Try again when it finishes.",
      );
    }
  };

  assertExecutionSlot = (key: string) => {
    this.assertAvailable();
    if (
      this.state.active.has(key) ||
      this.state.interactive.has(key) ||
      this.state.sessionMaintenance.has(key) ||
      this.state.active.size >= this.host.db.settings().concurrency
    ) {
      throw new AdeError(
        "busy",
        "The configured execution slots are occupied. Retry this action explicitly when a slot is available.",
      );
    }
  };

  withExecutionSlot = async <T>(
    key: string,
    purpose: string,
    signal: AbortSignal,
    run: (signal: AbortSignal) => Promise<T>,
  ) => {
    this.assertExecutionSlot(key);
    const controller = new AbortController();
    const result = Promise.resolve().then(() => run(AbortSignal.any([signal, controller.signal])));

    const promise = result
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        this.state.active.delete(key);
        this.host.changed();
        void this.drain();
      });

    this.state.active.set(key, { controller, promise, purpose });
    try {
      return await result;
    } finally {
      await promise;
    }
  };

  acquireTerminal = (id: string, label = "terminal session") => {
    this.assertAvailable();
    if (this.state.sessionMaintenance.has(id)) {
      throw new AdeError("busy", "Data cleanup is running");
    }

    this.state.interactive.set(id, label);
    this.host.changed(id);
    return () => {
      this.state.interactive.delete(id);
      this.host.changed(id);
      void this.drain();
    };
  };

  drain = async () => {};
}
