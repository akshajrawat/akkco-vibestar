import type { z } from "zod";

import type { Engine } from "../engine";
import type { AgentRunner } from "../agents/agent-runner";
import type { EngineScheduling } from "./scheduling";
import type { ExecutionState } from "./state";
import { ViberSessionStore } from "../../vibers/store";
import { ViberSessionSendSchema } from "../../vibers/contracts";
import { prepareManagedWorkspace } from "../../workspace/managed";
import { AdeError } from "../../domain";
import { redact } from "../runtime/process";

/** Explicit turns use the same foreground admission, cancellation and runner as other executions. */
export class ViberSessions {
  readonly store: ViberSessionStore;

  constructor(
    private readonly host: Pick<Engine, "db" | "root" | "git" | "changed" | "assertAvailable">,
    private readonly state: ExecutionState,
    private readonly runner: AgentRunner,
    private readonly operations: Pick<
      EngineScheduling,
      "withExecutionSlot" | "assertExecutionSlot" | "stopActivity"
    >,
  ) {
    this.store = new ViberSessionStore(host.db);
  }

  send = (raw: z.input<typeof ViberSessionSendSchema>) => {
    const parsed = ViberSessionSendSchema.parse(raw);
    const input = { ...parsed, content: redact(parsed.content) };
    this.host.assertAvailable();
    const previous = this.store.previous(input);
    if (previous) {
      return previous;
    }

    const key = `viber:${input.session_id}`;
    this.operations.assertExecutionSlot(key);
    const snapshot = this.store.capture(input);

    const completed = this.operations.withExecutionSlot(
      key,
      `${snapshot.profile.name} session`,
      this.state.repositoryController.signal,
      async (signal) => {
        try {
          let assignment = this.store.workspace(input.session_id);
          if (assignment.repo_id) {
            const repo = this.host.db.repository(assignment.repo_id);
            if (repo.connected === false || repo.clone_status === "cloning") {
              throw new AdeError(
                "repository_missing",
                "Reconnect this session's repository before executing.",
              );
            }

            if (!assignment.worktree_path || assignment.workspace_checkpoint?.state !== "ready") {
              await this.host.git.prepare(repo, assignment, signal, (value) =>
                this.store.saveWorkspace(input.session_id, value),
              );
            }
          } else {
            assignment = await prepareManagedWorkspace(this.host.root, assignment);
          }

          this.store.saveWorkspace(input.session_id, assignment);
          const workspace = await this.host.git.assertOwnedTask(assignment);
          signal.throwIfAborted();

          const output = await this.runner.runConfigured(
            { id: input.session_id },
            signal,
            snapshot.execution,
            {
              prompt: snapshot.prompt,
              purpose: `${snapshot.profile.name} session`,
              workspace,
              conversation: snapshot.conversation,
              viberSession: { sessionId: input.session_id, messageId: input.request_id },
            },
          );

          this.store.finish(input.request_id, "completed", output);
        } catch (error) {
          this.store.finish(
            input.request_id,
            signal.aborted ? (this.state.closed ? "interrupted" : "cancelled") : "failed",
            undefined,
            String(error),
          );
        } finally {
          this.host.changed();
        }
      },
    );

    // Admission is checked synchronously before the captured turn is persisted.
    void completed.catch((error) => {
      this.store.finish(input.request_id, "failed", undefined, String(error));
      this.host.changed();
    });

    this.host.changed();
    return this.store.previous(input)!;
  };

  detail = (sessionId: string, profileId: string) => ({
    ...this.store.detail(sessionId, profileId),
    runs: this.host.db.all(
      "SELECT * FROM utility_runs WHERE viber_session_id=? ORDER BY rowid",
      sessionId,
    ),
    events: this.host.db.all(
      "SELECT e.*,NULL AS task_id FROM utility_events e JOIN utility_runs r ON r.id=e.run_id WHERE r.viber_session_id=? ORDER BY e.id",
      sessionId,
    ),
  });

  cancel = async (sessionId: string, profileId: string) => {
    this.store.session(sessionId, profileId);
    await this.operations.stopActivity(`run:viber:${sessionId}`);
    return this.detail(sessionId, profileId);
  };
}
