import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import { AdeError, now } from "../domain";
import type { Database } from "../storage/database";
import type { AgentExecution } from "../execution/contracts";
import {
  FlowDefinitionSchema,
  resolveAgentNode,
  nodeDependencies,
  type FlowDefinition,
} from "./contracts";
import { FlowStore } from "./store";
import { resolveNodeInputs } from "./context";
import {
  ApprovalDecisionSchema,
  FlowRunSchema,
  FlowStartSchema,
  FlowRunSnapshotSchema,
  NodeAttemptSchema,
  ResolvedInputsSchema,
  ConversationScopeSchema,
  FlowRunInvalidationSchema,
  agentNodePrompt,
  type ApprovalDecision,
  type FlowRun,
  type NodeAttempt,
  type ResolvedInputs,
} from "./run-contracts";
import { observedVerification } from "./verification";
import { FlowRunResults } from "./run-results";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identity = z.string().uuid();

/** A chat captures one existing Viber with its original access; it cannot settle the connected graph. */
const scopedDefinition = (
  definition: FlowDefinition,
  conversation?: z.infer<typeof ConversationScopeSchema>,
) => {
  if (!conversation) return definition;
  const node = definition.nodes.find((node) => node.id === conversation.node_id);
  if (node?.type !== "agent")
    throw new AdeError("isolation", "Select a Viber from this task's saved graph.");
  return FlowDefinitionSchema.parse({
    name: `Viber · ${node.name}`.slice(0, 100),
    nodes: [
      {
        ...node,
        inputs: conversation.inputs,
        overrides: { ...node.overrides, output: "conversation" },
        completion: { verification: "record-only", review: "none" },
      },
    ],
    edges: [],
  });
};

const runTransitions: Record<FlowRun["status"], FlowRun["status"][]> = {
  queued: ["running", "paused", "cancelled", "interrupted", "failed"],
  running: ["pausing", "paused", "waiting", "completed", "failed", "cancelled", "interrupted"],
  pausing: ["paused", "failed", "cancelled", "interrupted"],
  paused: ["queued", "running", "cancelled", "continued", "failed"],
  waiting: ["queued", "running", "paused", "completed", "failed", "cancelled"],
  completed: [],
  failed: ["queued", "running", "cancelled"],
  cancelled: ["queued", "running"],
  interrupted: ["queued", "running", "cancelled"],
  continued: [],
};

/** Durable execution state only; callers must acquire the engine's slots/leases before processes. */
export class FlowRunStore {
  private readonly definitions: FlowStore;

  private readonly resultViews: FlowRunResults;

  constructor(private readonly db: Database) {
    this.definitions = new FlowStore(db);

    this.resultViews = new FlowRunResults(db, {
      run: this.run,
      definition: this.definition,
      attempts: this.attempts,
      attempt: this.attempt,
    });
  }

  createRun = (
    input: z.input<typeof FlowStartSchema>,
    origin: FlowRun["origin"] = "user",
    scope?: z.input<typeof ConversationScopeSchema>,
  ) => {
    const request = FlowStartSchema.parse(input);
    const conversation = scope && ConversationScopeSchema.parse(scope);
    if (conversation && origin !== "user")
      throw new AdeError("isolation", "Conversation authority requires an explicit user request.");
    const kind = conversation ? "conversation" : "flow";
    const requestDigest = digest(conversation ? { ...request, conversation } : request);
    return this.db.transaction(() => {
      const previous = this.db.all<{ id: string; request_digest: string; origin: string }>(
        "SELECT id,request_digest,origin FROM flow_runs WHERE request_id=?",
        request.request_id,
      )[0];

      if (previous) {
        if (previous.request_digest !== requestDigest || previous.origin !== origin)
          throw new AdeError(
            "request_conflict",
            "This run request belongs to a different configuration.",
          );
        return this.run(previous.id);
      }

      this.db.task(request.task_id);

      const owner = this.db.all<{ task_id: string | null }>(
        "SELECT task_id FROM flow_definitions WHERE id=?",
        request.flow_id,
      )[0];

      if (!owner || owner.task_id !== request.task_id)
        throw new AdeError("isolation", "Only a flow owned by this task can execute.");
      if (request.parent_run_id) {
        const parent = this.run(request.parent_run_id);
        if (parent.task_id !== request.task_id || parent.flow_id !== request.flow_id)
          throw new AdeError("isolation", "A continuation must belong to the same task and flow.");
        if (
          parent.kind !== "flow" ||
          (conversation
            ? ["queued", "running", "pausing"]
            : ["queued", "running", "pausing", "waiting"]
          ).includes(parent.status)
        )
          throw new AdeError(
            "busy",
            "Pause or stop the previous run before creating a continuation.",
          );
      }

      const active = this.db.all<Pick<FlowRun, "id" | "kind" | "status">>(
        "SELECT id,kind,status FROM flow_runs WHERE task_id=? AND status IN ('queued','running','pausing','paused','waiting')",
        request.task_id,
      );

      if (
        active.some(
          (row) =>
            row.id !== request.parent_run_id ||
            (conversation && (row.kind !== "flow" || !["paused", "waiting"].includes(row.status))),
        )
      )
        throw new AdeError("busy", "This task already has an active flow run.");
      const revision = this.definitions.definition(request.flow_id, request.revision);
      const definition = scopedDefinition(revision.definition, conversation);
      if (!definition.nodes.length)
        throw new AdeError("invalid_input", "Add a node before running this flow.");

      const agents = Object.fromEntries(
        definition.nodes
          .filter((node) => node.type === "agent")
          .map((node) => [
            node.id,
            resolveAgentNode(node, this.definitions.profile(node.profile_id)),
          ]),
      );

      const timestamp = now();
      const { goal, ...capturedRequest } = request;

      const run = FlowRunSchema.parse({
        id: randomUUID(),
        ...capturedRequest,
        request_digest: requestDigest,
        status: "queued",
        origin,
        kind,
        snapshot: { goal, agents, ...(conversation ? { conversation } : {}) },
        created_at: timestamp,
        updated_at: timestamp,
        error: null,
      });

      if (
        !conversation &&
        request.parent_run_id &&
        this.run(request.parent_run_id).status === "paused"
      )
        this.setRunStatus(request.parent_run_id, "paused", "continued");

      this.db.run(
        "INSERT INTO flow_runs(id,flow_id,revision,task_id,status,request_id,request_digest,parent_run_id,snapshot,created_at,updated_at,error,origin,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        run.id,
        run.flow_id,
        run.revision,
        run.task_id,
        run.status,
        run.request_id,
        run.request_digest,
        run.parent_run_id,
        JSON.stringify(run.snapshot),
        run.created_at,
        run.updated_at,
        run.error,
        run.origin,
        run.kind,
      );

      this.transition(run.id, null, null, run.status);
      return run;
    });
  };

  run = (id: string): FlowRun => {
    identity.parse(id);

    const row = this.db.all<Omit<FlowRun, "snapshot"> & { snapshot: string }>(
      "SELECT * FROM flow_runs WHERE id=?",
      id,
    )[0];

    if (!row) throw new AdeError("not_found", "Flow run not found.");
    return this.db.records.decode(
      { table: "flow_runs", id, column: "snapshot", source: row.snapshot },
      (value) => {
        const run = FlowRunSchema.parse({ ...row, snapshot: FlowRunSnapshotSchema.parse(value) });
        if (
          (run.kind === "conversation") !== !!run.snapshot.conversation ||
          (run.kind === "conversation" && run.origin !== "user")
        )
          throw new Error("Run kind and captured conversation authority disagree.");

        const nodes = scopedDefinition(
          this.definitions.definition(run.flow_id, run.revision).definition,
          run.snapshot.conversation,
        ).nodes.filter((node) => node.type === "agent");

        if (
          nodes.length !== Object.keys(run.snapshot.agents).length ||
          nodes.some((node) => {
            const captured = run.snapshot.agents[node.id];
            return (
              !captured || digest(captured) !== digest(resolveAgentNode(node, captured.profile))
            );
          })
        )
          throw new Error("Captured profiles do not match this run's flow revision.");
        return run;
      },
    );
  };

  attempts = (runId: string) => {
    this.run(runId);
    return this.db
      .all<{ id: string }>("SELECT id FROM flow_node_attempts WHERE run_id=? ORDER BY rowid", runId)
      .map((row) => this.attempt(row.id));
  };

  results = (runId: string, options: { includeStale?: boolean } = {}) =>
    this.resultViews.results(runId, options);

  staleResults = (runId: string) => this.resultViews.staleResults(runId);

  invalidation = (runId: string) => this.resultViews.invalidation(runId);

  /** External conversation writes stop pending graph authority without rewriting any past result or decision. */
  invalidateWorkspace = (runId: string, reason: string) =>
    this.db.transaction(() => {
      const run = this.run(runId);
      if (run.kind !== "flow")
        throw new AdeError(
          "isolation",
          "Only graph authority can be invalidated by a separate Viber conversation.",
        );
      if (this.attempts(runId).some((attempt) => attempt.status === "running"))
        throw new AdeError(
          "busy",
          "Stop the active graph node before invalidating its workspace evidence.",
        );

      const invalidation = FlowRunInvalidationSchema.parse({
        run_id: runId,
        reason,
        created_at: now(),
      });

      this.db.run(
        "INSERT INTO flow_run_invalidations VALUES(?,?,?) ON CONFLICT(run_id) DO NOTHING",
        runId,
        invalidation.reason,
        invalidation.created_at,
      );

      for (const attempt of this.attempts(runId).filter(
        (attempt) => attempt.status === "waiting",
      )) {
        this.db.run(
          "UPDATE flow_node_attempts SET status='interrupted',ended_at=?,error=? WHERE id=?",
          now(),
          invalidation.reason,
          attempt.id,
        );

        this.transition(runId, attempt.id, "waiting", "interrupted");
      }

      if (["queued", "running", "pausing", "paused", "waiting"].includes(run.status))
        this.setRunStatus(runId, run.status, "failed", invalidation.reason);
      return this.invalidation(runId)!;
    });

  invalidateReusedResults = (runId: string, reason: string) => {
    this.run(runId);

    this.db.run(
      "INSERT INTO flow_result_invalidations(run_id,node_id,reason,created_at) SELECT run_id,node_id,?,? FROM flow_result_links WHERE run_id=? ON CONFLICT(run_id,node_id) DO NOTHING",
      z.string().min(1).max(32000).parse(reason),
      now(),
      runId,
    );
  };

  linkResult = (runId: string, nodeId: string, sourceId: string, workspaceFingerprint: string) =>
    this.db.transaction(() => {
      const run = this.run(runId);
      const source = this.attempt(sourceId);
      const parent = run.parent_run_id && this.run(run.parent_run_id);
      if (
        run.kind !== "flow" ||
        this.run(source.run_id).kind !== "flow" ||
        run.status !== "queued" ||
        !parent ||
        !this.results(parent.id).some((result) => result.id === source.id) ||
        source.status !== "completed" ||
        source.node_id !== nodeId ||
        source.completed_fingerprint !== workspaceFingerprint
      )
        throw new AdeError(
          "stale_result",
          "Only a proved completed result from this continuation's parent can be reused.",
        );
      const graph = this.definition(runId);
      const node = graph.nodes.find((node) => node.id === nodeId);
      if (
        !node ||
        source.configuration_hash !==
          digest({ node, agent: node.type === "agent" ? run.snapshot.agents[nodeId] : null })
      )
        throw new AdeError(
          "stale_result",
          "The node configuration changed; recompute it explicitly.",
        );
      const results = this.results(runId);
      if (
        JSON.stringify(nodeDependencies(this.definition(source.run_id), nodeId)) !==
        JSON.stringify(nodeDependencies(graph, nodeId))
      )
        throw new AdeError(
          "stale_result",
          "The node's dependencies changed; recompute it explicitly.",
        );
      if (
        results.some((result) => result.node_id === nodeId) ||
        graph.edges.some(
          (edge) =>
            edge.target === nodeId &&
            results.filter((result) => result.node_id === edge.source).at(-1)?.status !==
              "completed",
        )
      )
        throw new AdeError(
          "dependencies",
          "Reused nodes require their own completed predecessors and cannot replace an attempt.",
        );
      if (digest(resolveNodeInputs(this.db, this, runId, nodeId)) !== source.inputs_hash)
        throw new AdeError(
          "stale_result",
          "The selected inputs changed; recompute this node explicitly.",
        );
      if (
        node.type === "approval" &&
        !this.db.all(
          "SELECT attempt_id FROM flow_approval_decisions WHERE attempt_id=? AND decision='accepted'",
          source.id,
        ).length
      )
        throw new AdeError(
          "stale_approval",
          "A reused approval requires its original accepted decision.",
        );

      this.db.run(
        "INSERT INTO flow_result_links VALUES(?,?,?,?,?)",
        runId,
        nodeId,
        source.id,
        workspaceFingerprint,
        now(),
      );

      return source;
    });

  definition = (runId: string) => {
    const run = this.run(runId);
    return scopedDefinition(
      this.definitions.definition(run.flow_id, run.revision).definition,
      run.snapshot.conversation,
    );
  };

  attempt = (id: string): NodeAttempt => {
    identity.parse(id);

    const row = this.db.all<
      Omit<NodeAttempt, "configuration" | "inputs"> & { configuration: string; inputs: string }
    >("SELECT * FROM flow_node_attempts WHERE id=?", id)[0];

    if (!row) throw new AdeError("not_found", "Node attempt not found.");

    const inputs = this.db.records.decode(
      { table: "flow_node_attempts", id, column: "inputs", source: row.inputs },
      ResolvedInputsSchema.parse,
    );

    return this.db.records.decode(
      { table: "flow_node_attempts", id, column: "configuration", source: row.configuration },
      (configuration) => {
        const attempt = NodeAttemptSchema.parse({ ...row, inputs, configuration });
        if (
          attempt.node_id !== attempt.configuration.node.id ||
          digest(attempt.configuration) !== attempt.configuration_hash ||
          digest(attempt.inputs) !== attempt.inputs_hash
        )
          throw new Error("Node attempt snapshot integrity failed.");
        return attempt;
      },
    );
  };

  setRunStatus = (
    id: string,
    expected: FlowRun["status"],
    next: FlowRun["status"],
    error: string | null = null,
  ) =>
    this.db.transaction(() => {
      const run = this.run(id);
      if (run.status !== expected || !runTransitions[run.status].includes(next))
        throw new AdeError(
          "invalid_state",
          "The flow run changed or this transition is not allowed.",
        );
      const attempts = this.results(id);
      if (
        ["paused", "completed", "waiting", "continued"].includes(next) &&
        attempts.some((attempt) => attempt.status === "running")
      )
        throw new AdeError("busy", "Wait for the current node to stop before settling this run.");
      if (next === "completed") {
        const nodes = this.definition(run.id).nodes;
        if (
          nodes.some(
            (node) =>
              attempts.filter((attempt) => attempt.node_id === node.id).at(-1)?.status !==
              "completed",
          )
        )
          throw new AdeError(
            "invalid_state",
            "Every node must complete before the flow can complete.",
          );
      }

      const updated = FlowRunSchema.parse({ ...run, status: next, error, updated_at: now() });
      if (next === "cancelled" || next === "continued") {
        for (const attempt of attempts.filter((entry) => entry.status === "waiting")) {
          const status = next === "cancelled" ? "cancelled" : "interrupted";

          this.db.run(
            "UPDATE flow_node_attempts SET status=?,ended_at=?,error=? WHERE id=?",
            status,
            updated.updated_at,
            next === "cancelled"
              ? "The run was cancelled before approval."
              : "A linked continuation replaced this pending approval.",
            attempt.id,
          );

          this.transition(id, attempt.id, "waiting", status);
        }
      }

      this.db.run(
        "UPDATE flow_runs SET status=?,updated_at=?,error=? WHERE id=?",
        next,
        updated.updated_at,
        updated.error,
        id,
      );

      this.transition(id, null, expected, next);
      return updated;
    });

  beginAttempt = (
    runId: string,
    nodeId: string,
    inputs: ResolvedInputs,
    workspaceFingerprint: string,
    retryOf?: string,
    dispatchId?: string,
  ) =>
    this.db.transaction(() => {
      const run = this.run(runId);
      if (run.status !== "running")
        throw new AdeError("invalid_state", "Explicitly continue the flow before starting a node.");
      if (dispatchId) {
        const dispatch = this.db.all<{
          run_id: string;
          kind: string;
          node_id: string | null;
          retry_of: string | null;
          status: string;
        }>(
          "SELECT run_id,kind,node_id,retry_of,status FROM flow_dispatches WHERE id=?",
          dispatchId,
        )[0];

        if (
          !dispatch ||
          dispatch.run_id !== runId ||
          dispatch.status !== "running" ||
          (dispatch.kind !== "flow" && dispatch.node_id !== nodeId) ||
          (dispatch.retry_of ?? undefined) !== retryOf
        )
          throw new AdeError("isolation", "This node is outside its explicit execution request.");
      }

      if (this.invalidation(run.id))
        throw new AdeError(
          "stale_workspace",
          "A separate Viber changed this graph's workspace. Apply a saved revision or start a fresh run explicitly.",
        );
      const flow = this.definition(run.id);
      const node = flow.nodes.find((entry) => entry.id === nodeId);
      if (!node)
        throw new AdeError("isolation", "This node is not part of the captured flow revision.");
      const attempts = this.results(runId);
      const latest = (id: string) => attempts.filter((attempt) => attempt.node_id === id).at(-1);
      if (
        this.db.all(
          "SELECT a.id FROM flow_node_attempts a JOIN flow_runs r ON r.id=a.run_id WHERE r.task_id=? AND a.status='running'",
          run.task_id,
        ).length
      )
        throw new AdeError("busy", "Operations sharing this task workspace must execute serially.");
      const previous = latest(nodeId);
      if (
        previous &&
        (retryOf !== previous.id ||
          !["failed", "rejected", "cancelled", "interrupted"].includes(previous.status))
      )
        throw new AdeError(
          "invalid_state",
          "Retry must explicitly identify the latest failed, cancelled or interrupted attempt.",
        );
      if (!previous && retryOf)
        throw new AdeError("invalid_state", "This node has no attempt to retry.");
      if (
        flow.edges.some(
          (edge) => edge.target === nodeId && latest(edge.source)?.status !== "completed",
        )
      )
        throw new AdeError(
          "dependencies",
          "Wait for all required predecessors to complete successfully.",
        );
      const resolvedInputs = ResolvedInputsSchema.parse(inputs);
      if (
        JSON.stringify(resolvedInputs.map((entry) => entry.binding)) !== JSON.stringify(node.inputs)
      )
        throw new AdeError(
          "context",
          "Resolved inputs must match every selected binding in order.",
        );
      for (const entry of resolvedInputs) {
        const binding = entry.binding;
        if (binding.kind === "task-goal" && entry.content !== run.snapshot.goal)
          throw new AdeError("context", "Task goal input differs from the captured run goal.");
        if (binding.kind === "output" && entry.content !== latest(binding.node_id)?.output)
          throw new AdeError(
            "context",
            "Predecessor output differs from the captured completed result.",
          );
      }

      if (
        JSON.stringify(resolvedInputs) !==
        JSON.stringify(resolveNodeInputs(this.db, this, runId, nodeId))
      )
        throw new AdeError(
          "context",
          "Selected inputs changed or do not match their owned source records.",
        );

      const timestamp = now();

      const configuration = {
        node,
        agent: node.type === "agent" ? run.snapshot.agents[nodeId] : null,
      };

      const attempt = NodeAttemptSchema.parse({
        id: randomUUID(),
        run_id: runId,
        node_id: nodeId,
        ordinal: (previous?.ordinal || 0) + 1,
        status: node.type === "approval" ? "waiting" : "running",
        configuration,
        configuration_hash: digest(configuration),
        inputs: resolvedInputs,
        inputs_hash: digest(resolvedInputs),
        workspace_fingerprint: workspaceFingerprint,
        completed_fingerprint: null,
        agent_run_id: null,
        command_run_id: null,
        started_at: timestamp,
        ended_at: null,
        output: null,
        verification: "missing",
        dispatch_id: dispatchId ?? null,
        error: null,
      });

      this.db.run(
        "INSERT INTO flow_node_attempts(id,run_id,node_id,ordinal,status,configuration,configuration_hash,inputs,inputs_hash,workspace_fingerprint,agent_run_id,command_run_id,started_at,ended_at,output,verification,error,dispatch_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        attempt.id,
        attempt.run_id,
        attempt.node_id,
        attempt.ordinal,
        attempt.status,
        JSON.stringify(attempt.configuration),
        attempt.configuration_hash,
        JSON.stringify(attempt.inputs),
        attempt.inputs_hash,
        attempt.workspace_fingerprint,
        null,
        null,
        timestamp,
        null,
        null,
        attempt.verification,
        null,
        attempt.dispatch_id,
      );

      this.transition(runId, attempt.id, null, attempt.status);
      return attempt;
    });

  assertAgentExecution = (
    attemptId: string,
    taskId: string,
    execution: AgentExecution,
    prompt: string,
  ) => {
    const attempt = this.attempt(attemptId);
    const run = this.run(attempt.run_id);
    if (
      run.task_id !== taskId ||
      !!this.invalidation(run.id) ||
      run.status !== "running" ||
      attempt.status !== "running" ||
      attempt.configuration.node.type !== "agent" ||
      digest(attempt.configuration.agent?.execution) !== digest(execution) ||
      prompt !== agentNodePrompt(attempt)
    )
      throw new AdeError("isolation", "Agent execution must match its active task/node snapshot.");
  };

  assertCommandExecution = (
    attemptId: string,
    taskId: string,
    argv: string[],
    readOnly: boolean,
    timeoutMs: number,
  ) => {
    const attempt = this.attempt(attemptId);
    const run = this.run(attempt.run_id);
    const node = attempt.configuration.node;
    if (
      run.task_id !== taskId ||
      run.status !== "running" ||
      !!this.invalidation(run.id) ||
      attempt.status !== "running" ||
      node.type !== "command" ||
      JSON.stringify(argv) !== JSON.stringify(node.argv) ||
      readOnly !== (node.access === "read-only") ||
      timeoutMs !== node.timeout_secs * 1000
    )
      throw new AdeError(
        "isolation",
        "Command execution must match its active task/node snapshot.",
      );
  };

  attachExecution = (attemptId: string, recordId: string, kind: "agent" | "command") =>
    this.db.transaction(() => {
      identity.parse(recordId);
      const attempt = this.attempt(attemptId);
      const run = this.run(attempt.run_id);
      if (
        attempt.status !== "running" ||
        attempt.configuration.node.type !== kind ||
        attempt.agent_run_id ||
        attempt.command_run_id
      )
        throw new AdeError("invalid_state", "This attempt cannot attach another execution record.");
      const table = kind === "agent" ? "agent_runs" : "test_runs";

      const record = this.db.all<{ task_id: string | null; repair_id: string | null }>(
        `SELECT task_id,repair_id FROM ${table} WHERE id=?`,
        recordId,
      )[0];

      if (!record || record.task_id !== run.task_id || record.repair_id)
        throw new AdeError("isolation", "Execution telemetry must belong to the same task.");

      this.db.run(
        `UPDATE flow_node_attempts SET ${kind === "agent" ? "agent_run_id" : "command_run_id"}=? WHERE id=?`,
        recordId,
        attemptId,
      );

      return this.attempt(attemptId);
    });

  refreshApproval = (id: string) =>
    this.db.transaction(() => {
      const attempt = this.attempt(id);
      const run = this.run(attempt.run_id);
      if (
        attempt.configuration.node.type !== "approval" ||
        attempt.status !== "waiting" ||
        !["paused", "waiting", "failed"].includes(run.status) ||
        this.db.all("SELECT attempt_id FROM flow_approval_decisions WHERE attempt_id=?", id).length
      )
        throw new AdeError(
          "invalid_state",
          "Only a waiting undecided approval can be explicitly refreshed.",
        );

      this.db.run(
        "UPDATE flow_node_attempts SET status='interrupted',ended_at=?,error='The user requested fresh approval evidence.' WHERE id=?",
        now(),
        id,
      );

      this.transition(run.id, id, "waiting", "interrupted");
      return this.attempt(id);
    });

  finishAttempt = (
    id: string,
    status: "completed" | "failed" | "cancelled" | "interrupted",
    output: string | null,
    verification: NodeAttempt["verification"],
    error: string | null = null,
    completedFingerprint: string | null = null,
  ) =>
    this.db.transaction(() => {
      const attempt = this.attempt(id);
      if (attempt.status !== "running")
        throw new AdeError(
          "invalid_state",
          "Only an active process attempt can settle; approval nodes require a decision.",
        );
      if (status === "completed") {
        const recordId = attempt.agent_run_id || attempt.command_run_id;
        const table = attempt.agent_run_id ? "agent_runs" : "test_runs";

        const record =
          recordId &&
          this.db.all<{ status: string; exit_code: number | null; output: string | null }>(
            `SELECT status,exit_code,${attempt.agent_run_id ? "output" : "NULL AS output"} FROM ${table} WHERE id=?`,
            recordId,
          )[0];

        if (!record || record.exit_code !== 0 || !["completed", "passed"].includes(record.status))
          throw new AdeError(
            "missing_evidence",
            "A completed node requires its successful observed execution record.",
          );
        if (attempt.agent_run_id && output !== record.output)
          throw new AdeError(
            "missing_evidence",
            "Node output must match its retained agent result.",
          );
        if (
          attempt.command_run_id &&
          output !== JSON.stringify({ command_run_id: attempt.command_run_id })
        )
          throw new AdeError(
            "missing_evidence",
            "Command output must reference its observed command record.",
          );

        if (verification === "passed" && observedVerification(this.db, attempt) !== "passed")
          throw new AdeError(
            "missing_evidence",
            "Passing verification requires observed passing checks, not provider reports.",
          );
        const node = attempt.configuration.node;
        if (
          node.type === "agent" &&
          node.completion.verification === "require-passing" &&
          verification !== "passed"
        ) {
          status = "failed";
          error = "The process completed, but required verification did not pass.";
        }

        if (node.type === "agent" && node.completion.review === "require-approved") {
          let approved = false;
          try {
            approved = JSON.parse(output || "null")?.approval === "approved";
          } catch {
            /* Invalid review output cannot satisfy approval. */
          }

          if (!approved) {
            status = "failed";
            error = "The process completed without an approved independent review.";
          }
        }
      }

      const updated = NodeAttemptSchema.parse({
        ...attempt,
        status,
        output,
        verification,
        error,
        ended_at: now(),
        completed_fingerprint: completedFingerprint,
      });

      this.db.run(
        "UPDATE flow_node_attempts SET status=?,ended_at=?,output=?,verification=?,error=?,completed_fingerprint=? WHERE id=?",
        updated.status,
        updated.ended_at,
        updated.output,
        updated.verification,
        updated.error,
        updated.completed_fingerprint,
        id,
      );

      this.transition(attempt.run_id, id, attempt.status, status);
      return updated;
    });

  decideApproval = (input: Omit<ApprovalDecision, "created_at">, currentFingerprint: string) =>
    this.db.transaction(() => {
      const decision = ApprovalDecisionSchema.parse({ ...input, created_at: now() });
      const attempt = this.attempt(decision.attempt_id);
      if (
        attempt.configuration.node.type !== "approval" ||
        attempt.configuration_hash !== decision.configuration_hash ||
        attempt.inputs_hash !== decision.inputs_hash ||
        decision.workspace_fingerprint !== attempt.workspace_fingerprint
      )
        throw new AdeError(
          "stale_approval",
          "The approval configuration, inputs or workspace changed. Inspect a fresh attempt.",
        );

      const stored = this.db.all<ApprovalDecision>(
        "SELECT * FROM flow_approval_decisions WHERE attempt_id=? OR request_id=?",
        decision.attempt_id,
        decision.request_id,
      )[0];

      if (stored) {
        const previous = ApprovalDecisionSchema.parse(stored);
        if (
          JSON.stringify({ ...previous, created_at: "" }) !==
          JSON.stringify({ ...decision, created_at: "" })
        )
          throw new AdeError(
            "request_conflict",
            "This approval request already has a different decision.",
          );
        return previous;
      }

      if (currentFingerprint !== attempt.workspace_fingerprint)
        throw new AdeError(
          "stale_approval",
          "The approval workspace changed. Inspect a fresh attempt.",
        );
      const run = this.run(attempt.run_id);
      if (
        attempt.status !== "waiting" ||
        !["running", "waiting", "paused", "failed"].includes(run.status)
      )
        throw new AdeError("invalid_state", "This approval is no longer waiting for a decision.");

      this.db.run(
        "INSERT INTO flow_approval_decisions VALUES(?,?,?,?,?,?,?)",
        decision.attempt_id,
        decision.request_id,
        decision.decision,
        decision.configuration_hash,
        decision.inputs_hash,
        decision.workspace_fingerprint,
        decision.created_at,
      );

      const next = decision.decision === "accepted" ? "completed" : "rejected";

      this.db.run(
        "UPDATE flow_node_attempts SET status=?,ended_at=?,output=?,completed_fingerprint=? WHERE id=?",
        next,
        decision.created_at,
        JSON.stringify({ decision: decision.decision }),
        next === "completed" ? currentFingerprint : null,
        attempt.id,
      );

      this.transition(attempt.run_id, attempt.id, "waiting", next);
      return decision;
    });

  interruptUnfinished = () =>
    this.db.transaction(() => {
      for (const row of this.db.all<{ id: string; run_id: string }>(
        "SELECT id,run_id FROM flow_node_attempts WHERE status='running'",
      )) {
        try {
          const attempt = this.attempt(row.id);

          this.finishAttempt(
            attempt.id,
            "interrupted",
            attempt.output,
            attempt.verification,
            "The execution core restarted. Retry explicitly; no process was replayed.",
          );
        } catch (error) {
          if (!(error instanceof AdeError && error.kind === "corrupt_record")) throw error;

          this.db.run(
            "UPDATE flow_node_attempts SET status='interrupted',ended_at=?,error=? WHERE id=?",
            now(),
            "The core restarted and this node snapshot is corrupt. Original bytes are preserved; inspect persistence diagnostics before retrying.",
            row.id,
          );

          this.transition(row.run_id, row.id, "running", "interrupted");
        }
      }

      for (const row of this.db.all<{ id: string; status: FlowRun["status"] }>(
        "SELECT id,status FROM flow_runs WHERE status IN ('queued','running','pausing')",
      )) {
        try {
          const run = this.run(row.id);

          this.db.run(
            "UPDATE flow_runs SET status='interrupted',updated_at=?,error=? WHERE id=?",
            now(),
            "The execution core restarted. Continue explicitly.",
            run.id,
          );

          this.transition(run.id, null, run.status, "interrupted");
        } catch (error) {
          if (!(error instanceof AdeError && error.kind === "corrupt_record")) throw error;

          this.db.run(
            "UPDATE flow_runs SET status='interrupted',updated_at=?,error=? WHERE id=?",
            now(),
            "The core restarted and this run snapshot is corrupt. Original bytes are preserved; inspect persistence diagnostics before continuing.",
            row.id,
          );

          this.transition(row.id, null, row.status, "interrupted");
        }
      }
    });

  private transition = (
    runId: string,
    attemptId: string | null,
    previous: string | null,
    next: string,
  ) =>
    this.db.run(
      "INSERT INTO flow_transitions(run_id,attempt_id,previous_status,next_status,timestamp) VALUES(?,?,?,?,?)",
      runId,
      attemptId,
      previous,
      next,
      now(),
    );
}
