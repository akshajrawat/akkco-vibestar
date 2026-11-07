import { createHash, randomUUID } from "node:crypto";

import {
  AdeError,
  now,
  parseIssue,
  repositoryMatchesIssue,
  type IssueRef,
  type Task,
} from "../../domain";
import { fetchIssue } from "../../workspace/issue";
import { GeneralTaskCreateSchema, IssueTaskCreateSchema } from "../../flows/contracts";
import { FlowStore } from "../../flows/store";
import { instantiateTemplate, type TemplateId } from "../../flows/templates";
import type { z } from "zod";
import type { Engine } from "../engine";

/** Owns idempotent task creation and persistence without authorizing workflow execution. */
export class TaskLifecycle {
  constructor(
    private readonly host: Pick<Engine, "assertAvailable" | "root" | "db" | "changed">,
    private readonly operation: <T>(operation: () => Promise<T>, label?: string) => Promise<T>,
    private readonly signal: AbortSignal,
  ) {}

  private readonly creatingTasks = new Map<string, { digest: string; promise: Promise<Task> }>();

  private saveInitialFlow = (task: Task, profileId: string, template?: TemplateId) => {
    const flows = new FlowStore(this.host.db);
    const profile = flows.profile(profileId);

    const definition = template
      ? instantiateTemplate(template, randomUUID)
      : {
          name: "Solo Viber",
          nodes: [
            {
              id: randomUUID(),
              type: "agent" as const,
              name: profile.name,
              profile_id: profile.id,
              instructions: "",
              overrides: {},
              completion: { verification: "record-only" as const, review: "none" as const },
              inputs: [{ kind: "task-goal" as const }],
            },
          ],
          edges: [],
        };

    return flows.saveDefinition(
      task.flow_id!,
      {
        ...definition,
        nodes: definition.nodes.map((node) =>
          node.type === "agent"
            ? {
                ...node,
                inputs: [
                  ...node.inputs,
                  ...(task.repo_id ? [{ kind: "repository" as const }] : []),
                  ...(task.issue_url
                    ? [{ kind: "issue" as const }, { kind: "task-brief" as const }]
                    : []),
                ],
              }
            : node,
        ),
      },
      null,
      task.id,
    );
  };

  /** General tasks use the same owners, conversations and run records as issue tasks. */
  createGeneralTask = (input: z.input<typeof GeneralTaskCreateSchema>) => {
    this.host.assertAvailable();
    const request = GeneralTaskCreateSchema.parse(input);
    const digest = createHash("sha256").update(JSON.stringify(request)).digest("hex");

    const task = this.host.db.transaction(() => {
      const previous = this.existingTaskRequest(request.request_id, digest);
      if (previous) return previous;
      const repo = request.repository_id ? this.host.db.repository(request.repository_id) : null;
      if (repo?.connected === false)
        throw new AdeError(
          "repository_missing",
          "Reconnect this repository before creating a task.",
        );
      if (repo) this.host.db.saveRepository({ ...repo, selection: "explicit" });
      const timestamp = now();
      const flowId = randomUUID();

      const task: Task = {
        id: randomUUID(),
        kind: "general",
        goal: request.goal,
        flow_id: flowId,
        repo_id: repo?.id ?? null,
        issue_number: null,
        issue_url: null,
        issue: {},
        workspace_kind: repo ? undefined : "managed",
        claimed_scope: "",
        notes: "",
        branch_name: "",
        base_branch: repo?.base_branch || "",
        base_commit_sha: "",
        worktree_path: "",
        created_at: timestamp,
        updated_at: timestamp,
        stage: 0,
        status: "not_started",
        error: null,
      };

      this.host.db.saveTask(task);

      this.saveInitialFlow(task, request.profile_id, request.template);

      this.host.db.run(
        "INSERT INTO task_requests VALUES(?,?,?,?)",
        request.request_id,
        digest,
        task.id,
        timestamp,
      );

      return task;
    });

    this.host.changed(task.id);
    return task;
  };

  createIssueTask = async (input: z.input<typeof IssueTaskCreateSchema>) => {
    this.host.assertAvailable();
    const request = IssueTaskCreateSchema.parse(input);

    const {
      repository_id: repositoryId,
      issue_url: url,
      claimed_scope: scope,
      notes,
      scope_mode: scopeMode,
      request_id: requestId,
    } = request;

    const reference = parseIssue(url);
    const flow = { profile_id: request.profile_id, template: request.template };

    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          repository_id: repositoryId,
          issue_url: reference.url.toLowerCase(),
          scope_mode: scopeMode,
          claimed_scope: scopeMode === "partial" ? scope.trim() : "",
          notes,
          settings: null,
          flow,
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

      return this.host.db.transaction(() => {
        const previous = this.existingTaskRequest(requestId, digest);
        if (previous) return previous;

        const goal =
          scopeMode === "partial"
            ? scope.trim()
            : typeof context.title === "string"
              ? context.title.trim()
              : `Contribute to ${reference.url}`;

        if (!goal || goal.length > 32000)
          throw new AdeError("invalid_input", "The task goal must contain 1–32,000 characters.");
        const timestamp = now();

        const task: Task = {
          id: randomUUID(),
          kind: "issue",
          goal,
          flow_id: randomUUID(),
          repo_id: repo.id,
          issue_number: reference.number,
          issue_url: reference.url,
          claimed_scope: scopeMode === "partial" ? scope.trim() : "",
          scope_mode: scopeMode,
          notes,
          verification_policy: "repository",
          issue: context,
          branch_name: "",
          base_branch: repo.base_branch,
          base_commit_sha: "",
          worktree_path: "",
          created_at: timestamp,
          updated_at: timestamp,
          status: "not_started",
          stage: 0,
          error: null,
        };

        this.host.db.run(
          "INSERT INTO issues VALUES(?,?,?) ON CONFLICT(repo_id,number) DO UPDATE SET data=excluded.data",
          repo.id,
          reference.number,
          JSON.stringify(context),
        );

        this.host.db.saveTask(task);
        this.saveInitialFlow(task, flow.profile_id, flow.template);

        this.host.db.run(
          "INSERT INTO task_requests VALUES(?,?,?,?)",
          requestId,
          digest,
          task.id,
          timestamp,
        );

        this.host.changed(task.id);
        return task;
      });
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

  taskRepository = (id: string | null, reference: IssueRef) => {
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
}
