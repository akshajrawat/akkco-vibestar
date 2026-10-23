import type { Database } from "../storage/database";
import { verificationSummary, type VerificationCommand } from "./verification";

export const taskVerification = (db: Database, id: string) => {
  const implementation = db.all<{ id: string; started_at: string }>(
    "SELECT id,started_at FROM agent_runs WHERE task_id=? AND stage=3 ORDER BY started_at DESC,rowid DESC LIMIT 1",
    id,
  )[0];
  const artifact = db.all<{ id: string; content: string }>(
    "SELECT id,content FROM task_artifacts WHERE task_id=? AND stage=3 AND kind='plan' ORDER BY created_at DESC,rowid DESC LIMIT 1",
    id,
  )[0];
  const report = artifact
    ? db.records.decode({
        table: "task_artifacts",
        id: artifact.id,
        column: "content",
        source: artifact.content,
      })
    : null;
  const commands = db.all<VerificationCommand>(
    `SELECT id,run_id,command,status,exit_code FROM test_runs WHERE task_id=? AND (run_id=? OR (run_id IS NULL AND started_at>=?)) ORDER BY started_at,rowid`,
    id,
    implementation?.id || "",
    implementation?.started_at || "9999",
  );
  const task = db.task(id);
  return verificationSummary(
    report,
    commands,
    task.stage >= 4
      ? JSON.stringify(["git", "diff", "--check", task.base_commit_sha, "--"])
      : undefined,
  );
};
