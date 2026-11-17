import { createHash } from "node:crypto";
import { z } from "zod";

import { AdeError } from "../domain";
import type { Database } from "../storage/database";
import { resolveAgentNode, nodeDependencies } from "./contracts";
import { resolveBoundInputs } from "./context";
import { FlowStore } from "./store";
import type { FlowRunStore } from "./run-store";
import { ContentHashSchema, FlowRunSnapshotSchema, type NodeAttempt } from "./run-contracts";

const identity = z.string().uuid();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const ContinuationTargetSchema = z
  .object({ run_id: identity, revision: z.number().int().positive() })
  .strict();

export const ContinuationApplySchema = ContinuationTargetSchema.extend({
  request_id: identity,
  plan_hash: ContentHashSchema,
}).strict();

export const ContinuationPlanSchema = z
  .object({
    parent_run_id: identity,
    flow_id: identity,
    task_id: z.string().min(1).max(100),
    revision: z.number().int().positive(),
    workspace_fingerprint: z.string().min(1).max(500),
    configuration_hash: ContentHashSchema,
    nodes: z
      .array(
        z
          .object({
            node_id: identity,
            name: z.string().min(1).max(100),
            status: z.enum(["reuse", "stale", "pending"]),
            source_attempt_id: identity.nullable(),
            reason: z.string().min(1).max(500),
            external_inputs_hash: ContentHashSchema.nullable().default(null),
          })
          .strict(),
      )
      .max(200),
    hash: ContentHashSchema,
  })
  .strict();

export type ContinuationPlan = z.infer<typeof ContinuationPlanSchema>;

/** Conservative reuse: the exact configuration, selected inputs and observed workspace must still match. */
export const continuationPlan = (
  db: Database,
  runs: FlowRunStore,
  raw: z.input<typeof ContinuationTargetSchema>,
  fingerprint: string,
): ContinuationPlan => {
  const target = ContinuationTargetSchema.parse(raw);
  const parent = runs.run(target.run_id);
  if (parent.kind !== "flow")
    throw new AdeError(
      "invalid_state",
      "Send another Viber message to use updated chat settings. Saved graph continuations cannot reuse conversation completions.",
    );
  if (!["paused", "failed", "interrupted", "cancelled", "completed"].includes(parent.status))
    throw new AdeError("invalid_state", "Pause or stop this run before applying a saved revision.");
  const task = db.task(parent.task_id);
  if (task.flow_id !== parent.flow_id || !task.goal)
    throw new AdeError(
      "isolation",
      "This continuation must use the task's owned flow and current goal.",
    );
  const store = new FlowStore(db);
  const graph = store.definition(parent.flow_id, target.revision).definition;

  const snapshot = FlowRunSnapshotSchema.parse({
    goal: task.goal,
    agents: Object.fromEntries(
      graph.nodes
        .filter((node) => node.type === "agent")
        .map((node) => [node.id, resolveAgentNode(node, store.profile(node.profile_id))]),
    ),
  });

  const source = runs.results(parent.id, { includeStale: true });
  const invalidated = new Set(runs.staleResults(parent.id).map((row) => row.node_id));
  const available: NodeAttempt[] = [];
  const visited = new Set<string>();
  const nodes: ContinuationPlan["nodes"] = [];

  while (visited.size < graph.nodes.length) {
    const ready = graph.nodes.find(
      (node) =>
        !visited.has(node.id) &&
        graph.edges
          .filter((edge) => edge.target === node.id)
          .every((edge) => visited.has(edge.source)),
    );

    if (!ready)
      throw new AdeError("invalid_state", "The saved graph contains an invalid dependency cycle.");
    visited.add(ready.id);
    const previous = source.filter((attempt) => attempt.node_id === ready.id).at(-1);

    const externalInputs = resolveBoundInputs(
      db,
      task.id,
      task.goal,
      { ...ready, inputs: ready.inputs.filter((binding) => !("node_id" in binding)) },
      [],
    );

    let reason: string | null = null;

    if (!previous || previous.status !== "completed")
      reason = previous
        ? "The previous attempt did not complete."
        : "This node has not completed yet.";
    else if (invalidated.has(ready.id))
      reason = "This reused result was invalidated; recompute it explicitly.";
    else if (
      previous.configuration_hash !==
      digest({ node: ready, agent: ready.type === "agent" ? snapshot.agents[ready.id] : null })
    )
      reason = "The captured node or profile configuration changed.";
    else if (
      JSON.stringify(nodeDependencies(runs.definition(previous.run_id), ready.id)) !==
      JSON.stringify(nodeDependencies(graph, ready.id))
    )
      reason = "The node's dependencies changed.";
    else if (!previous.completed_fingerprint || previous.completed_fingerprint !== fingerprint)
      reason = "The workspace differs from this result's observed completion evidence.";
    else if (
      graph.edges.some(
        (edge) =>
          edge.target === ready.id && !available.some((result) => result.node_id === edge.source),
      )
    )
      reason = "A required predecessor needs recomputation.";
    else {
      try {
        if (
          digest(resolveBoundInputs(db, task.id, task.goal, ready, available)) !==
          previous.inputs_hash
        )
          reason = "The selected inputs changed.";
      } catch (error) {
        if (!(error instanceof AdeError)) throw error;

        reason =
          error.kind === "corrupt_record"
            ? "A selected source needs persistence recovery."
            : "The selected inputs cannot currently be resolved.";
      }
    }

    if (!reason && previous) available.push(previous);

    nodes.push({
      node_id: ready.id,
      name: ready.name,
      source_attempt_id: previous?.id ?? null,
      status: !reason ? "reuse" : previous ? "stale" : "pending",
      reason: reason || "Configuration, selected inputs and completed workspace evidence match.",
      external_inputs_hash: digest(externalInputs),
    });
  }

  const plan = {
    parent_run_id: parent.id,
    flow_id: parent.flow_id,
    task_id: task.id,
    revision: target.revision,
    workspace_fingerprint: fingerprint,
    configuration_hash: digest(snapshot),
    nodes,
  };

  return ContinuationPlanSchema.parse({ ...plan, hash: digest(plan) });
};

export const continuationRequestDigest = (input: z.output<typeof ContinuationApplySchema>) =>
  digest(input);
