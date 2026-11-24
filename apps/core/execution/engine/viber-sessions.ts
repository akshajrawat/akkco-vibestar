import type { z } from "zod";

import type { Engine } from "../engine";
import type { AgentRunner } from "../agents/agent-runner";
import type { EngineScheduling } from "./scheduling";
import type { ExecutionState } from "./state";
import { ViberSessionStore } from "../../vibers/store";
import type { ViberContinuationPrepareSchema } from "../../vibers/contracts";
import { ViberSessionSendSchema } from "../../vibers/contracts";
import { prepareManagedWorkspace } from "../../workspace/managed";
import { AdeError } from "../../domain";
import { parseWatchCommand } from "../../github/contracts";

/** Explicit turns use the same foreground admission, cancellation and runner as other executions. */
export class ViberSessions {
  readonly store: ViberSessionStore;

  constructor(
    private readonly host: Pick<
      Engine,
      "db" | "root" | "git" | "changed" | "assertAvailable" | "isActive" | "memory" | "prWatches"
    >,
    private readonly state: ExecutionState,
    private readonly runner: AgentRunner,
    private readonly operations: Pick<
      EngineScheduling,
      "withExecutionSlot" | "assertExecutionSlot" | "stopActivity"
    >,
  ) {
    this.store = new ViberSessionStore(host.db);
  }

  prepareWorkspace = async (sessionId: string, profileId: string, signal?: AbortSignal) => {
    this.store.session(sessionId, profileId);
    let assignment = this.store.workspace(sessionId);
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
          this.store.saveWorkspace(sessionId, value),
        );
      }
    } else {
      assignment = await prepareManagedWorkspace(this.host.root, assignment);
    }

    this.store.saveWorkspace(sessionId, assignment);
    return this.host.git.assertOwnedTask(assignment);
  };

  prepareContinuation = async (input: z.output<typeof ViberContinuationPrepareSchema>) => {
    const key = `viber:${input.session_id}`;

    await this.operations.withExecutionSlot(
      key,
      "Prepare Viber continuation",
      this.state.repositoryController.signal,
      async (signal) => {
        let preparation = this.store.continuationPreparation(input);
        if (!preparation) {
          this.store.finishContinuationPreparation(input);
          return;
        }

        if (preparation.execution.provider !== "codex") {
          throw new AdeError(
            "context",
            "Antigravity cannot preload conversation history without starting a turn. Continue with the original provider.",
          );
        }

        const workspace = await this.prepareWorkspace(input.session_id, input.profile_id, signal);

        const preload = (plan: NonNullable<typeof preparation>) =>
          this.runner.preloadViberThread(input.session_id, workspace, plan, signal);

        let prepared;
        try {
          prepared = await preload(preparation);
        } catch (error) {
          if (
            !preparation.thread ||
            !(error instanceof AdeError) ||
            error.kind !== "thread_resume_rejected"
          ) {
            throw error;
          }

          // The selected target is missing. Prepare a replacement without starting a turn.
          preparation = this.store.continuationPreparation(input, true);
          if (!preparation) {
            throw error;
          }

          prepared = await preload(preparation);
        }

        signal.throwIfAborted();
        this.store.finishContinuationPreparation(input, { ...preparation, ...prepared });
      },
    );

    this.host.changed();
    return this.detail(input.session_id, input.profile_id);
  };

  send = async (raw: z.input<typeof ViberSessionSendSchema>) => {
    const input = ViberSessionSendSchema.parse(raw);
    this.host.assertAvailable();

    const previous = this.store.previous(input);
    if (previous) {
      return previous;
    }

    const key = `viber:${input.session_id}`;
    if (input.content === "/clear" && !input.continue_message_id) {
      if (this.host.isActive(key)) {
        throw new AdeError(
          "busy",
          "Wait for this Viber session to finish before clearing context.",
        );
      }

      const cleared = this.store.clearContext(input.session_id, input.profile_id, input.request_id);
      this.host.changed();
      return cleared;
    }

    const watchCommand = !input.continue_message_id ? parseWatchCommand(input.content) : null;
    if (watchCommand) {
      if (this.host.isActive(key)) {
        throw new AdeError(
          "busy",
          "Wait for this Viber session to finish before sending a watch command.",
        );
      }

      return await this.host.prWatches.handleChatCommand(
        input.session_id,
        input.profile_id,
        input.request_id,
        input.content,
        watchCommand,
      );
    }

    this.operations.assertExecutionSlot(key);

    const snapshot = this.store.capture(input);

    const completed = this.operations.withExecutionSlot(
      key,
      `${snapshot.profile.name} session`,
      this.state.repositoryController.signal,
      async (signal) => {
        try {
          const workspace = await this.prepareWorkspace(input.session_id, input.profile_id, signal);

          const memory = this.host.memory;

          const scope = {
            profileId: input.profile_id,
            sessionId: input.session_id,
            messageId: input.request_id,
            repositoryId: this.store.session(input.session_id, input.profile_id).repository_id,
            provider: snapshot.execution.provider,
          };

          const userMessage =
            !input.continue_message_id && !/^\s*\/[\w-]+(?:\s|$)/.test(input.content);

          const suggestionSignal = userMessage ? memory.suggestionSignal(input.content) : undefined;

          const recall = userMessage
            ? await memory.prepareRecall(scope, input.content, signal)
            : undefined;

          const suggestions: unknown[] = [];

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
              originalPrompt: snapshot.originalPrompt,
              viberSession: { sessionId: input.session_id, messageId: input.request_id },
              memory: {
                service: memory,
                scope,
                recall,
                suggest: suggestionSignal
                  ? (value) => {
                      if (!suggestionSignal.aborted && suggestions.length < 3) {
                        suggestions.push(value);
                      }
                    }
                  : undefined,
              },
            },
          );

          this.store.finish(input.request_id, "completed", output);
          if (suggestionSignal) {
            memory.learn(scope, input.content, suggestions, suggestionSignal);
          }
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
