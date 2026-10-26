import { randomUUID } from "node:crypto";
import type { Database } from "../../storage/database";
import type { NormalizedEvent } from "../../domain";
import { now } from "../../domain";
import { z } from "zod";
import { AntigravityProvider } from "../providers/antigravity";
export const CommandEvidenceSchema = z
  .object({
    call_id: z.union([z.string(), z.number().finite()]).nullable().optional(),
    command: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    stdout: z.string().nullable().optional(),
    stderr: z.string().nullable().optional(),
    exit_code: z.number().int().nullable().optional(),
    duration_ms: z.number().nonnegative().nullable().optional(),
  })
  .loose();

// Providers report cumulative output snapshots. Keep each call independent of
// the bounded chat event window, without inventing successful exit codes.
export class CommandExecutions {
  constructor(private readonly db: Database) {}
  recoverToolExits = (taskId: string) => {
    const provider = new AntigravityProvider();
    let recovered = 0;
    for (const event of this.db.all<{
      id: number;
      run_id: string;
      raw: string;
      timestamp: string;
    }>(
      "SELECT e.id,e.run_id,e.raw,e.timestamp FROM agent_events e JOIN agent_runs r ON r.id=e.run_id WHERE e.task_id=? AND r.provider='antigravity' AND e.kind='command.finished' ORDER BY e.id",
      taskId,
    )) {
      let raw;
      try {
        raw = JSON.parse(event.raw);
      } catch {
        continue;
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      for (const normalized of provider.normalize(raw)) {
        const parsed = CommandEvidenceSchema.safeParse(normalized.data);
        if (
          normalized.kind !== "command.finished" ||
          !parsed.success ||
          typeof parsed.data.exit_code !== "number" ||
          parsed.data.call_id == null
        )
          continue;
        const saved = this.db.all<{ exit_code: number | null }>(
          "SELECT exit_code FROM test_runs WHERE task_id=? AND run_id=? AND call_id=?",
          taskId,
          event.run_id,
          String(parsed.data.call_id),
        )[0];
        if (!saved || saved.exit_code !== null) continue;
        this.observe(taskId, event.run_id, normalized, event.timestamp);
        recovered++;
      }
    }
    return recovered;
  };
  observe = (
    taskId: string | null,
    runId: string,
    event: NormalizedEvent,
    timestamp = now(),
    repairId: string | null = null,
  ) => {
    if (!event.kind.startsWith("command.")) return;
    const data = CommandEvidenceSchema.parse(event.data);
    if (data.call_id === undefined || data.call_id === null) return;
    const callId = String(data.call_id);
    const row = this.db.all<{
      id: string;
      command: string;
      started_at: string;
      ended_at: string | null;
      duration_ms: number | null;
      stdout: string;
      stderr: string;
      status: string;
      exit_code: number | null;
      output_truncated: number;
    }>(
      `SELECT * FROM test_runs WHERE ${repairId ? "repair_id" : "task_id"}=? AND run_id=? AND call_id=?`,
      repairId || taskId,
      runId,
      callId,
    )[0];
    const command = typeof data.command === "string" ? data.command : row?.command;
    if (!command) return;
    const failed = ["failed", "error"].includes(String(data.status).toLowerCase());
    const exit = typeof data.exit_code === "number" ? data.exit_code : (row?.exit_code ?? null);
    const interrupted = ["interrupted", "cancelled", "canceled"].includes(
      String(data.status).toLowerCase(),
    );
    const finished =
      event.kind === "command.finished" ||
      failed ||
      interrupted ||
      typeof data.exit_code === "number";
    const status = finished
      ? interrupted
        ? "interrupted"
        : failed || (exit !== null && exit !== 0)
          ? "failed"
          : exit === 0
            ? "passed"
            : "completed"
      : row?.status || "running";
    const stdout = typeof data.stdout === "string" ? data.stdout : row?.stdout || "";
    const stderr = typeof data.stderr === "string" ? data.stderr : row?.stderr || "";
    const limit = 1024 * 1024;
    this.db.run(
      `INSERT INTO test_runs(id,task_id,run_id,call_id,command,status,started_at,ended_at,exit_code,duration_ms,stdout,stderr,output_truncated${repairId ? ",repair_id" : ""})
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?${repairId ? ",?" : ""}) ON CONFLICT(id) DO UPDATE SET command=excluded.command,status=excluded.status,ended_at=excluded.ended_at,exit_code=excluded.exit_code,duration_ms=excluded.duration_ms,stdout=excluded.stdout,stderr=excluded.stderr,output_truncated=excluded.output_truncated`,
      row?.id || randomUUID(),
      taskId,
      runId,
      callId,
      command,
      status,
      row?.started_at || timestamp,
      finished ? timestamp : row?.ended_at || null,
      exit,
      typeof data.duration_ms === "number"
        ? data.duration_ms
        : finished
          ? Math.max(0, Date.parse(timestamp) - Date.parse(row?.started_at || timestamp))
          : (row?.duration_ms ?? null),
      stdout.slice(-limit),
      stderr.slice(-limit),
      stdout.length > limit || stderr.length > limit || row?.output_truncated ? 1 : 0,
      ...(repairId ? [repairId] : []),
    );
  };
  finish = (runId: string, timestamp = now()) =>
    this.db.run(
      "UPDATE test_runs SET status='interrupted',ended_at=? WHERE run_id=? AND status='running'",
      timestamp,
      runId,
    );
}
