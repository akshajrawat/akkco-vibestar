import { createHash } from "node:crypto";
import { z } from "zod";

import { AdeError, now } from "../domain";
import type { Database } from "../storage/database";
import { FlowRunStore } from "./run-store";

const identity = z.string().uuid();

const DispatchRequestSchema = z
  .object({
    id: identity,
    run_id: identity,
    kind: z.enum(["flow", "node", "retry"]),
    node_id: identity.nullable().default(null),
    retry_of: identity.nullable().default(null),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      (request.kind === "flow") !== (request.node_id === null) ||
      (request.kind === "retry") !== (request.retry_of !== null)
    )
      context.addIssue({
        code: "custom",
        message: "An execution request must identify its exact scope and retry source.",
      });
  });

const DispatchSchema = z
  .object({
    id: identity,
    run_id: identity,
    kind: z.enum(["flow", "node", "retry"]),
    node_id: identity.nullable(),
    retry_of: identity.nullable(),
    request_digest: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum([
      "queued",
      "running",
      "waiting",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ]),
    created_at: z.string().datetime(),
    started_at: z.string().datetime().nullable(),
    ended_at: z.string().datetime().nullable(),
    error: z.string().max(32000).nullable(),
  })
  .strict();

export type FlowDispatch = z.infer<typeof DispatchSchema>;
export type DispatchRequest = z.input<typeof DispatchRequestSchema>;

const requestDigest = (request: z.output<typeof DispatchRequestSchema>) =>
  createHash("sha256").update(JSON.stringify(request)).digest("hex");

/** One durable record per explicit execution request; settled requests cannot be replayed. */
export class FlowDispatchStore {
  private readonly runs: FlowRunStore;

  constructor(private readonly db: Database) {
    this.runs = new FlowRunStore(db);
  }

  replay = (input: DispatchRequest) => {
    const request = DispatchRequestSchema.parse(input);
    if (!this.db.all("SELECT id FROM flow_dispatches WHERE id=?", request.id).length) return null;
    const previous = this.get(request.id);
    if (previous.request_digest !== requestDigest(request))
      throw new AdeError(
        "request_conflict",
        "This execution request belongs to a different action.",
      );
    return previous;
  };

  get = (id: string): FlowDispatch => {
    identity.parse(id);
    const row = this.db.all<FlowDispatch>("SELECT * FROM flow_dispatches WHERE id=?", id)[0];
    if (!row) throw new AdeError("not_found", "Flow execution request not found.");
    return this.db.records.decode(
      { table: "flow_dispatches", id, column: "request_digest", source: JSON.stringify(row) },
      (value) => {
        const dispatch = DispatchSchema.parse(value);

        const request = DispatchRequestSchema.parse({
          id: dispatch.id,
          run_id: dispatch.run_id,
          kind: dispatch.kind,
          node_id: dispatch.node_id,
          retry_of: dispatch.retry_of,
        });

        if (requestDigest(request) !== dispatch.request_digest)
          throw new Error("Execution request integrity failed.");
        return dispatch;
      },
    );
  };

  enqueue = (input: DispatchRequest) =>
    this.db.transaction(() => {
      const request = DispatchRequestSchema.parse(input);
      const digest = requestDigest(request);
      const previousRequest = this.replay(request);
      if (previousRequest) return previousRequest;
      const run = this.runs.run(request.run_id);
      if (
        this.db.all(
          "SELECT id FROM flow_dispatches WHERE run_id=? AND status IN ('queued','running')",
          run.id,
        ).length
      )
        throw new AdeError("busy", "This flow already has an active execution request.");
      if (
        !["queued", "paused", "waiting", "failed", "interrupted", "cancelled"].includes(run.status)
      )
        throw new AdeError("invalid_state", "This flow cannot accept another execution request.");
      if (
        run.status === "queued" &&
        this.db.all("SELECT id FROM flow_dispatches WHERE run_id=?", run.id).length
      )
        throw new AdeError(
          "invalid_state",
          "This run already consumed its initial startup authority.",
        );
      if (request.node_id) {
        const node = new Set(this.runs.definition(run.id).nodes.map((entry) => entry.id));
        if (!node.has(request.node_id))
          throw new AdeError("isolation", "The requested node is outside this flow revision.");
        const attempts = this.runs.results(run.id);
        let previous = attempts.filter((entry) => entry.node_id === request.node_id).at(-1);
        if (
          request.kind === "retry" &&
          previous?.id === request.retry_of &&
          previous.status === "waiting" &&
          previous.configuration.node.type === "approval"
        ) {
          previous = this.runs.refreshApproval(previous.id);
          const pending = this.latest(run.id);
          if (pending?.status === "waiting")
            this.settle(pending.id, "interrupted", "The user requested fresh approval evidence.");
        }

        if (
          request.kind === "retry" &&
          (!previous ||
            previous.id !== request.retry_of ||
            !["failed", "rejected", "cancelled", "interrupted"].includes(previous.status))
        )
          throw new AdeError("invalid_state", "Retry must identify the latest stopped attempt.");
        if (request.kind === "node" && previous)
          throw new AdeError(
            "invalid_state",
            "This node has already started; use its explicit retry action.",
          );
        const edges = this.runs.definition(run.id).edges;
        if (
          edges.some(
            (edge) =>
              edge.target === request.node_id &&
              attempts.filter((entry) => entry.node_id === edge.source).at(-1)?.status !==
                "completed",
          )
        )
          throw new AdeError(
            "dependencies",
            "The selected node is not eligible until every predecessor completes.",
          );
      }

      const dispatch = DispatchSchema.parse({
        ...request,
        request_digest: digest,
        status: "queued",
        created_at: now(),
        started_at: null,
        ended_at: null,
        error: null,
      });

      if (run.status !== "queued") this.runs.setRunStatus(run.id, run.status, "queued");

      this.db.run(
        "INSERT INTO flow_dispatches(id,run_id,kind,node_id,retry_of,request_digest,status,created_at,started_at,ended_at,error) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        dispatch.id,
        dispatch.run_id,
        dispatch.kind,
        dispatch.node_id,
        dispatch.retry_of,
        dispatch.request_digest,
        dispatch.status,
        dispatch.created_at,
        null,
        null,
        null,
      );

      return dispatch;
    });

  queued = () =>
    this.db
      .all<{ id: string }>("SELECT id FROM flow_dispatches WHERE status='queued' ORDER BY rowid")
      .flatMap((row) => {
        try {
          return [this.get(row.id)];
        } catch (error) {
          if (error instanceof AdeError && error.kind === "corrupt_record") return [];
          throw error;
        }
      });

  latest = (runId: string) => {
    const row = this.db.all<{ id: string }>(
      "SELECT id FROM flow_dispatches WHERE run_id=? ORDER BY rowid DESC LIMIT 1",
      runId,
    )[0];

    return row ? this.get(row.id) : null;
  };

  claim = (id: string) =>
    this.db.transaction(() => {
      const dispatch = this.get(id);
      if (dispatch.status !== "queued") return null;
      const run = this.runs.run(dispatch.run_id);
      if (run.status !== "queued") {
        this.settle(id, "interrupted", "This run no longer has queued execution authority.");
        return null;
      }

      this.runs.setRunStatus(run.id, "queued", "running");
      this.db.run("UPDATE flow_dispatches SET status='running',started_at=? WHERE id=?", now(), id);
      return this.get(id);
    });

  settle = (
    id: string,
    status: Exclude<FlowDispatch["status"], "queued" | "running">,
    error: string | null = null,
  ) => {
    const dispatch = this.get(id);
    if (!["queued", "running", "waiting"].includes(dispatch.status)) return dispatch;

    this.db.run(
      "UPDATE flow_dispatches SET status=?,ended_at=?,error=? WHERE id=?",
      status,
      status === "waiting" ? null : now(),
      error,
      id,
    );

    return this.get(id);
  };

  stopRun = (runId: string, status: "cancelled" | "interrupted") => {
    for (const row of this.db.all<{ id: string }>(
      "SELECT id FROM flow_dispatches WHERE run_id=? AND status IN ('queued','running','waiting')",
      runId,
    ))
      this.settle(row.id, status);
  };

  interruptUnfinished = () =>
    this.db.run(
      "UPDATE flow_dispatches SET status='interrupted',ended_at=?,error='Execution core restarted; submit a new explicit request.' WHERE status IN ('queued','running')",
      now(),
    );
}
