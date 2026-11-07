import type { Database } from "../storage/database";
import {
  commandVerification,
  type VerificationCommand,
} from "../execution/verification/verification";
import type { NodeAttempt } from "./run-contracts";

/** A successful setup/read command is not evidence that checks ran. */
export const observedVerification = (
  db: Database,
  attempt: NodeAttempt,
): NodeAttempt["verification"] => {
  const rows = db.all<VerificationCommand>(
    attempt.agent_run_id
      ? "SELECT id,command,status,exit_code,run_id,stdout,stderr FROM test_runs WHERE run_id=?"
      : "SELECT id,command,status,exit_code,run_id,stdout,stderr FROM test_runs WHERE id=?",
    attempt.agent_run_id || attempt.command_run_id,
  );

  const evidence = rows.map((row) => commandVerification(row));
  if (evidence.some((check) => check.kind === "check" && check.outcome === "failed"))
    return "failed";
  if (rows.some((row) => row.status !== "passed" || row.exit_code !== 0)) return "missing";
  return evidence.some(
    (check) => check.required && check.kind === "check" && check.outcome === "passed",
  )
    ? "passed"
    : "missing";
};
