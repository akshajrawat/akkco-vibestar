import type { AuthSessions } from "../execution/terminals/auth";
import type { Engine } from "../execution/engine";
import type { TaskTerminals } from "../execution/terminals/task-terminals";
import type { GitHubService } from "../github/service";
import type { IssueWatchService } from "../issue-watch/service";
import type { PRAnalysisBatches } from "../review/pr/batches";
import type { RepairService } from "../review/repair/service";
import type { ReviewService } from "../review/service";
import type { Scheduler } from "../scheduled/scheduler";
import type { StorageService } from "../storage/service";

/** Owned services supplied to domain dispatchers; callers never supply these capabilities. */
export interface RpcServices {
  engine: Engine;
  auth: AuthSessions;
  scheduler: Scheduler;
  prBatches: PRAnalysisBatches;
  github: GitHubService;
  issueWatch: IssueWatchService;
  review: ReviewService;
  repairs: RepairService;
  terminals: TaskTerminals;
  repairTerminals: TaskTerminals;
  storage: StorageService;
}
