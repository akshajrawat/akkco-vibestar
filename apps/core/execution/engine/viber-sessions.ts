import { z } from "zod";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { managedPath } from "../../workspace/paths";
import {
  ScheduleProposalSchema,
  schedulePrompt,
  type ScheduleProposal,
} from "../../vibers/schedule-operation";
import { scheduleTimezone } from "../../vibers/schedule-time";

import type { Engine } from "../engine";
import type { AgentRunner } from "../agents/agent-runner";
import type { EngineScheduling } from "./scheduling";
import type { ExecutionState } from "./state";
import { scheduleRequestDigest, ViberSessionStore, ViberStore } from "../../vibers/store";
import {
  ViberSessionSendSchema,
  type ViberContinuationPrepareSchema,
} from "../../vibers/contracts";
import { prepareManagedWorkspace } from "../../workspace/managed";
import { AdeError } from "../../domain";

type SendRequest = z.output<typeof ViberSessionSendSchema>;

export type ScheduleInterpreter = (
  input: SendRequest,
  signal: AbortSignal,
) => Promise<ScheduleProposal>;

/** Explicit turns use the same foreground admission, cancellation and runner as other executions. */
export class ViberSessions {
  readonly store: ViberSessionStore;

  private readonly interpreting = new Map<
    string,
    {
      digest: string;
      sessionId: string;
      result: Promise<ReturnType<ViberSessions["sendTurn"]>>;
    }
  >();

  constructor(
    private readonly host: Pick<
      Engine,
      | "db"
      | "root"
      | "git"
      | "changed"
      | "assertAvailable"
      | "isActive"
      | "memory"
      | "computers"
      | "schedules"
    >,
    private readonly state: ExecutionState,
    private readonly runner: AgentRunner,
    private readonly operations: Pick<
      EngineScheduling,
      "withExecutionSlot" | "assertExecutionSlot" | "stopActivity"
    >,
    private readonly interpreter?: ScheduleInterpreter | false,
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

  send = (raw: z.input<typeof ViberSessionSendSchema>) => {
    const input = ViberSessionSendSchema.parse(raw);
    this.host.assertAvailable();

    const previous = this.store.previous(input);
    if (previous) {
      return previous;
    }

    const digest = scheduleRequestDigest(input);
    const interpreting = this.interpreting.get(input.request_id);
    if (interpreting) {
      if (interpreting.digest !== digest) {
        throw new AdeError(
          "request_conflict",
          "This request ID was already used with different input.",
        );
      }

      return interpreting.result;
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

    if (input.continue_message_id || this.interpreter === false) {
      return this.sendTurn(input);
    }

    this.store.writableSession(input.session_id, input.profile_id);
    this.operations.assertExecutionSlot(key);
    const interpret = this.interpreter ?? this.interpretSchedule;

    const result = this.operations
      .withExecutionSlot(
        key,
        "Interpret Viber chat request",
        this.state.repositoryController.signal,
        async (signal) => {
          const proposal = await interpret(input, signal);
          signal.throwIfAborted();

          return proposal;
        },
      )
      .then((proposal) => {
        this.host.assertAvailable();
        const checked = ScheduleProposalSchema.parse(proposal);
        return checked.action === "chat"
          ? this.sendTurn(input)
          : this.host.schedules.apply(input, checked);
      })
      .finally(() => {
        this.interpreting.delete(input.request_id);
      });

    this.interpreting.set(input.request_id, { digest, result, sessionId: input.session_id });
    return result;
  };

  private interpretSchedule: ScheduleInterpreter = async (input, signal) => {
    const session = this.store.session(input.session_id, input.profile_id);
    const profile = new ViberStore(this.host.db).profile(input.profile_id);
    const timezone = scheduleTimezone();

    const workspaceRoot = await managedPath(
      this.host.root,
      join(this.host.root, "cache", "utility"),
    );

    await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
    const workspace = await mkdtemp(join(workspaceRoot, "schedule-intent-"));
    try {
      const result = await this.runner.runConfigured(
        { id: session.id },
        signal,
        {
          ...profile.execution,
          ...(input.selection ?? session.selection),
          access: "read-only",
          output: "custom",
          timeout_secs: Math.min(profile.execution.timeout_secs, 90),
        },
        {
          purpose: "Interpret Viber schedule request",
          schema: ScheduleProposalSchema,
          interpretSchedule: true,
          workspace,
          prompt: schedulePrompt({
            message: input.content,
            currentTime: new Date().toISOString(),
            timezone,
            schedules: this.host.schedules
              .list(input.profile_id)
              .filter(({ status }) => status !== "cancelled" && status !== "completed")
              .slice(0, 100)
              .map(({ id, name, task, cadence, status }) => ({ id, name, task, cadence, status })),
            clarification: this.host.schedules.clarification(session.id),
          }),
        },
      );

      signal.throwIfAborted();
      return ScheduleProposalSchema.parse(result);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  };

  runScheduledInstruction = (
    profileId: string,
    sessionId: string,
    instructions: string,
    signal: AbortSignal,
  ) => {
    if ([...this.interpreting.values()].some((request) => request.sessionId === sessionId)) {
      throw new AdeError("busy", "This Viber is handling a chat request. The schedule will retry.");
    }

    return this.operations.withExecutionSlot(
      `viber:${sessionId}`,
      "Run scheduled Viber instruction",
      signal,
      async (runSignal) => {
        const session = this.store.writableSession(sessionId, profileId);
        const profile = new ViberStore(this.host.db).profile(profileId);
        const workspace = await this.prepareWorkspace(sessionId, profileId, runSignal);
        runSignal.throwIfAborted();

        const output = await this.runner.runConfigured(
          { id: sessionId },
          runSignal,
          {
            ...profile.execution,
            ...session.selection,
            access: "read-only",
            output: "summary",
          },
          {
            purpose: "Scheduled Viber instruction",
            workspace,
            detachedSessionId: sessionId,
            prompt: `${profile.instructions}\n\nRun this saved instruction once and summarize the result. Use read-only access.\n${instructions}`,
          },
        );

        return z.object({ summary: z.string() }).parse(output).summary;
      },
    );
  };

  private sendTurn = (input: SendRequest) => {
    const key = `viber:${input.session_id}`;
    this.operations.assertExecutionSlot(key);

    const shareWorkspace =
      input.shared_computer && this.host.db.settings().allow_viber_communication;

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

          const run = (sharedComputer?: { files: string; socket?: string }) =>
            this.runner.runConfigured({ id: input.session_id }, signal, snapshot.execution, {
              prompt: snapshot.prompt,
              purpose: `${snapshot.profile.name} session`,
              workspace,
              sharedComputer,
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
            });

          const output = shareWorkspace
            ? await this.host.computers.withTurn(
                snapshot.execution.access === "read-only",
                signal,
                run,
              )
            : await run();

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
