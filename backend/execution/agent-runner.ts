import { z } from "zod";
import { ActionSchema } from "../scheduled/action";
import { Usage } from "./usage";
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
} from "../domain";
import type { Database } from "../storage/database";
import type { GitWorkspace } from "../workspace/git";
import { execute, redact } from "./process";
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
    t: Task | { id: string; stage: 1 | 2 },
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
      telemetryTaskId?: string;
      telemetryRepository?: string;
    },
  ) => {
    const task = "repo_id" in t ? t : null;
    if (!task && !options?.workspace)
      throw new AdeError(
        "invalid_state",
        "Detached analysis requires a managed PR workspace",
      );
    const table = task
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
      options?.provider || followup?.provider,
    );
    const config =
      options?.config ??
      followup?.config ??
      (t.stage === 1
        ? settings.antigravity
        : t.stage === 2
          ? settings.codex_plan
          : settings.codex_implementation);
    const id = randomUUID();
    const started = Date.now();
    const prompt = options?.prompt ?? buildPrompt(this.db, task!);
    const usage = new Usage(this.db);
    const repo = task
      ? this.db.repository(task.repo_id)
      : options?.telemetryTaskId
        ? this.db.repository(this.db.task(options.telemetryTaskId).repo_id)
        : null;
    const purpose =
      options?.purpose ||
      (task?.continuation === "implementation"
        ? "Chat Follow-up"
        : [
            "",
            "Antigravity Plan",
            "Codex Plan Refinement",
            "Codex Implementation",
          ][t.stage]);
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
    const parent = task
      ? "task_id"
      : table === "scheduled_agent_runs"
        ? "job_id"
        : null;
    this.db.run(
      `INSERT INTO ${table}(id,${parent ? `${parent},` : ""}stage,provider,model,effort,prompt,status,started_at,purpose) VALUES(?${parent ? ",?" : ""},?,?,?,?,?,'running',?,?)`,
      id,
      ...(parent ? [task?.id || options?.jobId || t.id] : []),
      t.stage,
      provider.name,
      config.model,
      config.effort,
      redact(prompt),
      now(),
      purpose,
    );
    if (task && !options)
      this.db.run(
        "UPDATE task_messages SET run_id=? WHERE task_id=? AND status='delivered' AND run_id IS NULL",
        id,
        task.id,
      );
    const dir = join(this.root, "logs", task ? t.id : `pr-watch-${t.id}`);
    let cwd = "";
    let stdout: Awaited<ReturnType<typeof open>> | undefined;
    let stderr: Awaited<ReturnType<typeof open>> | undefined;
    let writes = Promise.resolve();
    let final: unknown;
    let failure: unknown;
    let code: number | null = null;
    const schemaPath = join(this.root, "artifacts", `${id}-schema.json`);
    try {
      cwd = task ? await this.git.assertTask(task) : options!.workspace!;
      const detection = await provider.detect(this.root, signal);
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
        workspaceType: options ? "utility" : "task",
      });
      const invocation = await sandboxInvocation(
        this.root,
        this.db,
        task,
        directInvocation,
        t.stage < 3,
        schemaPath,
        provider.name === "antigravity" ? "antigravity" : "codex",
        options?.workspace,
      );
      stdout = await open(join(dir, `${id}.jsonl`), "a", 0o600);
      stderr = await open(join(dir, `${id}.stderr.log`), "a", 0o600);
      const before = task ? await this.git.fingerprint(task) : null;
      this.emit({ event: "changed", task_id: task?.id });
      const output = await execute({
        ...invocation,
        cwd,
        signal,
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
          writes = writes.then(async () => {
            await (stream === "stdout" ? stdout : stderr)!.write(`${line}\n`);
          });
          let raw: Record<string, unknown>;
          try {
            raw = object(JSON.parse(line));
          } catch {
            raw = { unparsed: line };
          }
          const conversationId = provider.conversationId(raw);
          if (stream === "stdout") usage.observe(id, raw);
          if (conversationId)
            this.db.run(
              `UPDATE ${table} SET conversation_id=? WHERE id=?`,
              conversationId,
              id,
            );
          const result = provider.result(raw);
          if (result !== undefined) final = result;
          for (const event of stream === "stderr"
            ? [{ kind: "command.output" as const, data: { stderr: line } }]
            : provider.normalize(raw)) {
            if (event.kind === "run.failed") failure = event.data;
            if (!task) continue;
            this.db.run(
              "INSERT INTO agent_events(run_id,task_id,timestamp,kind,data,raw,stream) VALUES(?,?,?,?,?,?,?)",
              id,
              t.id,
              now(),
              event.kind,
              JSON.stringify(event.data),
              line,
              stream,
            );
            this.emit({
              event: "agent.event",
              task_id: t.id,
              run_id: id,
              ...event,
            });
          }
        },
      });
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
      if (task && t.stage < 3 && before !== (await this.git.fingerprint(task)))
        throw new AdeError(
          "planning_violation",
          "Planning modified the worktree. Pipeline stopped. Review and discard changes before retrying.",
        );
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
      await writes;
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
    } catch (e) {
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
        run_id: id,
        kind: signal.aborted ? "run.cancelled" : "run.failed",
        data: { message: String(e) },
      });
      throw e;
    } finally {
      try {
        await writes;
      } finally {
        await stdout?.close();
        await stderr?.close();
        await unlink(schemaPath).catch(() => {});
      }
    }
  };
}
