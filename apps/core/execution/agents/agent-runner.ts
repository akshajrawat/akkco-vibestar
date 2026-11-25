import { sharedFilesMount, sharedServicesMount } from "../../computers/contracts";
import { z } from "zod";
import { Usage } from "../output/usage";
import { discoverCodexModels } from "../providers/codex-models";
import { sandboxInvocation } from "../runtime/sandbox";
import { mkdir, open, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AdeError, now, type CoreEvent, type NormalizedEvent } from "../../domain";
import type { Database } from "../../storage/database";
import type { GitWorkspace } from "../../workspace/git";
import { execute, redact, type ProcessRequest } from "../runtime/process";
import { BoundedWriter } from "../output/bounded-output";
import { AgentExecutionSchema, type AgentExecution } from "../contracts";
import { executionSchema } from "./execution-output";
import { ViberSessionStore } from "../../vibers/store";
import type { ViberMemory } from "../../vibers/memory";
import type { MemoryMatch, MemoryTurnScope } from "../../vibers/memory-index";
import { codexMemoryEvent } from "../providers/codex-conversation";
import {
  object,
  type AgentProvider,
  type AgentRunRequest,
  configurationError,
  type ProviderDetection,
} from "../providers/contracts";

interface AgentRunOptions {
  prompt: string;
  purpose: string;
  workspace?: string;
  sharedComputer?: { files: string; socket?: string };
  schema?: z.ZodType;
  contextPaths?: string[];
  conversation?: { threadId?: string; instructions?: string; context?: string };
  originalPrompt?: string;
  viberSession?: { sessionId: string; messageId: string };
  memory?: {
    service: ViberMemory;
    scope: MemoryTurnScope;
    recall?: (threadId?: string) => MemoryMatch[];
    suggest?: (value: unknown) => void;
  };
}

export class AgentRunner {
  private readonly detections = new Map<string, { at: number; value: ProviderDetection }>();

  constructor(
    private readonly root: string,
    private readonly db: Database,
    private readonly git: GitWorkspace,
    private readonly emit: (e: CoreEvent) => void,
    private readonly providers: (
      stage: number,
      provider?: "codex" | "antigravity",
    ) => AgentProvider,
  ) {}

  clearProviderDetection = () => this.detections.clear();

  private detect = async (provider: AgentProvider, signal: AbortSignal) => {
    signal.throwIfAborted();
    const cached = this.detections.get(provider.name);
    if (cached && Date.now() - cached.at < 30000) {
      return cached.value;
    }

    const value = await provider.detect(this.root, signal);
    signal.throwIfAborted();
    // Cache successful official discovery briefly, never authentication failures or fixture capabilities.
    if (
      ["codex", "antigravity"].includes(value.provider) &&
      value.installed &&
      value.connected &&
      value.capabilities.length
    ) {
      this.detections.set(provider.name, { at: Date.now(), value });
    }

    return value;
  };

  runConfigured = (
    owner: { id: string },
    signal: AbortSignal,
    execution: AgentExecution,
    options: AgentRunOptions,
  ) => this.execute(owner, signal, execution, options);

  preloadViberThread = async (
    sessionId: string,
    workspace: string,
    preparation: NonNullable<ReturnType<ViberSessionStore["continuationPreparation"]>>,
    signal: AbortSignal,
  ) => {
    const { execution, thread, context, instructions } = preparation;
    const provider = this.providers(0, "codex");
    const detection = await this.detect(provider, signal);
    const invalid = configurationError(detection, execution);
    const model = execution.model || detection.models.find((entry) => entry.isDefault)?.id;
    if (!detection.connected || !detection.capabilities.includes("native-conversations")) {
      throw new AdeError(
        "context",
        "Connect Codex with native conversation support to preload history.",
      );
    }

    if (invalid || !model) {
      throw new AdeError("model", invalid || "Choose a Codex model before preloading history.");
    }

    if (thread && !context) {
      return { threadId: thread.thread_id, model };
    }

    const store = new ViberSessionStore(this.db);
    const assignment = store.workspace(sessionId);
    const cwd = await this.git.assertOwnedTask(assignment);
    if (cwd !== workspace) {
      throw new AdeError("isolation", "Viber workspace does not match its saved session.");
    }

    const direct = provider.invocation({
      runId: randomUUID(),
      cwd,
      stage: 0,
      access: execution.access,
      config: { ...execution, model },
      prompt: "",
      schema: {},
      schemaPath: "",
      workspaceType: "utility",
      conversation: { threadId: thread?.thread_id, confirmResume: thread ? true : undefined },
      preload: { instructions, context, only: true },
    });

    if (direct.program !== "codex" || !direct.inputProtocol) {
      throw new AdeError("context", "Codex context-only preload is unavailable.");
    }

    const invocation = await sandboxInvocation(
      this.root,
      this.db,
      assignment,
      direct,
      true,
      undefined,
      "codex",
      workspace,
      [],
      sessionId,
    );

    let threadId: string | null = null;

    const output = await execute({
      ...invocation,
      cwd,
      signal,
      timeoutMs: execution.timeout_secs * 1000,
      onLine: (stream, line) => {
        if (stream === "stdout") {
          const id = provider.conversationId(object(JSON.parse(line)));
          if (id) {
            store.assertUnsharedThread(sessionId, execution.provider, id);
            threadId = id;
          }
        }
      },
    });

    if (output.code !== 0 || !threadId || (thread && threadId !== thread.thread_id)) {
      throw new AdeError("context", "Codex did not prepare the requested thread.");
    }

    return { threadId, model };
  };

  private execute = async (
    t: { id: string },
    signal: AbortSignal,
    settings: AgentExecution,
    options: AgentRunOptions,
  ) => {
    const execution = AgentExecutionSchema.parse(settings);
    const resultSchema = executionSchema(execution, options.schema);
    const schema = z.toJSONSchema(resultSchema);
    const conversation = execution.output === "conversation";
    if (options.conversation && !conversation) {
      throw new AdeError("invalid_state", "Provider threads require conversation output.");
    }

    if (options.viberSession) {
      if (!conversation || t.id !== options.viberSession.sessionId) {
        throw new AdeError(
          "isolation",
          "Standalone Viber turns require their own captured session workspace.",
        );
      }

      new ViberSessionStore(this.db).assertExecution(
        options.viberSession.sessionId,
        options.viberSession.messageId,
        execution,
        options.prompt,
        options.conversation,
        options.originalPrompt,
      );
    }

    const viberWorkspace = options.viberSession
      ? new ViberSessionStore(this.db).workspace(options.viberSession.sessionId)
      : null;

    if (viberWorkspace && options.workspace !== viberWorkspace.worktree_path) {
      throw new AdeError(
        "isolation",
        "Standalone Viber turns require their own captured session workspace.",
      );
    }

    const assignment = viberWorkspace;
    if (!assignment && !options?.workspace) {
      throw new AdeError("invalid_state", "No workspace path specified for execution");
    }

    const table = "utility_runs";

    const provider = this.providers(0, execution.provider);
    const config = execution;

    const id = randomUUID();
    const started = Date.now();
    const prompt = options.prompt;
    const usage = new Usage(this.db);
    const purpose = options.purpose;
    const resumeThreadId = options.conversation?.threadId ?? null;

    usage.start(id, {
      viber_session_id: options.viberSession?.sessionId || null,
      purpose,
      provider: provider.name,
      model: config.model,
      effort: config.effort,
    });

    this.emit({
      event: "usage.changed",
      session_id: options.viberSession?.sessionId,
    });

    this.db.run(
      `INSERT INTO ${table}(id,stage,provider,model,effort,prompt,status,started_at,purpose,viber_session_id,viber_message_id) VALUES(?,0,?,?,?,?,'running',?,?,?,?)`,
      id,
      provider.name,
      config.model,
      config.effort,
      redact(prompt),
      now(),
      purpose,
      options.viberSession?.sessionId || null,
      options.viberSession?.messageId || null,
    );

    this.db.run(
      `UPDATE ${table} SET execution=? WHERE id=?`,
      JSON.stringify({ configuration: execution, output_schema: schema, resumeThreadId }),
      id,
    );

    if (options.viberSession) {
      this.db.transaction(() => {
        this.db.run(
          "UPDATE utility_runs SET viber_session_id=?,viber_message_id=? WHERE id=?",
          options.viberSession!.sessionId,
          options.viberSession!.messageId,
          id,
        );

        this.db.run(
          "UPDATE viber_messages SET run_id=? WHERE id=?",
          id,
          options.viberSession!.messageId,
        );

        this.db.run(
          "UPDATE ai_usage SET viber_session_id=? WHERE id=?",
          options.viberSession!.sessionId,
          id,
        );
      });
    }

    const utilityEvent = (event: NormalizedEvent, raw = "", stream = "stdout") => {
      if (!options.viberSession) {
        return;
      }

      this.db.run(
        "INSERT INTO utility_events(run_id,timestamp,kind,data,raw,stream) VALUES(?,?,?,?,?,?)",
        id,
        now(),
        event.kind,
        JSON.stringify(event.data ?? null),
        raw,
        stream,
      );

      this.emit({
        event: "utility.event",
        session_id: options.viberSession?.sessionId,
        run_id: id,
        ...event,
      });
    };

    const dir = join(
      this.root,
      "logs",
      options.viberSession ? `viber-${options.viberSession.sessionId}` : id,
    );

    let cwd = "";
    let stdout: Awaited<ReturnType<typeof open>> | undefined;
    let stderr: Awaited<ReturnType<typeof open>> | undefined;
    const outputAbort = new AbortController();
    const runSignal = AbortSignal.any([signal, outputAbort.signal]);
    let outputFailure: Error | undefined;

    const writes = new BoundedWriter((error) => {
      outputFailure = error;
      outputAbort.abort();
    });

    let final: unknown;
    const conversationMessages = new Map<string, string>();
    const assistantSegments: { key: string; text: string }[] = [];
    let failure: unknown;
    let privateStopReason: string | undefined;
    let code: number | null = null;
    let invoked = false;
    let officialCodex = false;
    let completedTurn = false;
    let nativeThreadId: string | null = null;
    let privateContext = false;
    let unsavedShares: MemoryMatch[] = [];
    const memory = options.memory;

    const markPrivate = () => {
      memory?.service.markPrivateRun(id);
      privateContext = true;
    };

    const schemaPath = join(this.root, "artifacts", `${id}-schema.json`);
    try {
      if (
        memory &&
        resumeThreadId &&
        memory.service.wasPrivateThread(memory.scope, resumeThreadId)
      ) {
        markPrivate();
      }

      cwd = viberWorkspace ? await this.git.assertOwnedTask(viberWorkspace) : options!.workspace!;

      const detection = await this.detect(provider, signal);

      if (signal.aborted) {
        throw new AdeError("cancelled", "Run cancelled");
      }

      officialCodex = detection.provider === "codex";
      usage.recordLimits(id, detection.subscriptionLimits);
      if (!detection.installed || !detection.capabilities.length) {
        throw new AdeError(
          "provider_unavailable",
          detection.error || `${provider.name} CLI is unavailable`,
        );
      }

      if (!detection.connected) {
        throw new AdeError(
          "authentication",
          `Connect ${provider.name} on the Providers page using the official CLI.`,
        );
      }

      if (
        options.viberSession &&
        ["codex", "antigravity"].includes(detection.provider) &&
        !detection.capabilities.includes("native-conversations")
      ) {
        throw new AdeError(
          "provider_unavailable",
          "Update the official provider CLI before using persistent native Viber conversations.",
        );
      }

      const invalid = configurationError(detection, config);
      if (invalid) {
        throw new AdeError("model", invalid);
      }

      const selectedConfig = {
        ...config,
        model: config.model || detection.models.find((m) => m.isDefault)?.id || "",
      };

      if (options.viberSession && !selectedConfig.model) {
        throw new AdeError(
          "model",
          "Choose a model before sending a message. The CLI did not report its default model.",
        );
      }

      const savedThread =
        options.viberSession && resumeThreadId
          ? new ViberSessionStore(this.db).assertThread(
              options.viberSession.sessionId,
              selectedConfig.provider,
              resumeThreadId,
            )
          : undefined;

      const antigravityConversation = conversation && detection.provider === "antigravity";
      const supportsAcp = detection.capabilities.includes("acp");
      if (savedThread?.protocol === "acp" && antigravityConversation && !supportsAcp) {
        throw new AdeError(
          "provider_unavailable",
          "The saved Antigravity thread requires an ACP-capable CLI.",
        );
      }

      const acpConversation =
        antigravityConversation &&
        supportsAcp &&
        (!resumeThreadId || savedThread?.protocol === "acp");

      if (selectedConfig.model && !config.model) {
        this.db.run(`UPDATE ${table} SET model=? WHERE id=?`, selectedConfig.model, id);
        this.db.run("UPDATE ai_usage SET model=? WHERE id=?", selectedConfig.model, id);
      }

      this.db.run(
        `UPDATE ${table} SET execution=? WHERE id=?`,
        JSON.stringify({
          configuration: selectedConfig,
          output_schema: schema,
          resumeThreadId,
        }),
        id,
      );

      await mkdir(dir, { recursive: true });

      const outputSchema = provider.outputSchema?.(schema) || schema;
      if (!conversation) {
        await writeFile(schemaPath, JSON.stringify(outputSchema, null, 2));
      }

      const contextPaths = options.contextPaths?.length ? options.contextPaths : undefined;

      const recordConversation = (conversationId: string, injectedThrough?: number) => {
        if (options.viberSession) {
          new ViberSessionStore(this.db).recordThread(
            options.viberSession.sessionId,
            options.viberSession.messageId,
            conversationId,
            selectedConfig.model,
            injectedThrough,
            antigravityConversation ? (acpConversation ? "acp" : "print") : undefined,
          );
        }

        nativeThreadId = conversationId;
        this.db.run("UPDATE ai_usage SET provider_session_id=? WHERE id=?", conversationId, id);
        this.db.run(`UPDATE ${table} SET conversation_id=? WHERE id=?`, conversationId, id);
      };

      let awaitingContext = false;

      const prepareInvocation = (
        text: string,
        thread: AgentRunRequest["conversation"],
        preload?: AgentRunRequest["preload"],
        historyRowid?: number,
      ) => {
        awaitingContext = !!preload?.context;
        unsavedShares = [];

        const directInvocation = provider.invocation({
          runId: id,
          cwd,
          stage: 0,
          access: execution.access,
          config: selectedConfig,
          prompt: options.sharedComputer
            ? `${text}

The user enabled Shared Computer for this turn. Its files are at ${sharedFilesMount}.${
                options.sharedComputer.socket
                  ? ` For HTTP services running in the computer, use curl --unix-socket ${sharedServicesMount} http://localhost:PORT/PATH.`
                  : " Shared files are read-only for this turn."
              }`
            : text,
          sharedComputer: Boolean(options.sharedComputer),
          schemaPath,
          schema: outputSchema,
          workspaceType: "utility",
          conversation: thread,
          signal: runSignal,
          viberMemory:
            memory && ["codex", "antigravity"].includes(detection.provider)
              ? {
                  recall: memory.recall
                    ? (threadId) => {
                        if (runSignal.aborted) {
                          return [];
                        }

                        try {
                          const facts = memory.recall?.(threadId) ?? [];
                          if (facts.length) {
                            markPrivate();
                            unsavedShares = facts;
                          }

                          return facts.map(({ text }) => text);
                        } catch {
                          return [];
                        }
                      }
                    : undefined,
                  onInputAccepted: (threadId) => {
                    memory.service.recordShares(memory.scope, threadId, unsavedShares);
                    unsavedShares = [];
                  },
                  suggest: detection.capabilities.includes("native-memory-suggestions")
                    ? memory.suggest
                    : undefined,
                  compact: (threadId) => memory.service.compact(memory.scope, threadId),
                }
              : undefined,
          preload: preload?.context
            ? {
                ...preload,
                onInjected: (threadId) => {
                  recordConversation(threadId, historyRowid);
                  awaitingContext = false;
                },
              }
            : preload,
        });

        return sandboxInvocation(
          this.root,
          this.db,
          assignment,
          directInvocation,
          execution.access === "read-only",
          conversation ? undefined : schemaPath,
          (detection.provider === "codex" && directInvocation.program === "codex") ||
            (detection.provider === "antigravity" && directInvocation.program === "agy")
            ? detection.provider
            : undefined,
          options.workspace,
          contextPaths,
          options.viberSession?.sessionId,
          options.sharedComputer,
        );
      };

      const confirmResume = options.originalPrompt !== undefined && resumeThreadId !== null;
      const deadline = Date.now() + config.timeout_secs * 1000;

      const invocation = await prepareInvocation(
        prompt,
        conversation
          ? {
              ...(resumeThreadId ? { threadId: resumeThreadId } : {}),
              ...(confirmResume ? { confirmResume: true } : {}),
              ...(acpConversation ? { protocol: "acp" as const } : {}),
            }
          : undefined,
        options.conversation?.instructions !== undefined
          ? {
              instructions: options.conversation.instructions,
              context: options.conversation.context,
            }
          : undefined,
      );

      stdout = await open(join(dir, `${id}.jsonl`), "a", 0o600);
      stderr = await open(join(dir, `${id}.stderr.log`), "a", 0o600);

      if (assignment && execution.access === "workspace-write") {
        await this.git.assertWritableWorkspaceEntries(assignment);
      }

      const before =
        assignment && execution.access === "read-only"
          ? await this.git.fingerprint(assignment)
          : null;

      this.emit({ event: "changed", session_id: options.viberSession?.sessionId });

      const processOptions: Omit<ProcessRequest, "program" | "args"> = {
        cwd,
        signal: runSignal,
        deadline,
        beforeSpawn: () => {
          if (options.viberSession) {
            new ViberSessionStore(this.db).markInvocation(options.viberSession.messageId);
          }

          invoked = true;
        },
        onSpawn: (pid, identity) => {
          this.db.run(`UPDATE ${table} SET pid=?,process_identity=? WHERE id=?`, pid, identity, id);
        },
        onLine: (stream, line) => {
          let raw: Record<string, unknown>;
          try {
            raw = object(JSON.parse(line));
          } catch {
            raw = { unparsed: line };
          }

          if (
            (officialCodex && codexMemoryEvent(raw)) ||
            (stream === "stdout" && provider.shouldObserveStdout?.(raw) === false)
          ) {
            return;
          }

          if (!privateContext) {
            writes.write(`${line}\n`, (value) =>
              (stream === "stdout" ? stdout : stderr)!.write(value),
            );
          }

          const conversationId = stream === "stdout" ? provider.conversationId(raw) : null;
          if (stream === "stdout") {
            usage.observe(id, raw);
            const session = object(object(raw.result).thread).id ? object(raw.result) : {};
            const reportedModel = object(raw.init).model || raw.model || session.model;
            if (typeof reportedModel === "string" && reportedModel) {
              this.db.run(`UPDATE ${table} SET model=? WHERE id=?`, reportedModel, id);
              this.db.run("UPDATE ai_usage SET model=? WHERE id=?", reportedModel, id);
            }

            if (raw.event === "init" || ["system", "thread.started"].includes(String(raw.type))) {
              const reportedEffort =
                object(raw.init).reasoning_effort ||
                object(raw.init).effort ||
                raw.reasoning_effort ||
                raw.effort;

              if (typeof reportedEffort === "string" && reportedEffort) {
                this.db.run(`UPDATE ${table} SET effort=? WHERE id=?`, reportedEffort, id);
                this.db.run("UPDATE ai_usage SET effort=? WHERE id=?", reportedEffort, id);
              }
            }
          }

          this.emit({
            event: "usage.changed",
            session_id: options.viberSession?.sessionId,
          });

          if (conversationId && !awaitingContext) {
            recordConversation(conversationId);
          }

          const result = stream === "stdout" ? provider.result(raw, conversation) : undefined;

          if (result !== undefined) {
            final = result;
          }

          for (const event of stream === "stderr"
            ? [{ kind: "command.output" as const, data: { stderr: line } }]
            : provider.normalize(raw)) {
            if (conversation && event.kind === "message") {
              const data = object(event.data);
              const key = String(data.call_id ?? "answer");

              const delta = typeof data.text_delta === "string" ? data.text_delta : "";
              if (acpConversation) {
                if (delta) {
                  const previous = assistantSegments.at(-1);
                  if (previous?.key === key) {
                    previous.text += delta;
                  } else {
                    assistantSegments.push({ key, text: delta });
                  }
                }
              } else {
                const text =
                  typeof data.text === "string"
                    ? data.text
                    : `${conversationMessages.get(key) || ""}${delta}`;

                conversationMessages.set(key, text);
              }
            }

            if (event.kind === "run.failed") {
              failure = event.data;
              const stopReason = object(event.data).stopReason;
              if (
                acpConversation &&
                typeof stopReason === "string" &&
                ["max_tokens", "max_turn_requests", "refusal"].includes(stopReason)
              ) {
                privateStopReason = stopReason;
              }
            }

            if (event.kind === "run.completed") {
              completedTurn = true;
            }

            if (!privateContext) {
              utilityEvent(event, line, stream);
            } else if (event.kind === "run.started" || event.kind === "run.completed") {
              utilityEvent({ kind: event.kind, data: null }, "", stream);
            }
          }
        },
      };

      const run = (next: typeof invocation) => execute({ ...processOptions, ...next });

      let output;
      try {
        output = await run(invocation);
      } catch (error) {
        if (
          !confirmResume ||
          !options.viberSession ||
          (antigravityConversation && !acpConversation) ||
          !(error instanceof AdeError) ||
          error.kind !== "thread_resume_rejected"
        ) {
          throw error;
        }

        runSignal.throwIfAborted();
        if (Date.now() >= deadline || nativeThreadId) {
          throw error;
        }

        const fresh = new ViberSessionStore(this.db).startFreshContinuation(
          options.viberSession.sessionId,
          options.viberSession.messageId,
        );

        const freshInvocation = await prepareInvocation(
          fresh.prompt,
          acpConversation ? { protocol: "acp" } : {},
          fresh.preload,
          fresh.historyRowid,
        );

        failure = undefined;
        privateStopReason = undefined;
        final = undefined;
        completedTurn = false;
        conversationMessages.clear();
        assistantSegments.length = 0;
        output = await run(freshInvocation);
      }

      await writes.drain();
      if (signal.aborted) {
        throw new AdeError("cancelled", "Run cancelled");
      }

      code = output.code;
      if (code !== 0 || failure) {
        throw new AdeError(
          "provider_failed",
          privateContext
            ? `${provider.name} failed to complete this turn (exit ${code}).`
            : `${provider.name} / ${purpose} exited ${code}: ${JSON.stringify(failure) || output.stderr.slice(-6000)}. Inspect technical details and logs, then retry after resolving the provider error.`,
          { provider: provider.name, stage: 0, code },
        );
      }

      if (options.viberSession && (!completedTurn || !nativeThreadId)) {
        throw new AdeError(
          "provider_failed",
          "Provider exited without a completed native turn and thread identity. Inspect activity before explicitly continuing; no automatic replay is allowed.",
        );
      }

      if (conversation && !resultSchema.safeParse(final).success) {
        // Preserve chunk order and separate distinct assistant segments with a blank line.
        const summary = acpConversation
          ? assistantSegments.map(({ text }) => text).join("\n\n")
          : [...conversationMessages.values()].reverse().find((text) => text.trim());

        if (summary?.trim()) {
          final = { summary };
        }
      }

      const value =
        !conversation && provider.parseStructuredOutput
          ? provider.parseStructuredOutput(schema, final)
          : final;

      const result = resultSchema.parse(value);

      if (
        assignment &&
        execution.access === "read-only" &&
        before !== (await this.git.fingerprint(assignment))
      ) {
        throw new AdeError(
          "planning_violation",
          "A read-only planning or review run modified the worktree. Review the changes before retrying.",
        );
      }

      if (signal.aborted) {
        throw new AdeError("cancelled", "Run cancelled");
      }

      await writes.drain();
      if (signal.aborted) {
        throw new AdeError("cancelled", "Run cancelled");
      }

      this.db.run(
        `UPDATE ${table} SET status='completed',ended_at=?,exit_code=?,output=? WHERE id=?`,
        now(),
        code,
        privateContext ? null : JSON.stringify(result),
        id,
      );

      usage.finish(id, started, "completed");
      return result;
    } catch (error) {
      this.detections.delete(provider.name);

      const e = privateContext
        ? new AdeError(
            error instanceof AdeError ? error.kind : "provider_failed",
            signal.aborted
              ? "Run cancelled"
              : privateStopReason
                ? `Antigravity stopped the turn (${privateStopReason}).`
                : "The provider did not complete the Viber turn.",
          )
        : outputFailure || error;

      utilityEvent({
        kind: signal.aborted ? "run.cancelled" : "run.failed",
        data: { message: redact(String(e)) },
      });

      const status = signal.aborted ? "cancelled" : "failed";
      usage.finish(id, started, status, redact(e instanceof Error ? e.message : String(e)));

      this.db.run(
        `UPDATE ${table} SET status=?,ended_at=?,exit_code=?,output=?,error=? WHERE id=?`,
        status,
        now(),
        code,
        privateContext || final === undefined ? null : JSON.stringify(final),
        redact(String(e)),
        id,
      );

      throw e;
    } finally {
      try {
        await writes.drain().catch(() => {});
      } finally {
        await stdout?.close();
        await stderr?.close();
        if (!conversation) {
          await unlink(schemaPath).catch(() => {});
        }

        if (invoked && officialCodex && !signal.aborted && !conversation) {
          const after = await discoverCodexModels(
            this.root,
            AbortSignal.any([signal, AbortSignal.timeout(5000)]),
          ).catch(() => null);

          usage.recordLimits(id, after?.subscriptionLimits, true);
        }

        this.emit({
          event: "usage.changed",
          session_id: options.viberSession?.sessionId,
        });
      }
    }
  };
}
