import { type ActivityBlocker } from "../../domain";

/** Authoritative in-memory leases and cancellation state shared by engine operations. */
export class ExecutionState {
  readonly active = new Map<
    string,
    {
      controller: AbortController;
      promise: Promise<void>;
      sessionId?: string;
      purpose?: string;
    }
  >();

  readonly interactive = new Map<string, string>();

  draining = false;

  closed = false;

  maintenance = false;

  readonly sessionMaintenance = new Map<string, string>();

  readonly activities = new Map<string, { blocker: ActivityBlocker; stop: () => Promise<void> }>();

  readonly repositoryOperations = new Map<Promise<unknown>, string>();

  readonly repositoryController = new AbortController();
}
