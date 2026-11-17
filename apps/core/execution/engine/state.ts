import { type ActivityBlocker } from "../../domain";
import type { ApprovalDecision, FlowRun } from "../../flows/run-contracts";

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

  readonly flowRequests = new Set<Promise<unknown>>();

  readonly flowApprovals = new Map<
    string,
    { digest: string; promise: Promise<ApprovalDecision> }
  >();

  readonly flowContinuations = new Map<string, { digest: string; promise: Promise<FlowRun> }>();

  draining = false;

  closed = false;

  maintenance = false;

  readonly taskMaintenance = new Map<string, string>();

  readonly activities = new Map<string, { blocker: ActivityBlocker; stop: () => Promise<void> }>();

  readonly repositoryOperations = new Map<Promise<unknown>, string>();

  readonly repositoryController = new AbortController();
}
