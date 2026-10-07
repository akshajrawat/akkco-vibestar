import { z } from "zod";
import { ActionSchema } from "../scheduled/action";
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
    options?: { prompt: string; purpose: string; workspace?: string },
  ) => {
    const task = "repo_id" in t ? t : null;
    if (!task && (!options?.workspace || options.purpose !== "scheduled"))
      throw new AdeError(
        "invalid_state",
        "Detached analysis requires a managed PR workspace",
      );
    const cwd = task ? await this.git.assertTask(task) : options!.workspace!;
    const table = task ? "agent_runs" : "scheduled_agent_runs";
    const followup = t.stage === 3 ? task?.followup_config : undefined;
    const provider = this.providers(t.stage, followup?.provider);
    const config =
      followup?.config ??
      (t.stage === 1
        ? settings.antigravity
        : t.stage === 2
          ? settings.codex_plan
          : settings.codex_implementation);
    const detection = await provider.detect(this.root, signal);
    if (!detection.installed || !detection.capabilities.length)
      throw new AdeError(
        "provider_unavailable",
        `${provider.name}: ${detection.error || "Official CLI not available"}`,
      );
    if (
      provider.name === "codex" &&
      !detection.authentication.includes("ChatGPT subscription")
    )
      throw new AdeError(
        "authentication",
        "Codex requires ChatGPT subscription login. Connect Codex on the Providers page.",
      );
    if (
      provider.name === "antigravity" &&
      config.model &&
      !detection.models.includes(config.model)
    )
      throw new AdeError(
        "model",
        `Antigravity model '${config.model}' is not listed by agy models. Refresh model discovery.`,
      );
    const id = randomUUID();
    const prompt = options?.prompt ?? buildPrompt(this.db, task!);
    const dir = join(this.root, "logs", task ? t.id : `pr-watch-${t.id}`);
    await mkdir(dir, { recursive: true });
    const schemaPath = join(this.root, "artifacts", `${id}-schema.json`);
    const schema =
      options?.purpose === "scheduled"
        ? z.toJSONSchema(ActionSchema)
        : schemaFor(t.stage);
    await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600 });
    const directInvocation = provider.invocation({
      runId: id,
      cwd,
      stage: t.stage,
      config,
      prompt,
      schemaPath,
      schema,
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
    this.db.run(
      `INSERT INTO ${table}(id,${task ? "task_id" : "job_id"},stage,provider,model,effort,prompt,status,started_at) VALUES(?,?,?,?,?,?,?,'running',?)`,
      id,
      t.id,
      t.stage,
      provider.name,
      config.model,
      config.effort,
      redact(prompt),
      now(),
    );
    if (options)
      this.db.run(
        `UPDATE ${table} SET purpose=? WHERE id=?`,
        options.purpose,
        id,
      );
    const stdout = await open(join(dir, `${id}.jsonl`), "a", 0o600);
    const stderr = await open(join(dir, `${id}.stderr.log`), "a", 0o600);
    const before = task ? await this.git.fingerprint(task) : null;
    let writes = Promise.resolve();
    let final: unknown;
    let failure: unknown;
    let code: number | null = null;
    this.emit({ event: "changed", task_id: task?.id });
    try {
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
            await (stream === "stdout" ? stdout : stderr).write(`${line}\n`);
          });
          let raw: Record<string, unknown>;
          try {
            raw = object(JSON.parse(line));
          } catch {
            raw = { unparsed: line };
          }
          const conversationId = provider.conversationId(raw);
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
          `${provider.name} / ${stageStatus(t.stage)} exited ${code}: ${JSON.stringify(failure) || output.stderr.slice(-6000)}. Check subscription quota, authentication and requested model/effort. Retry this stage after resolving the provider error.`,
          { provider: provider.name, stage: t.stage, code },
        );
      const result =
        options?.purpose === "scheduled"
          ? ActionSchema.parse(final)
          : validatePlan(t.stage, final);
      if (task && t.stage < 3 && before !== (await this.git.fingerprint(task)))
        throw new AdeError(
          "planning_violation",
          "Planning modified the worktree. Pipeline stopped. Review and discard changes before retrying.",
        );
      if (t.stage === 3) {
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
        await stdout.close();
        await stderr.close();
        await unlink(schemaPath).catch(() => {});
      }
    }
  };
}
