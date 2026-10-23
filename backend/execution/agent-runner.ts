import { z } from "zod";
import { StreamedPlan } from "./streamed-plan";
import { CommandExecutions } from "./command-executions";
import { ActionSchema } from "../scheduled/action";
import { Usage } from "./usage";
import { discoverCodexModels } from "./providers/codex-models";
import { sandboxInvocation } from "./sandbox";
import { mkdir, open, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  AdeError,
  now,
  stageStatus,
  type Task,
  type Settings,
  type CoreEvent,
  type StageConfig,
  type WorkspaceAssignment,
  type NormalizedEvent,
} from "../domain";
import type { Database } from "../storage/database";
import type { GitWorkspace } from "../workspace/git";
import { execute, redact } from "./process";
import { BoundedWriter } from "./bounded-output";
import { buildPrompt } from "./prompt";
import {
  schemaFor,
  validatePlan,
  object,
  type AgentProvider,
  configurationError,
} from "./providers/contracts";
export class AgentRunner {
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
  run = async (
    t: Task | { id: string; stage: 1 | 2 | 3 | 5 },
    settings: Settings,
    signal: AbortSignal,
    options?: {
      prompt: string;
      purpose: string;
      workspace?: string;
      provider?: "codex" | "antigravity";
      config?: StageConfig;
      schema?: z.ZodType;
      jobId?: string;
      analysisId?: string;
      watchId?: string;
      scanId?: string;
      telemetryTaskId?: string;
      telemetryRepository?: string;
      questionId?: string;
      repair?: WorkspaceAssignment;
      contextPaths?: string[];
    },
  ) => {
    const task = "repo_id" in t ? t : null;
    const repair = options?.repair;
    const assignment = task || repair || null;
    const fingerprint = repair
      ? this.git.repairFingerprint
      : this.git.fingerprint;
    if (!assignment && !options?.workspace)
      throw new AdeError(
        "invalid_state",
        "Detached analysis requires a managed PR workspace",
      );
    const table = assignment
      ? "agent_runs"
      : options?.jobId || options?.purpose === "scheduled"
        ? "scheduled_agent_runs"
        : "utility_runs";
    const followup =
      t.stage === 3 && task?.continuation === "implementation"
        ? task.followup_config
        : undefined;
    const provider = this.providers(
      t.stage,
      options?.provider ||
        followup?.provider ||
        (t.stage === 5 ? "antigravity" : undefined),
    );
    const config =
      options?.config ??
      followup?.config ??
      task?.stage_settings?.[t.stage as 1 | 2 | 3 | 5] ??
      (t.stage === 1 || t.stage === 5
        ? settings.antigravity
        : t.stage === 2
          ? settings.codex_plan
          : settings.codex_implementation);
    const id = randomUUID();
    if (options?.scanId || options?.watchId) {
      if (
        table !== "utility_runs" ||
        !options.scanId ||
        !options.watchId ||
        !this.db.all(
          "SELECT id FROM issue_watch_scans WHERE id=? AND watch_id=? AND status='running' AND semantic_attempts=1 AND utility_run_id IS NULL",
          options.scanId,
          options.watchId,
        ).length
      )
        throw new AdeError(
          "isolation",
          "Issue Watch utility execution needs its one reserved, unconsumed scan invocation slot.",
        );
    }
    const started = Date.now();
    const prompt = options?.prompt ?? buildPrompt(this.db, task!);
    const usage = new Usage(this.db);
    const repo = assignment
      ? this.db.repository(assignment.repo_id)
      : options?.telemetryTaskId
        ? this.db.repository(this.db.task(options.telemetryTaskId).repo_id)
        : null;
    const purpose =
      options?.purpose ||
      (t.stage === 3 && task?.continuation === "implementation"
        ? "Chat Follow-up"
        : [
            "",
            "Antigravity Plan",
            "Codex Plan Refinement",
            "Codex Implementation",
          ][t.stage] ||
          (t.stage === 5 ? "Antigravity Final Review" : "Pipeline"));
    usage.start(id, {
      task_id: task?.id || options?.telemetryTaskId || null,
      job_id:
        options?.jobId ||
        (!task && options?.purpose === "scheduled" ? t.id : null),
      repository: repo
        ? `${repo.owner}/${repo.name}`
        : options?.telemetryRepository || null,
      purpose,
      provider: provider.name,
      model: config.model,
      effort: config.effort,
    });
    if (repair)
      this.db.run("UPDATE ai_usage SET repair_id=? WHERE id=?", repair.id, id);
    this.emit({
      event: "usage.changed",
      task_id: task?.id || options?.telemetryTaskId,
      repair_id: repair?.id,
    });
    const parent = repair
      ? "repair_id"
      : task
        ? "task_id"
        : table === "scheduled_agent_runs"
          ? "job_id"
          : null;
    this.db.run(
      `INSERT INTO ${table}(id,${parent ? `${parent},` : ""}stage,provider,model,effort,prompt,status,started_at,purpose) VALUES(?${parent ? ",?" : ""},?,?,?,?,?,'running',?,?)`,
      id,
      ...(parent ? [assignment?.id || options?.jobId || t.id] : []),
      t.stage,
      provider.name,
      config.model,
      config.effort,
      redact(prompt),
      now(),
      purpose,
    );
    if (options?.scanId)
      this.db.transaction(() => {
        this.db.run(
          "UPDATE utility_runs SET watch_id=?,scan_id=? WHERE id=?",
          options.watchId!,
          options.scanId!,
          id,
        );
        this.db.run(
          "UPDATE ai_usage SET watch_id=?,scan_id=? WHERE id=?",
          options.watchId!,
          options.scanId!,
          id,
        );
        this.db.run(
          "UPDATE issue_watch_scans SET utility_run_id=?,data=json_set(data,'$.utility_run_id',?) WHERE id=? AND watch_id=?",
          id,
          id,
          options.scanId!,
          options.watchId!,
        );
      });
    const utilityEvent = (
      event: NormalizedEvent,
      raw = "",
      stream = "stdout",
    ) => {
      if (!options?.scanId) return;
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
        watch_id: options.watchId,
        scan_id: options.scanId,
        run_id: id,
        ...event,
      });
    };
    if (options?.analysisId && table === "scheduled_agent_runs") {
      this.db.run(
        "UPDATE scheduled_agent_runs SET analysis_id=? WHERE id=?",
        options.analysisId,
        id,
      );
      this.db.run(
        "UPDATE ai_usage SET analysis_id=? WHERE id=?",
        options.analysisId,
        id,
      );
    }
    if (task && options?.questionId) {
      this.db.run(
        "UPDATE code_questions SET run_id=? WHERE id=? AND task_id=?",
        id,
        options.questionId,
        task.id,
      );
      this.db.run(
        "UPDATE task_messages SET run_id=? WHERE id=? AND task_id=?",
        id,
        options.questionId,
        task.id,
      );
    }
    if (task && !options)
      this.db.run(
        "UPDATE task_messages SET run_id=? WHERE task_id=? AND status='delivered' AND run_id IS NULL",
        id,
        task.id,
      );
    const dir = join(
      this.root,
      "logs",
      assignment
        ? t.id
        : options?.scanId
          ? `issue-watch-${options.scanId}`
          : `pr-watch-${t.id}`,
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
    const draft = new StreamedPlan(t.stage);
    const commands = new CommandExecutions(this.db);
    let savedDraft = "";
    const draftId = randomUUID();
    let final: unknown;
    let failure: unknown;
    let code: number | null = null;
    let invoked = false;
    let officialCodex = false;
    const schemaPath = join(this.root, "artifacts", `${id}-schema.json`);
    try {
      cwd = assignment
        ? await this.git.assertTask(assignment)
        : options!.workspace!;
      const detection = await provider.detect(this.root, signal);
      if (signal.aborted) throw new AdeError("cancelled", "Run cancelled");
      officialCodex = detection.provider === "codex";
      usage.recordLimits(id, detection.subscriptionLimits);
      if (!detection.installed || !detection.capabilities.length)
        throw new AdeError(
          "provider_unavailable",
          detection.error || `${provider.name} CLI is unavailable`,
        );
      if (!detection.connected)
        throw new AdeError(
          "authentication",
          `Connect ${provider.name} on the Providers page using the official CLI.`,
        );
      const invalid = configurationError(detection, config);
      if (invalid) throw new AdeError("model", invalid);
      const selectedConfig = {
        ...config,
        model:
          config.model || detection.models.find((m) => m.isDefault)?.id || "",
      };
      if (selectedConfig.model && !config.model) {
        this.db.run(
          `UPDATE ${table} SET model=? WHERE id=?`,
          selectedConfig.model,
          id,
        );
        this.db.run(
          "UPDATE ai_usage SET model=? WHERE id=?",
          selectedConfig.model,
          id,
        );
      }
      await mkdir(dir, { recursive: true });
      const schema = options?.schema
        ? z.toJSONSchema(options.schema)
        : options?.purpose === "scheduled"
          ? z.toJSONSchema(ActionSchema)
          : schemaFor(t.stage);
      const outputSchema = provider.outputSchema?.(schema) || schema;
      await writeFile(schemaPath, JSON.stringify(outputSchema), {
        mode: 0o600,
      });
      const directInvocation = provider.invocation({
        runId: id,
        cwd,
        stage: t.stage,
        config: selectedConfig,
        prompt,
        schemaPath,
        schema: outputSchema,
        workspaceType: repair ? "task" : options ? "utility" : "task",
      });
      const invocation = await sandboxInvocation(
        this.root,
        this.db,
        assignment,
        directInvocation,
        t.stage !== 3,
        schemaPath,
        (detection.provider === "codex" &&
          directInvocation.program === "codex") ||
          (detection.provider === "antigravity" &&
            directInvocation.program === "agy")
          ? detection.provider
          : undefined,
        options?.workspace,
        options?.contextPaths,
      );
      stdout = await open(join(dir, `${id}.jsonl`), "a", 0o600);
      stderr = await open(join(dir, `${id}.stderr.log`), "a", 0o600);
      const before = assignment ? await fingerprint(assignment) : null;
      this.emit({ event: "changed", task_id: task?.id, repair_id: repair?.id });
      invoked = true;
      const output = await execute({
        ...invocation,
        cwd,
        signal: runSignal,
        timeoutMs: config.timeout_secs * 1000,
        onSpawn: (pid, identity) => {
          this.db.run(
            `UPDATE ${table} SET pid=?,process_identity=? WHERE id=?`,
            pid,
            identity,
            id,
          );
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
          const conversationId =
            stream === "stdout" ? provider.conversationId(raw) : null;
          if (stream === "stdout") {
            usage.observe(id, raw);
            const reportedModel = object(raw.init).model || raw.model;
            if (typeof reportedModel === "string" && reportedModel) {
              this.db.run(
                `UPDATE ${table} SET model=? WHERE id=?`,
                reportedModel,
                id,
              );
              this.db.run(
                "UPDATE ai_usage SET model=? WHERE id=?",
                reportedModel,
                id,
              );
            }
            if (
              raw.event === "init" ||
              ["system", "thread.started"].includes(String(raw.type))
            ) {
              const reportedEffort =
                object(raw.init).reasoning_effort ||
                object(raw.init).effort ||
                raw.reasoning_effort ||
                raw.effort;
              if (typeof reportedEffort === "string" && reportedEffort) {
                this.db.run(
                  `UPDATE ${table} SET effort=? WHERE id=?`,
                  reportedEffort,
                  id,
                );
                this.db.run(
                  "UPDATE ai_usage SET effort=? WHERE id=?",
                  reportedEffort,
                  id,
                );
              }
            }
          }
          this.emit({
            event: "usage.changed",
            task_id: task?.id || options?.telemetryTaskId,
            repair_id: repair?.id,
          });
          if (conversationId) {
            this.db.run(
              "UPDATE ai_usage SET provider_session_id=? WHERE id=?",
              conversationId,
              id,
            );
            this.db.run(
              `UPDATE ${table} SET conversation_id=? WHERE id=?`,
              conversationId,
              id,
            );
          }
          const result = stream === "stdout" ? provider.result(raw) : undefined;
          if (result !== undefined) final = result;
          for (const event of stream === "stderr"
            ? [{ kind: "command.output" as const, data: { stderr: line } }]
            : provider.normalize(raw)) {
            if (event.kind === "run.failed") failure = event.data;
            if (
              task &&
              !options &&
              [1, 2].includes(t.stage) &&
              event.kind === "message"
            ) {
              const plan = draft.observe(event.data);
              if (plan && JSON.stringify(plan) !== savedDraft) {
                savedDraft = JSON.stringify(plan);
                this.db.run(
                  "INSERT INTO task_artifacts VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,created_at=excluded.created_at",
                  draftId,
                  t.id,
                  t.stage,
                  `draft:${id}`,
                  JSON.stringify({ plan, source_hash: before }),
                  now(),
                );
              }
            }
            if (!assignment) {
              utilityEvent(event, line, stream);
              continue;
            }
            commands.observe(
              task?.id || null,
              id,
              event,
              now(),
              repair?.id || null,
            );
            this.db.run(
              "INSERT INTO agent_events(run_id,task_id,timestamp,kind,data,raw,stream,repair_id) VALUES(?,?,?,?,?,?,?,?)",
              id,
              task?.id || null,
              now(),
              event.kind,
              JSON.stringify(event.data),
              line,
              stream,
              repair?.id || null,
            );
            this.emit({
              event: "agent.event",
              task_id: task?.id,
              repair_id: repair?.id,
              run_id: id,
              ...event,
            });
          }
        },
      });
      await writes.drain();
      if (signal.aborted) throw new AdeError("cancelled", "Run cancelled");
      code = output.code;
      if (code !== 0 || failure)
        throw new AdeError(
          "provider_failed",
          `${provider.name} / ${options?.purpose || stageStatus(t.stage)} exited ${code}: ${JSON.stringify(failure) || output.stderr.slice(-6000)}. Inspect technical details and logs, then retry after resolving the provider error.`,
          { provider: provider.name, stage: t.stage, code },
        );
      const value = provider.parseStructuredOutput
        ? provider.parseStructuredOutput(schema, final)
        : final;
      const result = options?.schema
        ? options.schema.parse(value)
        : options?.purpose === "scheduled"
          ? ActionSchema.parse(value)
          : validatePlan(t.stage, value);
      if (
        assignment &&
        t.stage !== 3 &&
        before !== (await fingerprint(assignment))
      )
        throw new AdeError(
          "planning_violation",
          "A read-only planning or review run modified the worktree. Pipeline stopped. Review the changes before retrying.",
        );
      if (signal.aborted) throw new AdeError("cancelled", "Run cancelled");
      if (task && t.stage === 3) {
        const implementation = object(result);
        for (const [field, status] of [
          ["testsPassed", "passed"],
          ["testsFailed", "failed"],
          ["testsSkipped", "skipped"],
        ]) {
          const tests = implementation[field];
          for (const text of Array.isArray(tests) ? tests : []) {
            const data = { status, text, source: "provider-reported" };
            this.db.run(
              "INSERT INTO agent_events(run_id,task_id,timestamp,kind,data,raw,stream) VALUES(?,?,?,'test.result',?,?, 'stdout')",
              id,
              t.id,
              now(),
              JSON.stringify(data),
              JSON.stringify({ event: "vibestar.test.result", data }),
            );
            this.emit({
              event: "agent.event",
              task_id: t.id,
              run_id: id,
              kind: "test.result",
              data,
            });
          }
        }
      }
      await writes.drain();
      if (signal.aborted) throw new AdeError("cancelled", "Run cancelled");
      this.db.run(
        `UPDATE ${table} SET status='completed',ended_at=?,exit_code=?,output=? WHERE id=?`,
        now(),
        code,
        JSON.stringify(result),
        id,
      );
      usage.finish(id, started, "completed");
      if (!options)
        this.db.run(
          "INSERT INTO task_artifacts VALUES(?,?,?,'plan',?,?)",
          randomUUID(),
          t.id,
          t.stage,
          JSON.stringify(result),
          now(),
        );
      return result;
    } catch (error) {
      utilityEvent({
        kind: signal.aborted ? "run.cancelled" : "run.failed",
        data: { message: redact(String(error)) },
      });
      const e = outputFailure || error;
      const status = signal.aborted ? "cancelled" : "failed";
      usage.finish(
        id,
        started,
        status,
        redact(e instanceof Error ? e.message : String(e)),
      );
      this.db.run(
        `UPDATE ${table} SET status=?,ended_at=?,exit_code=?,output=?,error=? WHERE id=?`,
        status,
        now(),
        code,
        final === undefined ? null : JSON.stringify(final),
        redact(String(e)),
        id,
      );
      this.emit({
        event: "agent.event",
        task_id: task?.id,
        repair_id: repair?.id,
        run_id: id,
        kind: signal.aborted ? "run.cancelled" : "run.failed",
        data: { message: String(e) },
      });
      throw e;
    } finally {
      commands.finish(id);
      try {
        await writes.drain().catch(() => {});
      } finally {
        await stdout?.close();
        await stderr?.close();
        await unlink(schemaPath).catch(() => {});
        // Discovery reads official allowance only; it never starts a model turn.
        if (invoked && officialCodex && !signal.aborted) {
          const after = await discoverCodexModels(
            this.root,
            AbortSignal.any([signal, AbortSignal.timeout(5000)]),
          ).catch(() => null);
          usage.recordLimits(id, after?.subscriptionLimits, true);
        }
        this.emit({
          event: "usage.changed",
          task_id: task?.id || options?.telemetryTaskId,
          repair_id: repair?.id,
        });
      }
    }
  };
}
