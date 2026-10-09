import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Sqlite from "better-sqlite3";
import { Database } from "../backend/storage/database";
import { migrations } from "../backend/storage/migrations";
import { CommandExecutions } from "../backend/execution/command-executions";
import { CodexProvider } from "../backend/execution/providers/codex";
import { AntigravityProvider } from "../backend/execution/providers/antigravity";

const seed = (db: Database) => {
  db.run("INSERT INTO repositories VALUES('repo','owner','repo','{}')");
  db.run(
    "INSERT INTO tasks(id,repo_id,status,stage,data,created_at) VALUES('task','repo','completed',6,'{\"id\":\"task\"}','2026-10-09T00:00:00Z')",
  );
};

it("records actual cumulative output, isolates repeated calls across runs and preserves unreported exits and interrupted commands", () => {
  const db = new Database(":memory:");
  try {
    seed(db);
    const commands = new CommandExecutions(db);
    const codex = new CodexProvider();
    const observe = (
      run: string,
      type: string,
      output?: string,
      exit?: number,
    ) => {
      for (const event of codex.normalize({
        type,
        item: {
          id: "call",
          type: "command_execution",
          command: "npm test",
          aggregated_output: output,
          exit_code: exit,
        },
      }))
        commands.observe("task", run, event);
    };
    observe("implement", "item.started");
    observe("implement", "item.updated", "test one passed\n");
    expect(db.detail("task").tests[0]).toMatchObject({
      status: "running",
      stdout: "test one passed\n",
    });
    observe(
      "implement",
      "item.completed",
      "test one passed\ntest two passed\n",
      0,
    );
    observe("review", "item.started");
    observe("review", "item.completed", "test two failed\n", 1);
    commands.observe("task", "review", {
      kind: "command.finished",
      data: {
        call_id: 2,
        command: "npm run lint",
        status: "DONE",
        stdout: "lint complete",
      },
    });
    commands.observe("task", "review", {
      kind: "command.started",
      data: { call_id: 3, command: "npm run typecheck" },
    });
    commands.finish("review");
    expect(db.detail("task").tests).toEqual([
      expect.objectContaining({
        run_id: "implement",
        status: "passed",
        exit_code: 0,
        stdout: "test one passed\ntest two passed\n",
      }),
      expect.objectContaining({
        run_id: "review",
        status: "failed",
        exit_code: 1,
        stdout: "test two failed\n",
      }),
      expect.objectContaining({
        command: "npm run lint",
        status: "completed",
        exit_code: null,
      }),
      expect.objectContaining({
        command: "npm run typecheck",
        status: "interrupted",
        exit_code: null,
      }),
    ]);
    const agy = new AntigravityProvider();
    for (const event of agy.normalize({
      event: "step_update",
      step_update: {
        step_index: 0,
        step_type: "tool",
        tool_name: "run_command",
        state: "ERROR",
        tool_info: {
          parameters: { CommandLine: "python -m tests" },
          error: { message: "connection dropped" },
        },
      },
    }))
      commands.observe("task", "agy", event);
    expect(db.detail("task").tests.at(-1)).toMatchObject({
      status: "failed",
      stderr: "connection dropped",
      exit_code: null,
    });
  } finally {
    db.close();
  }
});

it("retains bounded command tails with explicit truncation", () => {
  const db = new Database(":memory:");
  try {
    seed(db);
    new CommandExecutions(db).observe("task", "run", {
      kind: "command.finished",
      data: {
        call_id: 1,
        command: "npm test",
        stdout: "x".repeat(1024 * 1024) + "last line",
        exit_code: 0,
      },
    });
    const test = db.detail("task").tests[0];
    expect(String(test.stdout)).toHaveLength(1024 * 1024);
    expect(String(test.stdout).endsWith("last line")).toBe(true);
    expect(test.output_truncated).toBe(1);
  } finally {
    db.close();
  }
});

it("migrates historic provider command logs once without replacing manual validation or treating incomplete calls as passed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-command-migration-"));
  const path = join(dir, "state.sqlite");
  const old = new Sqlite(path);
  try {
    for (const migration of migrations.filter((m) => m.version < 16)) {
      old.exec(migration.sql);
      old
        .prepare("INSERT OR IGNORE INTO schema_migrations VALUES(?,?)")
        .run(migration.version, "2026-10-09T00:00:00Z");
    }
    old.exec(
      "INSERT INTO repositories VALUES('repo','owner','repo','{}'); INSERT INTO tasks(id,repo_id,status,stage,data,created_at) VALUES('task','repo','completed',6,'{\"id\":\"task\"}','2026-10-09T00:00:00Z'); INSERT INTO agent_runs(id,task_id,stage,provider,model,effort,prompt,status,started_at,ended_at) VALUES('run','task',3,'codex','','high','','completed','2026-10-09T00:00:00Z','2026-10-09T00:01:00Z'); INSERT INTO test_runs(id,task_id,command,status,started_at) VALUES('manual','task','git diff --check','passed','2026-10-09T00:00:00Z');",
    );
    const insert = old.prepare(
      "INSERT INTO agent_events(run_id,task_id,timestamp,kind,data,raw,stream) VALUES('run','task',?,?,?,'','stdout')",
    );
    insert.run(
      "2026-10-09T00:00:01Z",
      "command.started",
      JSON.stringify({ call_id: 1, command: "npm test" }),
    );
    insert.run(
      "2026-10-09T00:00:02Z",
      "command.finished",
      JSON.stringify({ call_id: 1, stdout: "passed", exit_code: 0 }),
    );
    insert.run(
      "2026-10-09T00:00:03Z",
      "command.started",
      JSON.stringify({ call_id: 2, command: "npm run lint" }),
    );
  } finally {
    old.close();
  }
  try {
    let db = new Database(path);
    try {
      expect(db.detail("task").tests).toHaveLength(3);
      expect(db.detail("task").tests.at(-1)).toMatchObject({
        status: "interrupted",
      });
      expect(db.detail("task").tests[1]).toMatchObject({
        command: "npm test",
        status: "passed",
        stdout: "passed",
      });
    } finally {
      db.close();
    }
    db = new Database(path);
    try {
      expect(db.detail("task").tests).toHaveLength(3);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
