import { createHash, randomUUID } from "node:crypto";

import {
  AdeError,
  SettingsSchema,
  now,
  parseIssue,
  repositoryMatchesIssue,
  type IssueRef,
  type Repository,
  type Task,
} from "../../domain";
import { fetchIssue } from "../../workspace/issue";
import type { Engine } from "../engine";

/** Owns idempotent task creation and persistence without authorizing workflow execution. */
export class TaskLifecycle {
  constructor(
    private readonly host: Pick<Engine, "assertAvailable" | "root" | "db" | "changed" | "drain">,
    private readonly operation: <T>(operation: () => Promise<T>, label?: string) => Promise<T>,
    private readonly signal: AbortSignal,
  ) {}

  private readonly creatingTasks = new Map<string, { digest: string; promise: Promise<Task> }>();

  createTask = async (
    repositoryId: string,
    url: string,
    scope: string,
    notes: string,
    scopeMode: "whole_issue" | "partial" = "partial",
    settings?: import("../../domain").Settings,
    requestId: string = randomUUID(),
  ) => {
    this.host.assertAvailable();
    if ((scopeMode === "partial" && !scope.trim()) || scope.length > 1000 || notes.length > 32000)
      throw new AdeError(
        "invalid_input",
        "Scope is required (max 1000 characters); notes max 32000",
      );
    const reference = parseIssue(url);
    const configuration = settings ? SettingsSchema.parse(settings) : undefined;

    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          repository_id: repositoryId,
          issue_url: reference.url.toLowerCase(),
          scope_mode: scopeMode,
          claimed_scope: scopeMode === "partial" ? scope.trim() : "",
          notes,
          settings: configuration || null,
        }),
      )
      .digest("hex");

    const previous = this.existingTaskRequest(requestId, digest);
    if (previous) return previous;
    const active = this.creatingTasks.get(requestId);
    if (active) {
      if (active.digest !== digest)
        throw new AdeError(
          "invalid_input",
          "This task request identity already belongs to a different payload.",
        );
      return active.promise;
    }

    this.taskRepository(repositoryId, reference);

    const promise = this.operation(async () => {
      const context = await fetchIssue(reference, this.host.root, this.signal);
      this.signal.throwIfAborted();

      const repo = {
        ...this.taskRepository(repositoryId, reference),
        selection: "explicit" as const,
      };

      this.host.db.saveRepository(repo);
      return this.enqueue(
        repo,
        reference,
        scope,
        notes,
        context,
        scopeMode,
        configuration,
        { id: requestId, digest },
        "not_started",
      );
    }, "Issue context retrieval is running").finally(() => this.creatingTasks.delete(requestId));

    this.creatingTasks.set(requestId, { digest, promise });
    return promise;
  };

  private existingTaskRequest = (id: string, digest: string) => {
    const row = this.host.db.all<{ digest: string; task_id: string | null }>(
      "SELECT digest,task_id FROM task_requests WHERE request_id=?",
      id,
    )[0];

    if (!row) return undefined;
    if (row.digest !== digest)
      throw new AdeError(
        "invalid_input",
        "This task request identity already belongs to a different payload.",
      );
    if (!row.task_id)
      throw new AdeError(
        "request_completed",
        "This request already created a task whose history was removed. Start a new explicit request to create another task.",
      );
    return this.host.db.task(row.task_id);
  };

  taskRepository = (id: string, reference: IssueRef) => {
    const repo = this.host.db.repository(id);
    if (repo.connected === false)
      throw new AdeError("repository_missing", "Reconnect this repository before creating a task.");
    if (!repositoryMatchesIssue(repo, reference))
      throw new AdeError(
        "repository_mismatch",
        `Repository mismatch: this issue belongs to ${reference.owner}/${reference.repo}. Selected repository: ${repo.owner}/${repo.name}.`,
      );
    return repo;
  };

  enqueue = (
    repo: Repository,
    reference: IssueRef,
    scope: string,
    notes: string,
    issue: Record<string, unknown>,
    scopeMode: "whole_issue" | "partial" = "partial",
    settings?: import("../../domain").Settings,
    request?: { id: string; digest: string },
    status: "queued" | "not_started" = "queued",
  ) => {
    this.host.assertAvailable();

    const t = this.host.db.transaction(() => {
      const previous = request && this.existingTaskRequest(request.id, request.digest);
      if (previous) return previous;

      const t: Task = {
        id: randomUUID(),
        repo_id: repo.id,
        issue_number: reference.number,
        issue_url: reference.url,
        claimed_scope: scopeMode === "partial" ? scope.trim() : "",
        scope_mode: scopeMode,
        notes,
        verification_policy: "repository",
        issue,
        execution_settings: settings ?? this.host.db.settings(),
        branch_name: "",
        base_branch: repo.base_branch,
        base_commit_sha: "",
        worktree_path: "",
        created_at: now(),
        updated_at: now(),
        status,
        workflow_version: status === "not_started" ? 1 : undefined,
        stage: 0,
        error: null,
      };

      this.host.db.run(
        "INSERT INTO issues VALUES(?,?,?) ON CONFLICT(repo_id,number) DO UPDATE SET data=excluded.data",
        repo.id,
        reference.number,
        JSON.stringify(issue),
      );

      this.host.db.saveTask(t);
      if (request)
        this.host.db.run(
          "INSERT INTO task_requests VALUES(?,?,?,?)",
          request.id,
          request.digest,
          t.id,
          now(),
        );
      return t;
    });

    this.host.changed(t.id);
    if (t.status === "queued") void this.host.drain();
    return t;
  };
}
