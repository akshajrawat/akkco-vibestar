import { AdeError, now } from "../../domain";
import type { z } from "zod";
import { ConversationScopeSchema, ViberChatSchema } from "../../flows/run-contracts";
import { resolveNodeInputs } from "../../flows/context";
import type { FlowDispatchStore } from "../../flows/dispatch-store";
import type { Engine } from "../engine";
import { redact } from "../runtime/process";
import type { ExecutionState } from "./state";

type ViberRequestHost = Pick<
  Engine,
  "assertAvailable" | "changed" | "db" | "drain" | "flowRuns" | "flows"
>;

/** Validates and queues a user-selected conversation for one captured Viber instance. */
export class ViberConversationRequests {
  constructor(
    private readonly host: ViberRequestHost,
    private readonly state: Pick<ExecutionState, "taskMaintenance">,
    private readonly dispatches: FlowDispatchStore,
    private readonly assertTaskOpen: (taskId: string) => void,
  ) {}

  chat = (raw: z.input<typeof ViberChatSchema>) => {
    const { content, ...configuration } = ViberChatSchema.parse(raw);
    const input = { ...configuration, content };
    this.host.assertAvailable();

    const run = this.host.db.transaction(() => {
      const previous = this.host.db.all<{
        task_id: string;
        content: string;
        configuration: string;
      }>("SELECT task_id,content,configuration FROM task_messages WHERE id=?", input.request_id)[0];

      if (previous) {
        if (
          previous.task_id !== input.task_id ||
          previous.content !== redact(input.content) ||
          previous.configuration !== JSON.stringify(configuration)
        )
          throw new AdeError(
            "request_conflict",
            "This conversation request belongs to a different message.",
          );

        const saved = this.host.db.all<{ id: string }>(
          "SELECT id FROM flow_runs WHERE request_id=? AND task_id=?",
          input.request_id,
          input.task_id,
        )[0];

        if (!saved)
          throw new AdeError(
            "request_completed",
            "This message has no retained execution. Send a new explicit message.",
          );
        return this.host.flowRuns.run(saved.id);
      }

      this.assertTaskOpen(input.task_id);
      if (this.state.taskMaintenance.has(input.task_id))
        throw new AdeError("busy", "Wait for task maintenance before starting a conversation.");
      const task = this.host.db.task(input.task_id);
      if (!task.flow_id || !task.goal)
        throw new AdeError(
          "invalid_state",
          "Select a task with a saved Viber graph before sending a message.",
        );
      const saved = this.host.flows.definition(task.flow_id);
      if (saved.revision !== input.expected_revision)
        throw new AdeError(
          "revision_conflict",
          "Reload the saved flow before sending this message.",
        );
      const node = saved.definition.nodes.find((node) => node.id === input.node_id);
      if (node?.type !== "agent")
        throw new AdeError("invalid_state", "Select an agent Viber from this task's saved graph.");
      if (input.profile_id !== node.profile_id)
        throw new AdeError(
          "revision_conflict",
          "This graph instance now uses a different Viber. Reload its conversation before sending.",
        );
      const profile = this.host.flows.profile(node.profile_id);
      for (const id of input.history_ids) {
        if (
          !this.host.db.all(
            "SELECT id FROM task_messages WHERE id=? AND task_id=? AND flow_node_id=? AND viber_profile_id=? AND purpose='chat' AND status='chat_completed'",
            id,
            task.id,
            node.id,
            profile.id,
          ).length
        )
          throw new AdeError(
            "context",
            "Select completed conversation messages from this task and Viber instance.",
          );
      }

      const inputs = [
        ...input.inputs,
        ...input.history_ids.map((message_id) => ({ kind: "message" as const, message_id })),
        { kind: "message" as const, message_id: input.request_id },
      ];

      const scope = ConversationScopeSchema.parse({
        node_id: node.id,
        inputs: inputs.filter(
          (binding, index) =>
            inputs.findIndex((other) => JSON.stringify(other) === JSON.stringify(binding)) ===
            index,
        ),
      });

      this.host.db.run(
        "INSERT INTO task_messages(id,task_id,role,content,created_at,status,configuration,purpose,flow_node_id,viber_profile_id) VALUES(?,?,'user',?,?,'chat_pending',?,'chat',?,?)",
        input.request_id,
        task.id,
        redact(input.content),
        now(),
        JSON.stringify(configuration),
        node.id,
        profile.id,
      );

      const parent = this.host.db.all<{ id: string }>(
        "SELECT id FROM flow_runs WHERE task_id=? AND flow_id=? AND kind='flow' ORDER BY rowid DESC LIMIT 1",
        task.id,
        task.flow_id,
      )[0];

      const captured = this.host.flowRuns.createRun(
        {
          task_id: task.id,
          flow_id: task.flow_id,
          revision: saved.revision,
          goal: task.goal,
          request_id: input.request_id,
          parent_run_id: parent?.id || null,
        },
        "user",
        scope,
      );

      resolveNodeInputs(this.host.db, this.host.flowRuns, captured.id, node.id);
      this.dispatches.enqueue({ id: input.request_id, run_id: captured.id, kind: "flow" });
      return captured;
    });

    this.host.changed(run.task_id);
    void this.host.drain();
    return run;
  };
}
