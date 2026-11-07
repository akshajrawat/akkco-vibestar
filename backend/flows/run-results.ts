import { createHash } from "node:crypto";
import type { z } from "zod";

import { AdeError } from "../domain";
import type { Database } from "../storage/database";
import type { FlowDefinition } from "./contracts";
import { FlowRunInvalidationSchema, type FlowRun, type NodeAttempt } from "./run-contracts";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

interface FlowRunReads {
  run: (id: string) => FlowRun;
  definition: (runId: string) => FlowDefinition;
  attempts: (runId: string) => NodeAttempt[];
  attempt: (id: string) => NodeAttempt;
}

/** Validates linked results and projects invalidation state without settling runs. */
export class FlowRunResults {
  constructor(
    private readonly db: Database,
    private readonly reads: FlowRunReads,
  ) {}

  results = (runId: string, options: { includeStale?: boolean } = {}): NodeAttempt[] => {
    const run = this.reads.run(runId);
    const graph = this.reads.definition(run.id);

    const reused = this.db
      .all<{ node_id: string; source_attempt_id: string; workspace_fingerprint: string }>(
        "SELECT node_id,source_attempt_id,workspace_fingerprint FROM flow_result_links l WHERE run_id=? AND (? OR NOT EXISTS(SELECT 1 FROM flow_result_invalidations i WHERE i.run_id=l.run_id AND i.node_id=l.node_id)) ORDER BY rowid",
        runId,
        options.includeStale ? 1 : 0,
      )
      .map((row) => {
        const source = this.reads.attempt(row.source_attempt_id);
        const sourceRun = this.reads.run(source.run_id);
        const node = graph.nodes.find((node) => node.id === row.node_id);
        if (
          !node ||
          run.kind !== "flow" ||
          sourceRun.kind !== "flow" ||
          source.node_id !== row.node_id ||
          source.status !== "completed" ||
          source.completed_fingerprint !== row.workspace_fingerprint ||
          sourceRun.task_id !== run.task_id ||
          sourceRun.flow_id !== run.flow_id ||
          source.run_id === runId ||
          source.configuration_hash !==
            digest({ node, agent: node.type === "agent" ? run.snapshot.agents[node.id] : null })
        )
          throw new AdeError(
            "corrupt_record",
            "A reused result no longer matches its captured source and owner. Original history was preserved.",
          );
        return source;
      });

    return [...reused, ...this.reads.attempts(runId)];
  };

  staleResults = (runId: string) => {
    this.reads.run(runId);
    const invalidation = this.invalidation(runId);
    if (invalidation)
      return this.results(runId, { includeStale: true }).map((attempt) => ({
        node_id: attempt.node_id,
        reason: invalidation.reason,
      }));
    return this.db.all<{ node_id: string; reason: string }>(
      "SELECT node_id,reason FROM flow_result_invalidations WHERE run_id=? ORDER BY rowid",
      runId,
    );
  };

  invalidation = (runId: string) => {
    this.reads.run(runId);

    const row = this.db.all<z.infer<typeof FlowRunInvalidationSchema>>(
      "SELECT * FROM flow_run_invalidations WHERE run_id=?",
      runId,
    )[0];

    if (!row) return null;
    return this.db.records.decode(
      { table: "flow_run_invalidations", id: runId, column: "reason", source: JSON.stringify(row) },
      FlowRunInvalidationSchema.parse,
    );
  };
}
