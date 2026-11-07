import { AdeError } from "../domain";
import type { Engine } from "../execution/engine";
import type { FlowRun, NodeAttempt } from "./run-contracts";
import { historicalRuns, legacyMigration } from "./legacy-migration";

export const historicalWorkspace = (engine: Engine, taskId: string) => {
  engine.db.task(taskId);
  const migration = legacyMigration(engine.db, taskId);
  if (!migration) return null;
  return {
    migration,
    definition:
      migration.flow_id && migration.history_revision
        ? engine.flows.definition(migration.flow_id, migration.history_revision).definition
        : null,
    nodes: migration.nodes.map((node) => ({
      ...node,
      runs: node.type === "agent" ? historicalRuns(engine.db, taskId, node.stage) : [],
    })),
  };
};

export type HistoricalWorkspace = ReturnType<typeof historicalWorkspace>;

type TaskFlowSummary = {
  status: FlowRun["status"] | "draft" | "needs_recovery";
  verification: NodeAttempt["verification"];
  run_id: string | null;
};

/** Snapshot metadata comes from saved evidence; navigation never rechecks workspaces or starts agents. */
export const taskFlowSummaries = (engine: Engine) =>
  Object.fromEntries(
    engine.db.tasks().flatMap<[string, TaskFlowSummary]>((task) => {
      if (!task.flow_id) return [];
      try {
        const latest = engine.db.all<{ id: string }>(
          "SELECT id FROM flow_runs WHERE task_id=? ORDER BY CASE WHEN kind='conversation' AND status IN ('queued','running','pausing','paused') THEN 0 WHEN kind='flow' THEN 1 ELSE 2 END,rowid DESC LIMIT 1",
          task.id,
        )[0];

        if (!latest) return [[task.id, { status: "draft", verification: "missing", run_id: null }]];
        const run = engine.flowRuns.run(latest.id);

        const graph = engine.db.all<{ id: string }>(
          "SELECT id FROM flow_runs WHERE task_id=? AND kind='flow' ORDER BY rowid DESC LIMIT 1",
          task.id,
        )[0];

        const evidence = graph?.id || run.id;

        const results = engine.flowRuns
          .results(evidence, { includeStale: true })
          .filter((attempt) => attempt.configuration.node.type !== "approval");

        const verification =
          engine.flowRuns.invalidation(evidence) || engine.flowRuns.staleResults(evidence).length
            ? "stale"
            : results.some((attempt) => attempt.verification === "failed")
              ? "failed"
              : results.some((attempt) => attempt.verification === "stale")
                ? "stale"
                : !results.length || results.some((attempt) => attempt.verification === "missing")
                  ? "missing"
                  : "passed";

        return [[task.id, { status: run.status, verification, run_id: run.id }]];
      } catch (error) {
        if (error instanceof AdeError && error.kind === "corrupt_record")
          return [[task.id, { status: "needs_recovery", verification: "missing", run_id: null }]];
        throw error;
      }
    }),
  );

/** Read projections retain validated historical snapshots and existing telemetry links. */
export const flowWorkspace = (engine: Engine, taskId: string) => {
  const task = engine.db.task(taskId);
  if (!task.flow_id)
    throw new AdeError(
      "invalid_state",
      "This task still uses its historical workflow. Its history remains available.",
    );
  const revision = engine.flows.definition(task.flow_id);

  const captured = engine.db
    .all<{ id: string }>("SELECT id FROM flow_runs WHERE task_id=? ORDER BY rowid DESC", taskId)
    .flatMap(({ id }) => {
      try {
        return [engine.flowRuns.run(id)];
      } catch (error) {
        if (error instanceof AdeError && error.kind === "corrupt_record") return [];
        throw error;
      }
    });

  const runs = captured.filter((run) => run.kind === "flow");
  const conversations = captured.filter((run) => run.kind === "conversation");

  return {
    revision,
    history: historicalWorkspace(engine, taskId),
    capabilities: { continuations: 1, conversations: 1 },
    layout: engine.flows.layout(task.flow_id),
    runs,
    conversations,
    conversation_attempts: conversations.flatMap((run) => engine.flowRuns.attempts(run.id)),
    invalidations: Object.fromEntries(
      runs.map((run) => [run.id, engine.flowRuns.invalidation(run.id)]),
    ),
    attempts: runs.flatMap((run) => engine.flowRuns.attempts(run.id)),
    results: Object.fromEntries(
      runs.map((run) => [run.id, engine.flowRuns.results(run.id, { includeStale: true })]),
    ),
    stale_results: Object.fromEntries(
      runs.map((run) => [run.id, engine.flowRuns.staleResults(run.id)]),
    ),
    definitions: Object.fromEntries(
      runs.map((run) => [run.id, engine.flowRuns.definition(run.id)]),
    ),
  };
};

export type FlowWorkspace = ReturnType<typeof flowWorkspace>;

/** Reusable identities point to ordinary task instances; listing them starts no inference. */
export const viberInstances = (engine: Engine) =>
  engine.db.tasks().flatMap((task) => {
    if (!task.flow_id) return [];
    try {
      const saved = engine.flows.definition(task.flow_id);
      return saved.definition.nodes
        .filter((node) => node.type === "agent")
        .map((node) => ({
          task_id: task.id,
          node_id: node.id,
          profile_id: node.profile_id,
          name: node.name,
          goal:
            task.goal ||
            (typeof task.issue.title === "string" ? task.issue.title : "Imported task"),
          archived: task.archived || false,
          status: task.status,
        }));
    } catch (error) {
      if (error instanceof AdeError && error.kind === "corrupt_record") return [];
      throw error;
    }
  });

export type ViberInstance = ReturnType<typeof viberInstances>[number];
