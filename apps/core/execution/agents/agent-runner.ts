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
import { execute, redact } from "../runtime/process";
import { BoundedWriter } from "../output/bounded-output";
import { AgentExecutionSchema, type AgentExecution } from "../contracts";
import { executionSchema } from "./execution-output";
import { ViberSessionStore } from "../../vibers/store";
import {
  object,
  type AgentProvider,
  configurationError,
  type ProviderDetection,
} from "../providers/contracts";

interface AgentRunOptions {
  prompt: string;
  purpose: string;
  workspace?: string;
  schema?: z.ZodType;
  contextPaths?: string[];
  conversation?: { threadId?: string };
  viberSession?: { sessionId: string; messageId: string };
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
      JSON.stringify({ configuration: execution, output_schema: schema }),
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
    let failure: unknown;
    let code: number | null = null;
    let invoked = false;
    let officialCodex = false;
    let completedTurn = false;
    let nativeThreadId: string | null = null;
    const schemaPath = join(this.root, "artifacts", `${id}-schema.json`);
    try {
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

      if (options.viberSession && options.conversation?.threadId) {
        new ViberSessionStore(this.db).assertThread(
          options.viberSession.sessionId,
          options.conversation.threadId,
          selectedConfig.model,
        );
      }

      if (selectedConfig.model && !config.model) {
        this.db.run(`UPDATE ${table} SET model=? WHERE id=?`, selectedConfig.model, id);
        this.db.run("UPDATE ai_usage SET model=? WHERE id=?", selectedConfig.model, id);
      }

      this.db.run(
        `UPDATE ${table} SET execution=? WHERE id=?`,
        JSON.stringify({
          configuration: selectedConfig,
          output_schema: schema,
        }),
        id,
      );

      await mkdir(dir, { recursive: true });

      const outputSchema = provider.outputSchema?.(schema) || schema;
      if (!conversation) {
        await writeFile(schemaPath, JSON.stringify(outputSchema, null, 2));
      }

      const contextPaths = options.contextPaths?.length ? options.contextPaths : undefined;

      const directInvocation = provider.invocation({
        runId: id,
        cwd,
        stage: 0,
        access: execution.access,
        config: selectedConfig,
        prompt,
        schemaPath,
        schema: outputSchema,
        workspaceType: "utility",
        ...(conversation ? { conversation: options.conversation || {} } : {}),
      });

      const invocation = await sandboxInvocation(
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
      signal.throwIfAborted();
      if (options.viberSession) {
        new ViberSessionStore(this.db).markInvocation(options.viberSession.messageId);
      }

      invoked = true;

      const output = await execute({
        ...invocation,
        cwd,
        signal: runSignal,
        timeoutMs: config.timeout_secs * 1000,
        onSpawn: (pid, identity) => {
          this.db.run(`UPDATE ${table} SET pid=?,process_identity=? WHERE id=?`, pid, identity, id);
        },
        onLine: (stream, line) => {
          writes.write(`${line}\n`, (value) =>
            (stream === "stdout" ? stdout : stderr)!.write(value),
          );

          let raw: Record<string, unknown>;
          try {
            raw = object(JSON.parse(line));
          } catch {
            raw = { unparsed: line };
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

          if (conversationId) {
            if (options.viberSession) {
              new ViberSessionStore(this.db).recordThread(
                options.viberSession.sessionId,
                options.viberSession.messageId,
                conversationId,
                selectedConfig.model,
              );
            }

            nativeThreadId = conversationId;
            this.db.run("UPDATE ai_usage SET provider_session_id=? WHERE id=?", conversationId, id);
            this.db.run(`UPDATE ${table} SET conversation_id=? WHERE id=?`, conversationId, id);
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

              const text =
                typeof data.text === "string"
                  ? data.text
                  : `${conversationMessages.get(key) || ""}${typeof data.text_delta === "string" ? data.text_delta : ""}`;

              conversationMessages.set(key, text);
            }

            if (event.kind === "run.failed") {
              failure = event.data;
            }

            if (event.kind === "run.completed") {
              completedTurn = true;
            }

            utilityEvent(event, line, stream);
          }
        },
      });

      await writes.drain();
      if (signal.aborted) {
        throw new AdeError("cancelled", "Run cancelled");
      }

      code = output.code;
      if (code !== 0 || failure) {
        throw new AdeError(
          "provider_failed",
          `${provider.name} / ${purpose} exited ${code}: ${JSON.stringify(failure) || output.stderr.slice(-6000)}. Inspect technical details and logs, then retry after resolving the provider error.`,
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
        const summary = [...conversationMessages.values()].reverse().find((text) => text.trim());

        if (summary) {
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
        JSON.stringify(result),
        id,
      );

      usage.finish(id, started, "completed");
      return result;
    } catch (error) {
      this.detections.delete(provider.name);

      utilityEvent({
        kind: signal.aborted ? "run.cancelled" : "run.failed",
        data: { message: redact(String(error)) },
      });

      const e = outputFailure || error;
      const status = signal.aborted ? "cancelled" : "failed";
      usage.finish(id, started, status, redact(e instanceof Error ? e.message : String(e)));

      this.db.run(
        `UPDATE ${table} SET status=?,ended_at=?,exit_code=?,output=?,error=? WHERE id=?`,
        status,
        now(),
        code,
        final === undefined ? null : JSON.stringify(final),
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
