import { AdeError } from "./domain";
import { AuthSessions } from "./execution/terminals/auth";
import type { Engine } from "./execution/engine";
import { TaskTerminals } from "./execution/terminals/task-terminals";
import { FinalizationService } from "./finalization/service";
import { GitHubService } from "./github/service";
import { IssueWatchService } from "./issue-watch/service";
import { PRAnalysisBatches } from "./review/pr/batches";
import { RepairService } from "./review/repair/service";
import { ReviewService } from "./review/service";
import { callOutput, outputMethods } from "./rpc/output";
import { callPullRequests, pullRequestsMethods } from "./rpc/pull-requests";
import { callRepairs, repairsMethods } from "./rpc/repairs";
import { callRepositories, repositoriesMethods } from "./rpc/repositories";
import { callReview, reviewMethods } from "./rpc/review";
import { callStorage, storageMethods } from "./rpc/storage";
import { callSystem, systemMethods } from "./rpc/system";
import { callTasks, tasksMethods } from "./rpc/tasks";
import { callTerminals, terminalsMethods } from "./rpc/terminals";
import { GitHubMonitor } from "./scheduled/github";
import { Scheduler } from "./scheduled/scheduler";
import { StorageService } from "./storage/service";

export class Rpc {
  private readonly handlers = new Map<
    string,
    (method: string, input: unknown) => Promise<unknown>
  >();
  private readonly auth: AuthSessions;
  readonly scheduler: Scheduler;
  readonly prBatches: PRAnalysisBatches;
  readonly github: GitHubService;
  readonly issueWatch: IssueWatchService;
  private readonly review: ReviewService;
  readonly repairs: RepairService;
  private readonly terminals: TaskTerminals;
  private readonly repairTerminals: TaskTerminals;
  private readonly storage: StorageService;
  constructor(
    readonly engine: Engine,
    monitor = new GitHubMonitor(engine.root),
    repairs = new RepairService(engine),
    issueWatch?: IssueWatchService,
    readonly finalization = new FinalizationService(engine),
  ) {
    this.scheduler = new Scheduler(engine, monitor);
    this.prBatches = new PRAnalysisBatches(engine, this.scheduler);
    this.github = new GitHubService(engine, this.scheduler);
    this.issueWatch = issueWatch || new IssueWatchService(engine, this.github.client);
    this.review = new ReviewService(engine);
    this.repairs = repairs;
    this.terminals = new TaskTerminals(engine);
    this.repairTerminals = new TaskTerminals(engine, {
      assignment: this.repairs.assignment,
      acquire: this.repairs.acquireTerminal,
    });
    this.storage = new StorageService(engine);
    this.auth = new AuthSessions(engine.root, (event) => {
      engine.publish(event);
    });
    const services = {
      engine: this.engine,
      auth: this.auth,
      scheduler: this.scheduler,
      prBatches: this.prBatches,
      github: this.github,
      issueWatch: this.issueWatch,
      review: this.review,
      repairs: this.repairs,
      terminals: this.terminals,
      repairTerminals: this.repairTerminals,
      storage: this.storage,
    };
    for (const [methods, handler] of [
      [systemMethods, callSystem],
      [repositoriesMethods, callRepositories],
      [storageMethods, callStorage],
      [tasksMethods, callTasks],
      [terminalsMethods, callTerminals],
      [repairsMethods, callRepairs],
      [outputMethods, callOutput],
      [reviewMethods, callReview],
      [pullRequestsMethods, callPullRequests],
    ] as const) {
      for (const method of methods)
        this.handlers.set(method, (method, input) => handler(services, method, input));
    }
  }
  /** Keeps transport dispatch narrow; domain handlers retain validation and ownership checks. */
  call = async (method: string, input: unknown) => {
    if (method.startsWith("git."))
      return this.finalization.call(method.slice("git.".length), input);
    if (method.startsWith("issueWatch."))
      return this.issueWatch.call(method.slice("issueWatch.".length), input);
    const handler = this.handlers.get(method);
    if (!handler) throw new AdeError("invalid_method", `Unknown method: ${method}`);
    return handler(method, input);
  };
  close = async () => {
    this.auth.dispose();
    await this.finalization.close();
    await this.issueWatch.close();
    await this.github.close();
    await this.prBatches.close();
    await this.scheduler.close();
    await this.repairTerminals.dispose();
    await this.repairs.close();
    await this.terminals.dispose();
  };
}
