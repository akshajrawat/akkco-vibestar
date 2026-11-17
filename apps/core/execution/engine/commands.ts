import type { Engine } from "../engine";
import type { ExecutionState } from "./state";

import { randomUUID } from "node:crypto";
import { AdeError, now, type WorkspaceAssignment } from "../../domain";
import type { VerificationEnvironment } from "../verification/browser/contracts";
import { execute } from "../runtime/process";
import { sandboxInvocation } from "../runtime/sandbox";
import { FlowRunStore } from "../../flows/run-store";

/** Runs validated argv in the assigned sandbox and persists observed command evidence. */
export class CommandExecution {
  constructor(
    private readonly host: Pick<
      Engine,
      "isActive" | "db" | "git" | "root" | "publish" | "assertAvailable" | "changed" | "drain"
    >,
    private readonly state: ExecutionState,
  ) {}

  manual = async (
    id: string,
    argv: string[],
    signal?: AbortSignal,
    internal = false,
    repair?: WorkspaceAssignment,
    verification?: {
      environment?: VerificationEnvironment;
      readOnly?: boolean;
      timeoutMs?: number;
      nodeAttemptId?: string;
    },
  ) => {
    if (!argv.length || argv.length > 100 || argv.some((s) => typeof s !== "string"))
      throw new AdeError(
        "invalid_input",
        "Provide executable and arguments as a JSON string array",
      );
    if (!internal && this.host.isActive(id))
      throw new AdeError(
        "invalid_state",
        "Wait for task execution to finish before running a manual command",
      );
    const t = repair || this.host.db.task(id);
    let input: string | undefined;
    if (verification?.nodeAttemptId) {
      if (repair)
        throw new AdeError("isolation", "Task flow nodes cannot attach repair execution.");

      new FlowRunStore(this.host.db).assertCommandExecution(
        verification.nodeAttemptId,
        id,
        argv,
        verification.readOnly || false,
        verification.timeoutMs || 1800000,
      );

      const inputs = new FlowRunStore(this.host.db).attempt(verification.nodeAttemptId).inputs;
      if (inputs.length) input = `${JSON.stringify({ inputs })}\n`;
    }

    const cwd = await this.host.git.assertTask(t);
    const run = randomUUID();

    this.host.db.run(
      `INSERT INTO test_runs(id,${repair ? "repair_id" : "task_id"},command,status,started_at) VALUES(?,?,?,'running',?)`,
      run,
      id,
      JSON.stringify(argv),
      now(),
    );

    const owner = repair ? { repair_id: id } : { task_id: id };
    this.host.publish({ event: "changed", ...owner });
    try {
      if (verification?.nodeAttemptId) {
        const runs = new FlowRunStore(this.host.db);
        runs.attachExecution(verification.nodeAttemptId, run, "command");
        if (
          runs.attempt(verification.nodeAttemptId).workspace_fingerprint !==
          (await this.host.git.fingerprint(t))
        )
          throw new AdeError(
            "stale_context",
            "The workspace changed after command inputs were captured. Retry explicitly.",
          );
      }

      const invocation = await sandboxInvocation(
        this.host.root,
        this.host.db,
        t,
        {
          program: argv[0],
          args: argv.slice(1),
          input,
          verificationEnvironment: verification?.environment,
        },
        verification?.readOnly || false,
      );

      const output = await execute({
        ...invocation,
        cwd,
        signal,
        timeoutMs: verification?.timeoutMs || 1800000,
        onSpawn: (pid, identity) =>
          this.host.db.run(
            "UPDATE test_runs SET pid=?,process_identity=? WHERE id=?",
            pid,
            identity,
            run,
          ),
        onLine: (stream, text) => {
          const column = stream === "stdout" ? "stdout" : "stderr";

          this.host.db.run(
            `UPDATE test_runs SET ${column}=substr(${column}||?,-1048576),output_truncated=CASE WHEN length(${column})+length(?)>1048576 THEN 1 ELSE output_truncated END WHERE id=?`,
            `${text}\n`,
            `${text}\n`,
            run,
          );

          this.host.publish({ event: "command.output", ...owner, stream, text });
        },
      });

      this.host.db.run(
        "UPDATE test_runs SET status=?,ended_at=?,exit_code=?,duration_ms=?,stdout=?,stderr=?,output_truncated=0 WHERE id=?",
        output.code === 0 ? "passed" : "failed",
        now(),
        output.code,
        output.duration_ms,
        output.stdout,
        output.stderr,
        run,
      );

      return output;
    } catch (e) {
      this.host.db.run(
        "UPDATE test_runs SET status=?,ended_at=?,stderr=? WHERE id=?",
        signal?.aborted ? "cancelled" : "failed",
        now(),
        String(e),
        run,
      );

      throw e;
    } finally {
      this.host.publish({ event: "changed", ...owner });
    }
  };

  runCommand = async (id: string, argv: string[], diagnostic = false) => {
    this.host.assertAvailable();
    if (this.state.taskMaintenance.has(id))
      throw new AdeError("busy", "Task data cleanup is running");
    if (this.host.isActive(id))
      throw new AdeError("invalid_state", "Task already has an active process");
    if (this.state.active.size >= this.host.db.settings().concurrency)
      throw new AdeError("busy", "Wait for execution capacity before running another command.");
    const controller = new AbortController();

    const output = Promise.resolve().then(() =>
      this.manual(id, argv, controller.signal, true, undefined, {
        environment: this.host.db.task(id).verification_environment,
        readOnly: diagnostic,
        timeoutMs: diagnostic ? 25000 : undefined,
      }),
    );

    const promise = output
      .then(() => {})
      .catch(() => {})
      .finally(() => {
        this.state.active.delete(id);
        this.host.changed(id);
        void this.host.drain();
      });

    this.state.active.set(id, { controller, promise });
    return output;
  };
}
