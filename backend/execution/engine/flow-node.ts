import { randomUUID } from "node:crypto";

import { AdeError, now, type Task } from "../../domain";
import { agentNodePrompt, type NodeAttempt } from "../../flows/run-contracts";
import { observedVerification } from "../../flows/verification";
import type { Engine } from "../engine";
import type { AgentRunner } from "../agents/agent-runner";
import { redact } from "../runtime/process";
import type { ExecutionState } from "./state";
import type { FlowDispatchStore } from "../../flows/dispatch-store";

const message = (error: unknown) =>
  redact(error instanceof Error ? error.message : String(error)).slice(0, 32000);

/** Executes one captured non-approval node and settles its linked conversation evidence. */
export class FlowNodeExecutor {
  constructor(
    private readonly host: Pick<Engine, "db" | "git" | "manual" | "changed" | "flowRuns">,
    private readonly state: ExecutionState,
    private readonly runner: AgentRunner,
    private readonly dispatches: FlowDispatchStore,
  ) {}

  execute = async (task: Task, attempt: NodeAttempt, signal: AbortSignal) => {
    const node = attempt.configuration.node;
    try {
      let output: string;
      if (node.type === "agent") {
        if (!attempt.configuration.agent)
          throw new AdeError("invalid_state", "The captured agent settings are missing.");

        const result = await this.runner.runConfigured(
          task,
          signal,
          attempt.configuration.agent.execution,
          { prompt: agentNodePrompt(attempt), purpose: node.name, nodeAttemptId: attempt.id },
        );

        output = JSON.stringify(result);
      } else if (node.type === "command") {
        const result = await this.host.manual(task.id, node.argv, signal, true, undefined, {
          readOnly: node.access === "read-only",
          timeoutMs: node.timeout_secs * 1000,
          nodeAttemptId: attempt.id,
        });

        const linked = this.host.flowRuns.attempt(attempt.id);
        output = JSON.stringify({ command_run_id: linked.command_run_id });
        if (result.code !== 0) {
          this.host.flowRuns.finishAttempt(
            attempt.id,
            "failed",
            output,
            observedVerification(this.host.db, linked),
            "The configured command failed.",
          );

          return;
        }
      } else return;

      if (output.length > 1048576)
        throw new AdeError(
          "output_limit",
          "The node result exceeds 1 MiB. The full execution record is retained; reduce the requested output before retrying.",
        );
      const linked = this.host.flowRuns.attempt(attempt.id);

      const verification = observedVerification(this.host.db, linked);

      await this.host.git.assertOwnedTask(task);
      const fingerprint = await this.host.git.fingerprint(task);
      signal.throwIfAborted();

      this.host.flowRuns.finishAttempt(
        attempt.id,
        "completed",
        output,
        verification,
        null,
        fingerprint,
      );
    } catch (error) {
      const current = this.host.flowRuns.attempt(attempt.id);
      if (current.status === "running")
        this.host.flowRuns.finishAttempt(
          attempt.id,
          signal.aborted ? (this.state.closed ? "interrupted" : "cancelled") : "failed",
          null,
          observedVerification(this.host.db, current),
          message(error),
        );
      if (signal.aborted) throw error;
    } finally {
      const linked = this.host.flowRuns.attempt(attempt.id);
      const run = this.host.flowRuns.run(attempt.run_id);

      const chat = this.host.db.all<{
        id: string;
        flow_node_id: string | null;
        viber_profile_id: string | null;
      }>(
        "SELECT id,flow_node_id,viber_profile_id FROM task_messages WHERE id=? AND task_id=? AND purpose='chat' AND status='chat_pending'",
        run.request_id,
        task.id,
      )[0];

      if (chat) {
        this.host.db.transaction(() => {
          this.host.db.run(
            "UPDATE task_messages SET status=?,run_id=? WHERE id=?",
            linked.status === "completed"
              ? "chat_completed"
              : linked.status === "interrupted"
                ? "chat_interrupted"
                : linked.status === "cancelled"
                  ? "chat_cancelled"
                  : "chat_failed",
            linked.agent_run_id,
            chat.id,
          );

          if (linked.status === "completed" && linked.output)
            this.host.db.run(
              "INSERT INTO task_messages(id,task_id,role,content,created_at,status,run_id,purpose,flow_node_id,viber_profile_id) VALUES(?,?,'assistant',?,?,'chat_completed',?,'chat',?,?)",
              randomUUID(),
              task.id,
              linked.output,
              now(),
              linked.agent_run_id,
              chat.flow_node_id,
              chat.viber_profile_id,
            );
        });
      }

      if (
        run.kind === "conversation" &&
        run.parent_run_id &&
        attempt.configuration.agent?.execution.access === "workspace-write"
      ) {
        let reason: string | null = null;
        try {
          if (
            (await this.host.git.fingerprint(this.host.db.task(task.id))) !==
            attempt.workspace_fingerprint
          )
            reason =
              "A Viber conversation changed the shared workspace. Apply a saved revision or start a fresh graph run before continuing.";
        } catch {
          reason =
            "Workspace evidence became unavailable after a Viber conversation. Restore ownership and apply a saved revision before continuing the graph.";
        }

        if (reason) {
          this.host.flowRuns.invalidateWorkspace(run.parent_run_id, reason);
          this.dispatches.stopRun(run.parent_run_id, "cancelled");
        }
      }

      this.host.changed(task.id);
    }
  };

  complete = (runId: string) => {
    const attempts = this.host.flowRuns.results(runId);
    return this.host.flowRuns
      .definition(runId)
      .nodes.every(
        (node) =>
          attempts.filter((attempt) => attempt.node_id === node.id).at(-1)?.status === "completed",
      );
  };

  finishConversationMessage = (runId: string) => {
    const run = this.host.flowRuns.run(runId);

    const status =
      run.status === "completed"
        ? "chat_completed"
        : run.status === "cancelled"
          ? "chat_cancelled"
          : run.status === "interrupted"
            ? "chat_interrupted"
            : run.status === "failed"
              ? "chat_failed"
              : null;

    if (status)
      this.host.db.run(
        "UPDATE task_messages SET status=? WHERE id=? AND task_id=? AND purpose='chat' AND status='chat_pending'",
        status,
        run.request_id,
        run.task_id,
      );
  };
}
