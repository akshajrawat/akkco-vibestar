import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Sqlite from "better-sqlite3";
import { expect, it } from "vitest";

import { Database } from "../../backend/storage/database";
import { migrations } from "../../backend/storage/migrations";
import {
  AgentProfileSchema,
  FlowNodeSchema,
  resolveAgentNode,
} from "../../backend/flows/contracts";
import { FlowRunStore } from "../../backend/flows/run-store";
import { continuationPlan } from "../../backend/flows/continuation";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

it.each([
  { version: 32, corrupt: false },
  { version: 35, corrupt: false },
  { version: 35, corrupt: true },
])(
  "preserves version-$version attempts and scopes only proven messages (corrupt configuration: $corrupt)",
  async ({ version, corrupt }) => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-continuation-upgrade-"));
    const path = join(dir, "state.sqlite");
    const old = new Sqlite(path);
    old.pragma("foreign_keys = OFF");
    if (corrupt) old.pragma("ignore_check_constraints = ON");
    for (const migration of migrations.filter((entry) => entry.version <= version)) {
      old.exec(migration.sql);

      old
        .prepare("INSERT OR IGNORE INTO schema_migrations VALUES(?,?)")
        .run(migration.version, "before");
    }

    const timestamp = "2026-11-06T00:00:00.000Z";
    const taskId = randomUUID();
    const flowId = randomUUID();
    const runId = randomUUID();
    const attemptId = randomUUID();
    const agentId = randomUUID();
    const scopedMessage = randomUUID();
    const unknownMessage = randomUUID();

    const profile = AgentProfileSchema.parse({
      id: randomUUID(),
      revision: 1,
      name: "Historical Viber",
      instructions: "Read the selected goal.",
      supported_access: ["read-only"],
      execution: {
        provider: "codex",
        model: "historical-model",
        effort: "low",
        timeout_secs: 30,
        access: "read-only",
        output: "summary",
      },
    });

    const node = FlowNodeSchema.parse({
      id: randomUUID(),
      name: "Saved node",
      type: "agent",
      profile_id: profile.id,
      instructions: "",
      overrides: {},
      completion: { review: "none", verification: "record-only" },
      inputs: [{ kind: "task-goal" }],
    });

    if (node.type !== "agent") throw new Error("Expected an agent fixture");
    const goal = "Preserve my historical result";

    const task = JSON.stringify({
      id: taskId,
      repo_id: null,
      issue_number: null,
      issue_url: null,
      kind: "general",
      workspace_kind: "managed",
      flow_id: flowId,
      goal,
      status: "not_started",
      stage: 0,
    });

    const configuration = { node, agent: resolveAgentNode(node, profile) };

    const savedConfiguration = corrupt
      ? "{original malformed configuration bytes"
      : JSON.stringify(configuration);

    const inputs = [{ binding: { kind: "task-goal" }, content: goal }];
    const output = JSON.stringify({ summary: "An observed historical completion" });
    const requestId = randomUUID();

    old.transaction(() => {
      old
        .prepare(
          "INSERT INTO tasks(id,repo_id,status,stage,data,created_at) VALUES(?,NULL,'not_started',0,?,?)",
        )
        .run(taskId, task, timestamp);

      old
        .prepare("INSERT INTO agent_profiles VALUES(?,1,?,?)")
        .run(profile.id, timestamp, timestamp);

      old
        .prepare("INSERT INTO agent_profile_revisions VALUES(?,1,?,?)")
        .run(profile.id, JSON.stringify(profile), timestamp);

      old
        .prepare("INSERT INTO flow_definitions VALUES(?,?,1,?,?)")
        .run(flowId, taskId, timestamp, timestamp);

      old.prepare("INSERT INTO flow_revisions VALUES(?,1,?,?)").run(
        flowId,
        JSON.stringify({
          flow_id: flowId,
          revision: 1,
          definition: { name: "Historical graph", nodes: [node], edges: [] },
          created_at: timestamp,
        }),
        timestamp,
      );

      old
        .prepare(
          "INSERT INTO flow_runs(id,flow_id,revision,task_id,status,request_id,request_digest,parent_run_id,snapshot,created_at,updated_at,error) VALUES(?,?,1,?,'completed',?,?,NULL,?,?,?,NULL)",
        )
        .run(
          runId,
          flowId,
          taskId,
          requestId,
          digest({
            flow_id: flowId,
            task_id: taskId,
            revision: 1,
            goal,
            request_id: requestId,
            parent_run_id: null,
          }),
          JSON.stringify({ goal, agents: { [node.id]: configuration.agent } }),
          timestamp,
          timestamp,
        );

      old
        .prepare(
          "INSERT INTO agent_runs(id,task_id,stage,provider,model,effort,prompt,status,started_at,ended_at,exit_code,output) VALUES(?,?,0,'codex','historical-model','low','Historical prompt','completed',?,?,0,?)",
        )
        .run(agentId, taskId, timestamp, timestamp, output);

      old
        .prepare(
          "INSERT INTO flow_node_attempts(id,run_id,node_id,ordinal,status,configuration,configuration_hash,inputs,inputs_hash,workspace_fingerprint,agent_run_id,started_at,ended_at,output,verification) VALUES(?,?,?,1,'completed',?,?,?,?,?,?,?, ?,?,'missing')",
        )
        .run(
          attemptId,
          runId,
          node.id,
          savedConfiguration,
          digest(configuration),
          JSON.stringify(inputs),
          digest(inputs),
          "managed-v1:before",
          agentId,
          timestamp,
          timestamp,
          output,
        );

      for (const [id, run] of [
        [scopedMessage, agentId],
        [unknownMessage, null],
      ])
        old
          .prepare(
            "INSERT INTO task_messages(id,task_id,role,content,created_at,status,run_id,purpose) VALUES(?,?,'user','Original chat bytes',?,'chat_completed',?,'chat')",
          )
          .run(id, taskId, timestamp, run);
    })();

    old.close();

    try {
      for (let index = 0; index < 2; index++) {
        const db = await Database.open(path);
        try {
          const runs = new FlowRunStore(db);
          expect(runs.run(runId).kind).toBe("flow");

          expect(
            db.all(
              "SELECT id,content,flow_node_id,viber_profile_id FROM task_messages ORDER BY rowid",
            ),
          ).toEqual([
            {
              id: scopedMessage,
              content: "Original chat bytes",
              flow_node_id: corrupt ? null : node.id,
              viber_profile_id: corrupt ? null : profile.id,
            },
            {
              id: unknownMessage,
              content: "Original chat bytes",
              flow_node_id: null,
              viber_profile_id: null,
            },
          ]);

          if (corrupt) {
            expect(() => runs.attempt(attemptId)).toThrow("original data is preserved");

            expect(
              db.all("SELECT configuration FROM flow_node_attempts WHERE id=?", attemptId),
            ).toEqual([{ configuration: savedConfiguration }]);
          } else {
            expect(() =>
              db.run(
                "UPDATE task_messages SET flow_node_id=? WHERE id=?",
                randomUUID(),
                scopedMessage,
              ),
            ).toThrow("scope is immutable");

            expect(runs.attempt(attemptId)).toMatchObject({
              status: "completed",
              completed_fingerprint: null,
              agent_run_id: agentId,
              output,
            });
          }

          expect(db.all("SELECT data FROM tasks WHERE id=?", taskId)).toEqual([{ data: task }]);

          expect(db.all("SELECT execution,prompt FROM agent_runs WHERE id=?", agentId)).toEqual([
            { execution: null, prompt: "Historical prompt" },
          ]);

          if (corrupt)
            expect(() =>
              continuationPlan(db, runs, { run_id: runId, revision: 1 }, "managed-v1:before"),
            ).toThrow("original data is preserved");
          else {
            const plan = continuationPlan(
              db,
              runs,
              { run_id: runId, revision: 1 },
              "managed-v1:before",
            );

            expect(plan.nodes[0]).toMatchObject({
              status: "stale",
              reason: expect.stringContaining("completion evidence"),
            });
          }

          expect(db.all("SELECT run_id FROM flow_result_links")).toHaveLength(0);
          expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
        } finally {
          db.close();
        }
      }

      const backups = (await readdir(dir)).filter((name) => name.includes(`before-v${version}`));
      expect(backups).toHaveLength(1);
      const backup = new Sqlite(join(dir, backups[0]), { readonly: true });
      try {
        expect(
          backup
            .prepare(
              "SELECT configuration,workspace_fingerprint FROM flow_node_attempts WHERE id=?",
            )
            .get(attemptId),
        ).toEqual({
          configuration: savedConfiguration,
          workspace_fingerprint: "managed-v1:before",
        });

        expect(
          backup
            .prepare("PRAGMA table_info(flow_node_attempts)")
            .all()
            .some((row) => (row as { name: string }).name === "completed_fingerprint"),
        ).toBe(version >= 33);
      } finally {
        backup.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
