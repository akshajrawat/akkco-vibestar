import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Sqlite from "better-sqlite3";
import { migrations } from "../../backend/storage/migrations";
import { Database } from "../../backend/storage/database";
import { defaultSettings } from "../../backend/domain";
import { PRAnalysis } from "../../backend/review/pr/analysis";
import type { Engine } from "../../backend/execution/engine";
import { prSnapshot } from "../helpers/pr-fixtures";

it("disables every legacy automatic PR inspection while retaining snapshots, conversations, analysis and usage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-manual-migration-"));
  const path = join(dir, "state.sqlite");
  const old = new Sqlite(path);
  for (const migration of migrations.filter((m) => m.version <= 16)) {
    old.exec(migration.sql);

    old
      .prepare("INSERT OR IGNORE INTO schema_migrations VALUES(?,?)")
      .run(migration.version, "before");
  }

  old.prepare("INSERT INTO settings VALUES('github_watch',?)").run(
    JSON.stringify({
      auto_watch: true,
      interval_minutes: 60,
      verify_codex: true,
    }),
  );

  old.prepare("INSERT INTO settings VALUES('pipeline',?)").run(JSON.stringify(defaultSettings));
  for (const status of ["idle", "pending", "polling", "analyzing", "error", "interrupted"]) {
    old.prepare("INSERT INTO scheduled_jobs VALUES(?,?)").run(
      status,
      JSON.stringify({
        id: status,
        enabled: true,
        check_once: true,
        status,
        last_snapshot: prSnapshot,
        pending_snapshot: prSnapshot,
        action: { summary: "Saved decision" },
        conversation_action: { summary: "Saved conversation" },
        next_run_at: "2026-01-01T00:00:00Z",
      }),
    );
  }

  old
    .prepare(
      "INSERT INTO scheduled_attention(id,job_id,created_at,summary,changes,analysis) VALUES('attention','idle','before','Saved review','[]','saved analysis')",
    )
    .run();

  old
    .prepare(
      "INSERT INTO scheduled_agent_runs(id,job_id,stage,provider,model,effort,prompt,status,started_at,output) VALUES('run','idle',1,'codex','saved-model','high','saved prompt','completed','before','saved result')",
    )
    .run();

  old
    .prepare(
      "INSERT INTO ai_usage(id,job_id,purpose,provider,model,effort,started_at,status,input_tokens) VALUES('run','idle','PR Review Analysis','codex','saved-model','high','before','completed',123)",
    )
    .run();

  old.close();
  try {
    for (let iteration = 0; iteration < 2; iteration++) {
      const db = new Database(path);
      try {
        for (const row of db.all<{ data: string }>("SELECT data FROM scheduled_jobs")) {
          const job = JSON.parse(row.data);
          expect(job.enabled).toBe(false);
          expect(job.check_once).toBe(false);
          expect(job.last_snapshot).toEqual(prSnapshot);
          expect(job.pending_snapshot).toEqual(prSnapshot);
          expect(job.action.summary).toBe("Saved decision");
          expect(job.conversation_action.summary).toBe("Saved conversation");
          if (["pending", "polling", "analyzing"].includes(job.id))
            expect(job.status).toBe("interrupted");
        }

        expect(
          JSON.parse(
            db.all<{ value: string }>("SELECT value FROM settings WHERE key='github_watch'")[0]
              .value,
          ).auto_watch,
        ).toBe(false);

        expect(db.all("SELECT summary,analysis FROM scheduled_attention")).toEqual([
          { summary: "Saved review", analysis: "saved analysis" },
        ]);

        expect(db.all("SELECT prompt,output FROM scheduled_agent_runs")).toEqual([
          { prompt: "saved prompt", output: "saved result" },
        ]);

        expect(db.all("SELECT input_tokens FROM ai_usage")).toEqual([{ input_tokens: 123 }]);
        expect(db.settings()).toEqual(defaultSettings);
      } finally {
        db.close();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("recovers unfinished PR analysis without changing a queued issue's scheduling or artifacts", () => {
  const db = new Database(":memory:");
  try {
    db.run(
      "INSERT INTO repositories VALUES('repo','upstream','project',?)",
      JSON.stringify({ id: "repo" }),
    );

    db.run(
      "INSERT INTO tasks(id,repo_id,status,stage,data,created_at) VALUES('issue','repo','queued',2,?,'before')",
      JSON.stringify({
        id: "issue",
        repo_id: "repo",
        stage: 2,
        status: "queued",
        updated_at: "before",
      }),
    );

    db.run("INSERT INTO task_artifacts VALUES('plan','issue',1,'plan','saved plan','before')");

    db.run(
      "INSERT INTO scheduled_jobs VALUES('job',?)",
      JSON.stringify({ id: "job", enabled: false, status: "analyzing" }),
    );

    db.run(
      "INSERT INTO pr_analyses VALUES('analysis','job','running','before',NULL,?)",
      JSON.stringify({
        id: "analysis",
        job_id: "job",
        status: "running",
        phase: "Analyzing",
        snapshot: prSnapshot,
      }),
    );

    db.recover();

    expect(db.task("issue")).toMatchObject({
      status: "queued",
      stage: 2,
      updated_at: "before",
    });

    expect(db.all("SELECT content FROM task_artifacts")).toEqual([{ content: "saved plan" }]);
    const service = new PRAnalysis({ db } as Engine);

    expect(service.history("job")[0]).toMatchObject({
      status: "interrupted",
      snapshot: prSnapshot,
    });

    expect(service.history("job")[0].error).toContain("Analyze Again explicitly");
    expect(db.all("SELECT * FROM ai_usage")).toEqual([]);
  } finally {
    db.close();
  }
});
