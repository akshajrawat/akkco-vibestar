import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import {
  AdeError,
  now,
  parseIssue,
  pipelineConfiguration,
  repositoryMatchesIssue,
  type Task,
} from "../domain";
import type { Database } from "../storage/database";
import { redact } from "../execution/runtime/process";
import { validatePlan } from "../execution/providers/contracts";
import {
  AgentProfileSchema,
  FlowDefinitionSchema,
  type AgentProfile,
  type FlowDefinition,
  type FlowNode,
} from "./contracts";
import { FlowStore } from "./store";
import { FlowRunStore } from "./run-store";
import { instantiateTemplate } from "./templates";

const identity = z.string().uuid();
const legacyStage = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(5)]);

export const LegacyMigrationSchema = z
  .object({
    task_id: z.string(),
    source_hash: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(["converted", "needs_recovery"]),
    original_status: z.string(),
    original_stage: z.number().int().nullable(),
    flow_id: identity.nullable(),
    history_revision: z.number().int().positive().nullable(),
    checkpoint_run_id: identity.nullable(),
    boundary_node_id: identity.nullable(),
    final_review_fingerprint: z.string().nullable(),
    diagnostic: z.string().max(4000).nullable(),
    nodes: z
      .array(
        z
          .object({ id: identity, stage: legacyStage, type: z.enum(["agent", "approval"]) })
          .strict(),
      )
      .max(8),
  })
  .strict();

export type LegacyMigration = z.infer<typeof LegacyMigrationSchema>;

const stages = [1, 2, 3, 5] as const;

const gateStages = {
  antigravity_plan: 1,
  codex_plan: 2,
  implementation: 3,
  final_review: 5,
} as const;

const roles = {
  1: {
    name: "Imported Planner",
    access: "read-only",
    output: "plan",
    instructions:
      "Inspect the selected issue, scoped brief and repository. Create a detailed plan. Keep source and Git read-only; do not install dependencies or perform remote writes.",
  },
  2: {
    name: "Imported Refiner",
    access: "read-only",
    output: "refinement",
    instructions:
      "Refine the selected plan against the scoped issue and repository conventions. Make it self-contained for implementation, with exact applicable checks and installed-tool prerequisites. Do not edit files or run tests; leave remote writes to the user.",
  },
  3: {
    name: "Imported Implementer",
    access: "workspace-write",
    output: "implementation",
    instructions:
      "Implement the selected refined plan and explicit instructions in this assigned workspace. Run applicable installed checks and report observed outcomes and missing prerequisites honestly. Do not install dependencies or commit, push or perform remote writes.",
  },
  5: {
    name: "Imported Reviewer",
    access: "read-only",
    output: "review",
    instructions:
      "Independently review the scoped implementation and full diff using the selected evidence and installed checks. Keep source and Git read-only. Distinguish observed checks from provider reports and missing evidence. Report findings and manual next steps; do not start another implementation or perform remote writes.",
  },
} as const;

/** Historical records remain references, never reconstructed approvals or captured invocation settings. */
export const legacyMigration = (db: Database, taskId: string): LegacyMigration | null => {
  const row = db.all<{ data: string; source_hash: string }>(
    "SELECT data,source_hash FROM flow_task_migrations WHERE task_id=?",
    taskId,
  )[0];

  if (!row) return null;
  return db.records.decode(
    { table: "flow_task_migrations", id: taskId, column: "data", source: row.data },
    (value) => {
      const record = LegacyMigrationSchema.parse(value);
      if (record.task_id !== taskId || record.source_hash !== row.source_hash)
        throw new Error("Historical task migration identity mismatch.");
      return record;
    },
  );
};

const saveMigration = (db: Database, record: LegacyMigration) => {
  const parsed = LegacyMigrationSchema.parse(record);

  db.run(
    "INSERT INTO flow_task_migrations VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET source_hash=excluded.source_hash,data=excluded.data,updated_at=excluded.updated_at",
    parsed.task_id,
    parsed.source_hash,
    JSON.stringify(parsed),
    now(),
  );

  return parsed;
};

const sameProfile = (a: AgentProfile, b: AgentProfile) =>
  JSON.stringify({
    execution: a.execution,
    instructions: a.instructions,
    supported_access: a.supported_access,
  }) ===
  JSON.stringify({
    execution: b.execution,
    instructions: b.instructions,
    supported_access: b.supported_access,
  });

const profilesFor = (db: Database, task: Task, store: FlowStore) => {
  if (!task.execution_settings)
    throw new AdeError(
      "missing_history",
      "The historical execution settings were not captured. Restore the original snapshot or create a new task with explicit Viber settings; current defaults cannot prove the old configuration.",
    );
  const settings = task.execution_settings;

  const existing = db
    .all<{ id: string }>("SELECT id FROM agent_profiles ORDER BY rowid")
    .flatMap(({ id }) => {
      try {
        return [store.profile(id)];
      } catch (error) {
        if (error instanceof AdeError && error.kind === "corrupt_record") return [];
        throw error;
      }
    });

  return new Map(
    stages.map((stage) => {
      const role = roles[stage];

      const profile = AgentProfileSchema.parse({
        id: randomUUID(),
        revision: 1,
        name: role.name,
        instructions: role.instructions,
        execution: {
          ...pipelineConfiguration(settings, stage, task.stage_settings),
          access: role.access,
          output: role.output,
        },
        supported_access:
          role.access === "workspace-write" ? ["read-only", "workspace-write"] : ["read-only"],
      });

      const saved =
        existing.find((item) => sameProfile(item, profile)) || store.saveProfile(profile, null);

      existing.push(saved);
      return [stage, saved];
    }),
  );
};

const historicalPurposes = [
  "pipeline",
  "Plan",
  "Plan refinement",
  "Implementation",
  "Review",
  "Antigravity Plan",
  "Codex Plan Refinement",
  "Codex Implementation",
  "Antigravity Review",
];

export const historicalRuns = (db: Database, taskId: string, stage: number) =>
  db
    .all<{
      id: string;
      stage: number;
      purpose: string;
      status: string;
      provider: string;
      model: string;
      effort: string;
      started_at: string;
      ended_at: string | null;
    }>(
      "SELECT id,stage,purpose,status,provider,model,effort,started_at,ended_at FROM agent_runs WHERE task_id=? AND stage=? ORDER BY started_at,rowid",
      taskId,
      stage,
    )
    .filter((run) => historicalPurposes.includes(run.purpose));

const artifactFor = (db: Database, taskId: string, stage: number) => {
  const row = db.all<{ id: string; content: string }>(
    "SELECT id,content FROM task_artifacts WHERE task_id=? AND stage=? AND kind='plan' ORDER BY created_at DESC,rowid DESC LIMIT 1",
    taskId,
    stage,
  )[0];

  if (!row)
    throw new AdeError(
      "missing_history",
      `The saved stage ${stage} result is missing. Restore its artifact or start a new flow explicitly; previous work was preserved.`,
    );

  db.records.decode(
    { table: "task_artifacts", id: row.id, column: "content", source: row.content },
    (value) => validatePlan(stage, value),
  );

  if (!identity.safeParse(row.id).success)
    throw new AdeError(
      "missing_history",
      "This historical artifact has an unsupported identity. Restore its record before selecting it as new execution context.",
    );
  return row;
};

const initialBoundary = (task: Task) => {
  if (task.status === "awaiting_approval") {
    if (!task.approval_gate)
      throw new AdeError(
        "missing_history",
        "This task is waiting for an unidentified approval. Restore its saved gate before continuing.",
      );
    return { stage: gateStages[task.approval_gate], type: "approval" as const };
  }

  if (task.stage === 4) return { stage: 3 as const, type: "approval" as const };
  return {
    stage: task.stage <= 1 ? 1 : task.stage === 2 ? 2 : task.stage === 3 ? 3 : 5,
    type: "agent" as const,
  };
};

/** Converts only metadata and context references. No provider, command, fetch or filesystem mutation is performed. */
export const migrateLegacyTask = (db: Database, taskId: string): LegacyMigration | null => {
  const row = db.all<{ data: string; status: string; stage: number; scope_mode: string }>(
    "SELECT data,status,stage,scope_mode FROM tasks WHERE id=?",
    taskId,
  )[0];

  if (!row) throw new AdeError("not_found", "Historical task not found.");
  // Validate an existing journal before any upsert; corrupt journal bytes must survive recovery.
  const previous = legacyMigration(db, taskId);
  const sourceHash = createHash("sha256").update(row.data).digest("hex");

  const base: LegacyMigration = {
    task_id: taskId,
    source_hash: sourceHash,
    state: "needs_recovery",
    original_status: row.status,
    original_stage: Number.isSafeInteger(row.stage) ? row.stage : null,
    flow_id: null,
    history_revision: null,
    checkpoint_run_id: null,
    boundary_node_id: null,
    final_review_fingerprint: null,
    diagnostic: null,
    nodes: [],
  };

  try {
    const original = db.task(taskId);
    if (original.flow_id) return previous;

    db.run(
      "INSERT INTO flow_migration_sources VALUES(?,?,?,?) ON CONFLICT(task_id,source_hash) DO NOTHING",
      taskId,
      sourceHash,
      row.data,
      now(),
    );

    if (["removing", "removed"].includes(original.workspace_checkpoint?.state || ""))
      throw new AdeError(
        "removal_pending",
        "Complete the previously confirmed workspace cleanup explicitly before continuing. Its saved authorization and original history were preserved.",
      );

    if (!identity.safeParse(taskId).success)
      throw new AdeError(
        "missing_history",
        "This historical task identity is unsupported by the desktop transport. Its exact source and ID were preserved for recovery.",
      );

    if (original.status !== row.status || original.stage !== row.stage)
      throw new AdeError(
        "missing_history",
        "Task metadata disagrees with its saved execution state. Restore the record from its backup before migrating it.",
      );
    if (
      original.kind === "general" ||
      !original.repo_id ||
      !original.issue_url ||
      !original.issue_number
    )
      throw new AdeError(
        "missing_history",
        "The historical repository or issue identity is incomplete. Restore the original ownership record or create a new task; existing files and history were preserved.",
      );
    if (original.status === "preserved")
      throw new AdeError(
        "preserved",
        "This task's history was deliberately removed. Its ownership record and files remain preserved; create a new task for further work.",
      );
    const repository = db.repository(original.repo_id);
    const issue = parseIssue(original.issue_url);
    if (!repositoryMatchesIssue(repository, issue) || issue.number !== original.issue_number)
      throw new AdeError(
        "ownership",
        "The saved issue no longer matches its registered repository. Restore that identity before migration.",
      );
    const scopeMode = original.scope_mode || row.scope_mode;
    if (!["partial", "whole_issue"].includes(scopeMode))
      throw new AdeError(
        "missing_history",
        "This task has no known scope decision. Restore its saved scope before migration.",
      );

    const goal =
      scopeMode === "partial"
        ? original.claimed_scope?.trim()
        : typeof original.issue?.title === "string"
          ? original.issue.title.trim()
          : `Contribute to ${original.issue_url}`;

    if (!goal || goal.length > 32000)
      throw new AdeError(
        "missing_history",
        "Restore a nonempty scoped goal of at most 32,000 characters; the original brief was preserved without truncation.",
      );
    const task = { ...original, scope_mode: scopeMode as Task["scope_mode"], goal };
    return db.transaction(() => {
      const store = new FlowStore(db);
      const profiles = profilesFor(db, task, store);
      const flowId = randomUUID();
      const template = instantiateTemplate("full", randomUUID);
      let agentIndex = 0;
      let approvalIndex = 0;

      const slots = template.nodes.map((node) => ({
        id: node.id,
        type: node.type as "agent" | "approval",
        stage: node.type === "agent" ? stages[agentIndex++] : stages[approvalIndex++],
      }));

      const selectedMessages = db
        .all<{ id: string }>(
          "SELECT id FROM task_messages WHERE task_id=? AND purpose='instruction' AND status='delivered' ORDER BY created_at,rowid",
          taskId,
        )
        .map((message) => message.id);

      for (const id of task.workflow_start?.message_ids || []) {
        if (
          !db.all(
            "SELECT id FROM task_messages WHERE id=? AND task_id=? AND purpose='chat' AND status='chat_completed'",
            id,
            taskId,
          ).length
        )
          throw new AdeError(
            "missing_history",
            "A previously selected conversation message is unavailable. Restore it or explicitly choose a new flow context.",
          );
        selectedMessages.push(id);
      }

      const full: FlowDefinition = FlowDefinitionSchema.parse({
        ...template,
        name: "Imported contribution flow",
        nodes: template.nodes.map((node) => {
          if (node.type !== "agent") return node;
          const slot = slots.find((slot) => slot.id === node.id)!;
          return {
            ...node,
            profile_id: profiles.get(slot.stage)!.id,
            overrides: {},
            inputs: [
              ...node.inputs,
              { kind: "task-brief" },
              { kind: "repository" },
              { kind: "issue" },
              ...[...new Set(selectedMessages)].map((message_id) => ({
                kind: "message" as const,
                message_id,
              })),
            ],
          };
        }),
      });

      store.saveDefinition(flowId, full, null, taskId);

      const finished =
        ["completed", "ready_for_review", "reviewed_with_gaps"].includes(task.status) ||
        task.stage >= 6;

      const idle =
        task.status === "not_started" ||
        (task.workflow_version === 1 && !task.workflow_start && task.stage === 0);

      let boundaryId: string | null = null;
      let revision = 1;
      if (!finished && !idle) {
        const boundary = initialBoundary(task);

        const slot = slots.find(
          (slot) => slot.stage === boundary.stage && slot.type === boundary.type,
        );

        if (!slot)
          throw new AdeError(
            "missing_history",
            "This historical execution boundary cannot be translated. Its source state remains preserved.",
          );
        boundaryId = slot.id;
        const offset = full.nodes.findIndex((node) => node.id === boundaryId);
        const remaining = new Set(full.nodes.slice(offset).map((node) => node.id));

        const nodes = full.nodes.slice(offset).map((node): FlowNode => {
          const inputs = node.inputs.flatMap((input) => {
            if (!("node_id" in input) || remaining.has(input.node_id)) return [input];
            const source = slots.find((slot) => slot.id === input.node_id);
            if (!source || source.type === "approval") return [];
            return [
              { kind: "artifact" as const, artifact_id: artifactFor(db, taskId, source.stage).id },
            ];
          });

          if (node.type === "approval" && node.id === boundaryId) {
            const source = slots.find((slot) => slot.id === node.id)!;
            const observed = historicalRuns(db, taskId, source.stage).at(-1);
            if (observed) inputs.push({ kind: "command-evidence", run_id: observed.id });
            if (
              db.all("SELECT id FROM test_runs WHERE task_id=? AND run_id IS NULL LIMIT 1", taskId)
                .length
            )
              inputs.push({ kind: "command-evidence", run_id: null });
          }

          return {
            ...node,
            inputs: inputs.filter(
              (input, index) =>
                inputs.findIndex((other) => JSON.stringify(other) === JSON.stringify(input)) ===
                index,
            ),
          };
        });

        revision = store.saveDefinition(
          flowId,
          {
            name: "Continue imported work",
            nodes,
            edges: full.edges.filter(
              (edge) => remaining.has(edge.source) && remaining.has(edge.target),
            ),
          },
          1,
          taskId,
        ).revision;
      }

      db.saveTask({
        ...task,
        kind: "issue",
        flow_id: flowId,
        status: task.status === "completed" ? "completed" : "not_started",
        workspace_checkpoint: task.workspace_checkpoint
          ? { ...task.workspace_checkpoint, operation: null }
          : undefined,
      });

      let checkpointId: string | null = null;
      if (boundaryId) {
        const runs = new FlowRunStore(db);

        const run = runs.createRun(
          { task_id: taskId, flow_id: flowId, revision, request_id: randomUUID(), goal },
          "historical",
        );

        const status =
          task.status === "cancelled"
            ? "cancelled"
            : task.status === "awaiting_approval"
              ? "waiting"
              : task.status === "failed"
                ? "failed"
                : "interrupted";

        if (status === "waiting") runs.setRunStatus(run.id, "queued", "running");

        runs.setRunStatus(
          run.id,
          status === "waiting" ? "running" : "queued",
          status,
          "Imported checkpoint; continue explicitly. Earlier approvals and provider settings were not reconstructed.",
        );

        checkpointId = run.id;
      }

      return saveMigration(db, {
        ...base,
        state: "converted",
        flow_id: flowId,
        history_revision: 1,
        checkpoint_run_id: checkpointId,
        boundary_node_id: boundaryId,
        final_review_fingerprint: task.final_review_hash || null,
        diagnostic:
          task.approval_gate === "final_review"
            ? "The saved final-review fingerprint must still match before its approval can be inspected. If it is stale, add a fresh Reviewer and apply a new revision."
            : "Prior results and saved instructions were retained. Past approval decisions were not invented; continuing this checkpoint is a new explicit action.",
        nodes: slots,
      });
    });
  } catch (error) {
    db.run(
      "INSERT INTO flow_migration_sources VALUES(?,?,?,?) ON CONFLICT(task_id,source_hash) DO NOTHING",
      taskId,
      sourceHash,
      row.data,
      now(),
    );

    return saveMigration(db, {
      ...base,
      diagnostic: redact(error instanceof Error ? error.message : String(error)).slice(0, 4000),
    });
  }
};

export const migrateLegacyTasks = (db: Database) => {
  for (const { id } of db.all<{ id: string }>("SELECT id FROM tasks ORDER BY created_at,id")) {
    try {
      migrateLegacyTask(db, id);
    } catch (error) {
      if (!(error instanceof AdeError && error.kind === "corrupt_record")) throw error;
    }
  }
};
