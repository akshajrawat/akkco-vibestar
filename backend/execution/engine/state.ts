import { type ActivityBlocker, type Task } from "../../domain";
/** Authoritative in-memory leases and cancellation state shared by engine operations. */
export class ExecutionState {
  readonly active = new Map<
    string,
    {
      controller: AbortController;
      promise: Promise<void>;
      taskId?: string;
      purpose?: string;
    }
  >();
  readonly interactive = new Map<string, string>();
  readonly startingWorkflows = new Map<string, { digest: string; promise: Promise<Task> }>();
  draining = false;
  closed = false;
  maintenance = false;
  readonly taskMaintenance = new Map<string, string>();
  readonly activities = new Map<string, { blocker: ActivityBlocker; stop: () => Promise<void> }>();
  readonly repositoryOperations = new Map<Promise<unknown>, string>();
  readonly repositoryController = new AbortController();
}
