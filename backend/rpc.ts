import { join } from "node:path";
import { Editors } from "./workspace/editors";
import { GitHubService } from "./github/service";
import { GitHubClient } from "./github/client";
import { IssueWatchService } from "./issue-watch/service";
import { fetchIssue } from "./workspace/issue";
import { FollowupConfigSchema, StageConfigSchema } from "./domain";
import { StorageService } from "./storage/service";
import { Usage } from "./execution/usage";
import { TaskTerminals } from "./execution/task-terminals";
import { readLogTail } from "./storage/logs";
import { ReviewService } from "./review/service";
import { RepairService } from "./review/repair/service";
import { Scheduler } from "./scheduled/scheduler";
import { GitHubMonitor } from "./scheduled/github";
import { z } from "zod";
import { taskVerification } from "./execution/task-verification";
import { realpath, open } from "node:fs/promises";
import { Engine } from "./execution/engine";
import { AuthSessions } from "./execution/auth";
import { AdeError, SettingsSchema, parseIssue, now } from "./domain";
import { capture, checked } from "./execution/process";
import { taskRoot } from "./workspace/paths";
import { LocalRepositoryInput, ConnectLocalInput } from "./workspace/discovery";
const idInput = z.object({ id: z.string().uuid() });
export class Rpc {
  private readonly auth: AuthSessions;
  readonly scheduler: Scheduler;
  readonly github: GitHubService;
  readonly issueWatch: IssueWatchService;
  private readonly review: ReviewService;
  readonly repairs: RepairService;
  private readonly terminals: TaskTerminals;
  private readonly repairTerminals: TaskTerminals;
  private readonly storage: StorageService;
  constructor(
    readonly engine: Engine,
    monitor = new GitHubMonitor(engine.root),
    repairs = new RepairService(engine),
    issueWatch?: IssueWatchService,
  ) {
    this.scheduler = new Scheduler(engine, monitor);
    this.github = new GitHubService(engine, this.scheduler);
    this.issueWatch =
      issueWatch || new IssueWatchService(engine, this.github.client);
    this.review = new ReviewService(engine);
    this.repairs = repairs;
    this.terminals = new TaskTerminals(engine);
    this.repairTerminals = new TaskTerminals(engine, {
      assignment: this.repairs.assignment,
      acquire: this.repairs.acquireTerminal,
    });
    this.storage = new StorageService(engine);
    this.auth = new AuthSessions(engine.root, (event) => {
      engine.publish(event);
    });
  }
  call = async (method: string, input: unknown) => {
    const e = this.engine;
    if (method.startsWith("issueWatch."))
      return this.issueWatch.call(method.slice("issueWatch.".length), input);
    switch (method) {
      case "editors.list":
        return new Editors(e).list();
      case "editors.open": {
        const p = idInput
          .extend({
            kind: z.enum(["task", "repository", "repair"]),
            editor: z.enum(["code", "cursor", "windsurf", "codium"]),
          })
          .strict()
          .parse(input);
        return new Editors(e, this.repairs.openPath).open(
          p.id,
          p.kind,
          p.editor,
        );
      }
      case "usage.info":
        return {
          root: e.root,
          capabilities: { manual_issue_watch: true, issue_watch_contract: 1 },
          database: join(e.root, "state", "vibestar.sqlite"),
          schema: e.db.all(
            "SELECT max(version) version FROM schema_migrations",
          )[0],
          runs: e.db.all("SELECT count(*) count FROM ai_usage")[0],
        };
      case "snapshot": {
        const snapshot = {
          repositories: e.db.repositories(),
          tasks: e.db.tasks(),
          settings: e.db.displaySettings(),
          root: e.root,
          capabilities: { manual_issue_watch: true, issue_watch_contract: 1 },
          execution_environment: {
            distro: process.env.WSL_DISTRO_NAME || "Linux",
          },
          repository_index: e.repositoryIndex.snapshot(),
          active_tasks: e.db
            .tasks()
            .filter((t) => e.isActive(t.id))
            .map((t) => t.id),
          scheduled: this.scheduler.jobs(),
          repairs: this.repairs.store.list(),
          pr_reports: this.scheduler.jobs().map((job) => {
            const analysis = this.scheduler.analysis
              .history(job.id)
              .find((record) => record.report);
            const actions =
              analysis?.report?.actions.filter(
                (action) =>
                  ["required_change", "suggested_change", "question"].includes(
                    action.classification,
                  ) && action.responseState !== "answered",
              ) || [];
            return {
              job_id: job.id,
              outstanding: actions.length,
              unanswered_questions: actions.filter(
                (action) => action.classification === "question",
              ).length,
            };
          }),
          attention: this.scheduler.attention(),
          github: this.github.snapshot(),
        };
        const persistence = e.db.records.diagnostics();
        return {
          ...snapshot,
          persistence,
          ...(persistence.length
            ? {
                warning: `${persistence.length} saved record(s) need recovery. Original data is preserved; open Settings for persistence diagnostics.`,
              }
            : {}),
        };
      }
      case "persistence.diagnostics":
        return e.db.records.diagnostics();
      case "github.status":
        return this.github.client.detect();
      case "github.sync":
        return this.github.sync();
      case "github.configure":
        return this.github.configure(input);
      case "github.resolve":
        return this.github.resolve(
          z.object({ repository: z.string().max(200) }).parse(input).repository,
        );
      case "github.use": {
        const p = z
          .object({
            repository: z.string().max(200),
            local_path: z.string().max(2000).optional(),
          })
          .parse(input);
        return this.github.useLocally(p.repository, false, p.local_path);
      }
      case "github.clone": {
        const p = z
          .object({ repository: z.string().min(1).max(200) })
          .strict()
          .parse(input);
        return this.github.startClone(p.repository);
      }
      case "github.clone.cancel":
        return this.github.cancelClone(idInput.strict().parse(input).id);
      case "github.clone.logs": {
        const p = idInput.strict().parse(input);
        if (!this.github.cloneActivities().some((c) => c.id === p.id))
          throw new AdeError("not_found", "Clone activity not found");
        const log = await open(join(e.root, "logs", `clone-${p.id}.log`), "r");
        try {
          const size = (await log.stat()).size;
          const buffer = Buffer.alloc(Math.min(size, 1048576));
          await log.read(
            buffer,
            0,
            buffer.length,
            Math.max(0, size - buffer.length),
          );
          return {
            text: buffer.toString("utf8"),
            truncated: size > buffer.length,
          };
        } finally {
          await log.close();
        }
      }
      case "repository.verifyLocal":
        return e.verifyLocalRepository(LocalRepositoryInput.parse(input));
      case "repository.connectLocal":
        return e.connectLocalRepository(ConnectLocalInput.parse(input));
      case "repository.disconnect": {
        const p = idInput
          .extend({ confirmed: z.literal(true) })
          .strict()
          .parse(input);
        return e.disconnectRepository(p.id);
      }
      case "repository.reconnectManaged":
        return e.reconnectRepository(idInput.strict().parse(input).id);
      case "repository.verify":
        return e.verifyRepository(idInput.strict().parse(input).id);
      case "repositories.scan": {
        e.assertAvailable();
        const result = await e.repositoryIndex.scan();
        e.changed();
        return result;
      }
      case "repositories.index":
        return e.repositoryIndex.snapshot();
      case "repositories.candidates": {
        e.assertAvailable();
        const p = z.object({ repository: z.string().max(200) }).parse(input);
        const metadata = await this.github.client.repository(p.repository);
        await e.repositoryIndex.scan();
        e.changed();
        const matches = [metadata.full_name, metadata.parent?.full_name]
          .filter((name) => !!name)
          .flatMap((name) => e.repositoryIndex.matches(name!));
        return {
          candidates: [
            ...new Map(matches.map((r) => [r.path, r])).values(),
          ].filter(
            (candidate) =>
              !e.db
                .repositories()
                .some(
                  (r) => r.connected !== false && r.path === candidate.path,
                ),
          ),
        };
      }
      case "usage.list": {
        const p = z
          .object({
            task_id: z.string().uuid().optional(),
            job_id: z.string().uuid().optional(),
            watch_id: z.string().uuid().optional(),
            scan_id: z.string().uuid().optional(),
            days: z.number().int().min(1).max(3650).optional(),
          })
          .parse(input);
        return new Usage(e.db)
          .list(p.task_id, p.days)
          .filter(
            (r) =>
              (!p.job_id || r.job_id === p.job_id) &&
              (!p.watch_id || r.watch_id === p.watch_id) &&
              (!p.scan_id || r.scan_id === p.scan_id),
          );
      }
      case "storage.info":
        return this.storage.info();
      case "storage.blockers": {
        const p = z
          .object({ task_id: z.string().uuid().optional() })
          .parse(input);
        return e.cleanupBlockers(p.task_id);
      }
      case "storage.stopBlockers": {
        const p = z
          .object({
            task_id: z.string().uuid().optional(),
            ids: z.array(z.string()).max(100),
          })
          .parse(input);
        const blockers = e
          .cleanupBlockers(p.task_id)
          .filter((b) => b.stoppable && p.ids.includes(b.id));
        await Promise.all(
          blockers.map((b) =>
            b.kind === "terminal" && b.task_id
              ? this.terminals.close(b.task_id)
              : e.stopActivity(b.id),
          ),
        );
        return e.cleanupBlockers(p.task_id);
      }
      case "storage.open": {
        if (process.env.WSL_DISTRO_NAME)
          await capture(
            "explorer.exe",
            [await checked("wslpath", ["-w", e.root], e.root)],
            e.root,
          );
        else await capture("xdg-open", [e.root], e.root);
        return null;
      }
      case "storage.clear": {
        const p = z
          .object({
            kind: z.enum(["logs", "cache"]),
            confirmed: z.literal(true),
          })
          .parse(input);
        await this.storage.clear(p.kind);
        return null;
      }
      case "storage.cleanCompleted": {
        z.object({ confirmed: z.literal(true) }).parse(input);
        return this.storage.cleanCompleted();
      }
      case "storage.removeUnused": {
        z.object({ confirmed: z.literal(true) }).parse(input);
        return this.storage.removeUnused();
      }
      case "storage.reset": {
        z.object({
          confirmed: z.literal(true),
          confirmation: z.literal("RESET VIBESTAR"),
        }).parse(input);
        const blockers = e.cleanupBlockers();
        if (blockers.length)
          throw new AdeError(
            "busy",
            "Data reset is waiting for active operations to finish.",
            { blockers },
          );
        await this.github.close();
        await this.scheduler.close();
        return this.storage.reset();
      }
      case "task.cleanup": {
        const p = idInput
          .extend({
            confirmed: z.literal(true),
            worktree: z.boolean(),
            logs: z.boolean(),
            artifacts: z.boolean(),
            history: z.boolean(),
          })
          .parse(input);
        return this.storage.cleanupTask(p.id, p);
      }
      case "task.archive": {
        const p = idInput.extend({ archived: z.boolean() }).parse(input);
        if (e.isActive(p.id) || e.db.task(p.id).status === "queued")
          throw new AdeError("busy", "Stop this task before archiving it.");
        e.db.saveTask({ ...e.db.task(p.id), archived: p.archived });
        e.changed(p.id);
        return null;
      }
      case "task.message.retry": {
        const p = idInput
          .extend({
            message_id: z.string().uuid(),
            content: z.string().min(1).max(32000).optional(),
            request_id: z.string().uuid().optional(),
          })
          .parse(input);
        const message = e.db.all<{
          content: string;
          configuration: string | null;
          status: string;
        }>(
          "SELECT content,configuration,status FROM task_messages WHERE id=? AND task_id=?",
          p.message_id,
          p.id,
        )[0];
        if (!message) throw new AdeError("not_found", "Message not found");
        if (
          message.status !== "delivered" &&
          (!p.content || p.content === message.content)
        )
          return e.sendSavedMessage(p.id, p.message_id);
        return e.followUp(
          p.id,
          p.content || message.content,
          message.configuration
            ? e.db.records.decode(
                {
                  table: "task_messages",
                  id: p.message_id,
                  column: "configuration",
                  source: message.configuration,
                },
                FollowupConfigSchema.parse,
              )
            : undefined,
          false,
          p.request_id,
        );
      }
      case "task.message.send": {
        const p = idInput
          .extend({
            message_id: z.string().uuid(),
            configuration: FollowupConfigSchema.optional(),
          })
          .strict()
          .parse(input);
        return e.sendSavedMessage(p.id, p.message_id, p.configuration);
      }
      case "repair.terminal.status":
        return this.repairTerminals.current(idInput.strict().parse(input).id);
      case "terminal.status":
        return this.terminals.current(idInput.parse(input).id);
      case "repair.terminal.open":
      case "terminal.open": {
        const p = idInput
          .extend({
            cols: z.number().int().min(20).max(500),
            rows: z.number().int().min(4).max(200),
          })
          .strict()
          .parse(input);
        return (
          method.startsWith("repair.") ? this.repairTerminals : this.terminals
        ).open(p.id, p.cols, p.rows);
      }
      case "repair.terminal.input": {
        const p = idInput
          .extend({ session_id: z.string().uuid(), text: z.string().max(8192) })
          .strict()
          .parse(input);
        return this.repairTerminals.input(p.id, p.session_id, p.text);
      }
      case "repair.terminal.resize": {
        const p = idInput
          .extend({
            session_id: z.string().uuid(),
            cols: z.number().int().min(20).max(500),
            rows: z.number().int().min(4).max(200),
          })
          .strict()
          .parse(input);
        return this.repairTerminals.resize(p.id, p.session_id, p.cols, p.rows);
      }
      case "repair.terminal.close":
        return this.repairTerminals.close(idInput.strict().parse(input).id);
      case "repair.command": {
        const p = idInput
          .extend({
            argv: z.array(z.string().min(1).max(8000)).min(1).max(100),
          })
          .strict()
          .parse(input);
        return this.repairs.command(p.id, p.argv);
      }
      case "terminal.input": {
        const p = idInput
          .extend({ session_id: z.string().uuid(), text: z.string().max(8192) })
          .parse(input);
        return this.terminals.input(p.id, p.session_id, p.text);
      }
      case "terminal.resize": {
        const p = idInput
          .extend({
            session_id: z.string().uuid(),
            cols: z.number().int().min(20).max(500),
            rows: z.number().int().min(4).max(200),
          })
          .parse(input);
        return this.terminals.resize(p.id, p.session_id, p.cols, p.rows);
      }
      case "terminal.close":
        return this.terminals.close(idInput.parse(input).id);
      case "task.configure": {
        const p = idInput.extend({ settings: SettingsSchema }).parse(input);
        if (e.isActive(p.id))
          throw new AdeError(
            "busy",
            "Stop this task's active run or terminal before changing its models",
          );
        const task = e.db.task(p.id);
        e.db.saveTask({
          ...task,
          execution_settings: p.settings,
          updated_at: now(),
        });
        e.changed(p.id);
        return p.settings;
      }
      case "task.configureStage": {
        const p = idInput
          .extend({
            stage: z.union([
              z.literal(1),
              z.literal(2),
              z.literal(3),
              z.literal(5),
            ]),
            config: StageConfigSchema.strict(),
          })
          .strict()
          .parse(input);
        const task = e.db.task(p.id);
        if (e.isActive(p.id) || task.status === "queued")
          throw new AdeError(
            "busy",
            "Wait for execution and terminals to finish before editing a future stage.",
          );
        if (
          task.stage > p.stage ||
          e.db.all(
            "SELECT id FROM agent_runs WHERE task_id=? AND stage=? LIMIT 1",
            p.id,
            p.stage,
          ).length
        )
          throw new AdeError(
            "invalid_state",
            "Only stages that have never started can change their saved model configuration.",
          );
        e.db.saveTask({
          ...task,
          stage_settings: { ...task.stage_settings, [p.stage]: p.config },
          updated_at: now(),
        });
        e.changed(p.id);
        return p.config;
      }
      case "repair.create":
        return this.repairs.create(input);
      case "repair.list": {
        const p = z
          .object({ job_id: z.string().uuid().optional() })
          .strict()
          .parse(input);
        return this.repairs.store.list(p.job_id);
      }
      case "repair.detail":
        return this.repairs.detail(idInput.strict().parse(input).id);
      case "repair.start": {
        const p = idInput
          .extend({
            instructions: z.string().max(16000).default(""),
            request_id: z.string().uuid().optional(),
          })
          .strict()
          .parse(input);
        return this.repairs.start(p.id, p.instructions, p.request_id);
      }
      case "repair.cancel":
        return this.repairs.cancel(idInput.strict().parse(input).id);
      case "repair.approve": {
        const p = idInput
          .extend({
            expected_hash: z.string().regex(/^[a-f0-9]{64}$/),
            confirmed: z.literal(true),
          })
          .strict()
          .parse(input);
        return this.repairs.approve(p.id, p.expected_hash);
      }
      case "repair.approveLocal": {
        const p = idInput
          .extend({
            expected_hash: z.string().regex(/^[a-f0-9]{64}$/),
            confirmed: z.literal(true),
          })
          .strict()
          .parse(input);
        return this.repairs.approveLocal(p.id, p.expected_hash);
      }
      case "repair.commit": {
        const p = idInput
          .extend({
            expected_hash: z.string().regex(/^[a-f0-9]{64}$/),
            message: z.string().trim().min(1).max(4000),
            confirmed: z.literal(true),
          })
          .strict()
          .parse(input);
        return this.repairs.commit(p.id, p.expected_hash, p.message);
      }
      case "repair.preparePublication":
        return this.repairs.preparePublication(
          idInput.strict().parse(input).id,
        );
      case "repair.publish": {
        const p = idInput
          .extend({
            publication_id: z.string().uuid(),
            confirmed: z.literal(true),
          })
          .strict()
          .parse(input);
        return this.repairs.publish(p.id, p.publication_id);
      }
      case "repair.reconcilePublication": {
        const p = idInput
          .extend({ publication_id: z.string().uuid() })
          .strict()
          .parse(input);
        return this.repairs.reconcilePublication(p.id, p.publication_id);
      }
      case "repair.keepLocal":
        return this.repairs.keepLocal(idInput.strict().parse(input).id);
      case "repair.cleanup": {
        const p = idInput
          .extend({
            confirmed: z.literal(true),
            history: z.boolean().default(false),
          })
          .strict()
          .parse(input);
        return this.repairs.cleanup(p.id, p.history);
      }
      case "repair.reviewFiles":
        return this.repairs.reviewFiles(idInput.strict().parse(input).id);
      case "repair.reviewed": {
        const p = idInput
          .extend({
            path: z.string().min(1).max(4000),
            old_path: z.string().nullable().optional(),
            expected_hash: z.string().regex(/^[a-f0-9]{64}$/),
            reviewed: z.boolean(),
          })
          .strict()
          .parse(input);
        return this.repairs.reviewed(
          p.id,
          p.path,
          p.old_path,
          p.expected_hash,
          p.reviewed,
        );
      }
      case "repair.recoverConflict":
        return this.repairs.recoverConflict(
          idInput
            .extend({ confirmed: z.literal(true) })
            .strict()
            .parse(input).id,
        );
      case "repair.diff": {
        const p = idInput
          .extend({
            layer: z.enum(["original", "upstream", "repair"]).default("repair"),
          })
          .strict()
          .parse(input);
        const session = this.repairs.store.get(p.id);
        await this.repairs.workspaces.assert(
          session,
          e.db.repository(session.repo_id),
        );
        const assignment = this.repairs.assignment(p.id);
        if (p.layer === "repair") return e.git.diff(assignment);
        const base =
          p.layer === "original"
            ? session.workspace.original_base
            : session.workspace.original_head;
        const head =
          p.layer === "original"
            ? session.workspace.original_head
            : session.workspace.integrated_head;
        if (!head)
          throw new AdeError(
            "invalid_state",
            "Upstream integration has not completed.",
          );
        return e.git.diff({ ...assignment, base_commit_sha: base }, head);
      }
      case "repair.file": {
        const p = idInput
          .extend({
            path: z.string().max(4000),
            old_path: z.string().nullable().optional(),
            layer: z.enum(["original", "upstream", "repair"]).default("repair"),
          })
          .strict()
          .parse(input);
        const session = this.repairs.store.get(p.id);
        await this.repairs.workspaces.assert(
          session,
          e.db.repository(session.repo_id),
        );
        return e.git.file(
          {
            ...this.repairs.assignment(p.id),
            base_commit_sha:
              p.layer === "original"
                ? session.workspace.original_base
                : p.layer === "upstream"
                  ? session.workspace.original_head
                  : session.workspace.integrated_head ||
                    session.workspace.original_head,
          },
          p.path,
          p.old_path,
          p.layer === "original"
            ? session.workspace.original_head
            : p.layer === "upstream"
              ? session.workspace.integrated_head || undefined
              : undefined,
        );
      }
      case "repair.events":
      case "repair.logs":
      case "task.events":
      case "task.logs": {
        const p = idInput
          .extend({
            run_id: z.string().uuid().nullable(),
            stream: z.enum(["stdout", "stderr"]).default("stdout"),
            before: z.number().int().nonnegative().optional(),
            after: z.number().int().nonnegative().optional(),
            search: z.string().max(256).optional(),
            paged: z.boolean().optional(),
          })
          .parse(input);
        const owner = method.startsWith("repair.") ? "repair_id" : "task_id";
        if (owner === "repair_id") this.repairs.store.get(p.id);
        else e.db.task(p.id);
        if (
          p.run_id &&
          !e.db.all(
            `SELECT id FROM agent_runs WHERE id=? AND ${owner}=?`,
            p.run_id,
            p.id,
          ).length
        )
          throw new AdeError("isolation", "Run does not belong to this task");
        if (method.endsWith(".events")) {
          const rows = e.db.all<{ id: number; data: string; kind: string }>(
            `SELECT * FROM agent_events WHERE ${owner}=? AND run_id=?
             AND id<? AND id>? AND (?='' OR instr(lower(data || raw),lower(?))>0)
             ORDER BY id ${p.after !== undefined ? "ASC" : "DESC"} LIMIT 501`,
            p.id,
            p.run_id,
            p.before ?? Number.MAX_SAFE_INTEGER,
            p.after ?? 0,
            p.search || "",
            p.search || "",
          );
          const more = rows.length > 500;
          const events = rows.slice(0, 500);
          if (p.after === undefined) events.reverse();
          const calls = [
            ...new Set(
              events
                .filter((event) => event.kind !== "message")
                .flatMap((event) => {
                  try {
                    const data = JSON.parse(event.data);
                    return data.call_id == null ? [] : [String(data.call_id)];
                  } catch {
                    return [];
                  }
                }),
            ),
          ];
          const context = calls.length
            ? e.db.all(
                `SELECT * FROM agent_events WHERE id IN (
             SELECT MIN(id) FROM agent_events WHERE ${owner}=? AND run_id=? AND json_valid(data)
             AND CAST(json_extract(CASE WHEN json_valid(data) THEN data END,'$.call_id') AS TEXT) IN (${calls.map(() => "?").join(",")}) GROUP BY json_extract(CASE WHEN json_valid(data) THEN data END,'$.call_id')
             UNION SELECT MAX(id) FROM agent_events WHERE ${owner}=? AND run_id=? AND json_valid(data)
             AND CAST(json_extract(CASE WHEN json_valid(data) THEN data END,'$.call_id') AS TEXT) IN (${calls.map(() => "?").join(",")}) GROUP BY json_extract(CASE WHEN json_valid(data) THEN data END,'$.call_id')
             ) ORDER BY id`,
                p.id,
                p.run_id,
                ...calls,
                p.id,
                p.run_id,
                ...calls,
              )
            : [];
          return { events, context, more };
        }
        return readLogTail(
          e.root,
          p.id,
          p.run_id,
          p.stream,
          p.paged
            ? { before: p.before, after: p.after, search: p.search }
            : undefined,
        );
      }
      case "review.files":
        return this.review.files(idInput.strict().parse(input).id);
      case "review.reviewed":
        return this.review.reviewed(input);
      case "review.questions":
        return this.review.questions(idInput.strict().parse(input).id);
      case "review.ask":
        return this.review.ask(input);
      case "review.list":
        return this.review.list(idInput.parse(input).id);
      case "review.add":
        return this.review.add(input);
      case "review.remove":
        return this.review.remove(
          idInput.extend({ confirmed: z.literal(true) }).parse(input).id,
        );
      case "review.send":
        return this.review.send(idInput.parse(input).id);
      case "scheduled.add":
        return this.scheduler.add(input);
      case "scheduled.analyze": {
        const p = idInput
          .extend({ request_id: z.string().uuid() })
          .strict()
          .parse(input);
        return this.scheduler.analyze(p.id, p.request_id);
      }
      case "scheduled.cancel":
        return this.scheduler.cancel(idInput.strict().parse(input).id);
      case "scheduled.detail": {
        const p = idInput.strict().parse(input);
        if (!this.scheduler.jobs().some((job) => job.id === p.id))
          throw new AdeError("not_found", "Tracked PR not found");
        return {
          analyses: this.scheduler.analysis.history(p.id),
          runs: e.db.all(
            "SELECT * FROM scheduled_agent_runs WHERE job_id=? ORDER BY started_at",
            p.id,
          ),
          usage: e.db.all(
            "SELECT * FROM ai_usage WHERE job_id=? ORDER BY started_at DESC",
            p.id,
          ),
        };
      }
      case "scheduled.logs": {
        const p = idInput
          .extend({
            run_id: z.string().uuid(),
            stream: z.enum(["stdout", "stderr"]),
          })
          .strict()
          .parse(input);
        if (
          !e.db.all(
            "SELECT id FROM scheduled_agent_runs WHERE id=? AND job_id=?",
            p.run_id,
            p.id,
          ).length
        )
          throw new AdeError("isolation", "Run does not belong to this PR");
        return readLogTail(e.root, `pr-watch-${p.id}`, p.run_id, p.stream);
      }
      case "scheduled.enabled": {
        const p = idInput.extend({ enabled: z.boolean() }).parse(input);
        return this.scheduler.setEnabled(p.id, p.enabled);
      }
      case "scheduled.run": {
        const p = idInput
          .extend({ retry: z.boolean().default(false) })
          .parse(input);
        return this.scheduler.runNow(p.id);
      }
      case "scheduled.remove": {
        const p = idInput.extend({ confirmed: z.literal(true) }).parse(input);
        if (e.db.all("SELECT id FROM pr_repairs WHERE job_id=?", p.id).length)
          throw new AdeError(
            "repair_history",
            "Remove this PR's repair workspaces and history explicitly before removing the tracked PR.",
          );
        const job = this.scheduler.jobs().find((j) => j.id === p.id);
        if (
          job &&
          (["analyzing", "polling"].includes(job.status) ||
            e
              .cleanupBlockers()
              .some((activity) => activity.id === `pr-watch:${p.id}`))
        )
          throw new AdeError("busy", "Wait for inspection to finish");
        e.db.run("DELETE FROM scheduled_jobs WHERE id=?", p.id);
        e.changed();
        return null;
      }
      case "scheduled.dismiss":
        return this.scheduler.dismiss(idInput.parse(input).id);
      case "scheduled.fix":
        idInput.strict().parse(input);
        return this.scheduler.fix();
      case "scheduled.discover": {
        const p = z.object({ repository: z.string().max(200) }).parse(input);
        return new GitHubMonitor(e.root).discover(
          p.repository,
          new AbortController().signal,
        );
      }
      case "task.detail": {
        const id = idInput.parse(input).id;
        const detail = e.db.detail(id);
        return {
          ...detail,
          validation: taskVerification(e.db, id),
          task: {
            ...detail.task,
            execution_settings:
              detail.task.execution_settings ?? e.db.settings(),
          },
          active: e.isActive(id),
          executing: e.isExecuting(id),
        };
      }
      case "repository.add": {
        const p = z
          .object({
            upstream_url: z.string().max(2000),
            origin_url: z.string().max(2000).nullable(),
            base_branch: z.string().max(200),
          })
          .parse(input);
        return e.register(p.upstream_url, p.origin_url, p.base_branch);
      }
      case "repository.fetch":
        return e.fetchRepository(idInput.parse(input).id);
      case "repository.info": {
        const r = e.db.repository(idInput.parse(input).id);
        const o = await capture("du", ["-sh", r.path], e.root);
        return {
          disk_usage: o.stdout.split("\t")[0],
          active_worktrees: e.db
            .tasks()
            .filter((t) => t.repo_id === r.id && t.worktree_path).length,
        };
      }
      case "repository.remove": {
        const p = idInput.extend({ confirmed: z.literal(true) }).parse(input);
        return this.storage.removeRepository(p.id);
      }
      case "task.preview": {
        const p = z
          .object({
            repository_id: z.string().uuid(),
            issue_url: z.string().max(2000),
          })
          .strict()
          .parse(input);
        const reference = parseIssue(p.issue_url);
        const repository = e.taskRepository(p.repository_id, reference);
        const issue = await fetchIssue(reference, e.root);
        return {
          reference,
          issue,
          repository,
        };
      }
      case "task.create": {
        const p = z
          .object({
            request_id: z.string().uuid().optional(),
            repository_id: z.string().uuid(),
            issue_url: z.string(),
            scope_mode: z.enum(["whole_issue", "partial"]).default("partial"),
            claimed_scope: z.string().max(1000).default(""),
            notes: z.string().max(32000).default(""),
            settings: SettingsSchema.optional(),
          })
          .strict()
          .parse(input);
        if (p.scope_mode === "partial" && !p.claimed_scope.trim())
          throw new AdeError(
            "invalid_input",
            "Claimed scope is required for a partial task",
          );
        return e.createTask(
          p.repository_id,
          p.issue_url,
          p.claimed_scope,
          p.notes,
          p.scope_mode,
          p.settings,
          p.request_id,
        );
      }
      case "task.cancel": {
        const id = idInput.parse(input).id;
        await this.terminals.close(id);
        e.cancel(id);
        return null;
      }
      case "task.retry": {
        const p = idInput
          .extend({
            stage: z.number().int().min(0).max(5).optional(),
            restart: z.boolean().optional(),
          })
          .parse(input);
        return e.retry(p.id, p.stage, p.restart);
      }
      case "task.approve": {
        const p = idInput
          .extend({
            artifact_id: z.string().uuid().optional(),
            instructions: z
              .object({
                disposition: z.enum(["keep_saved", "include_next_stage"]),
                message_ids: z.array(z.string().uuid()).max(1000),
              })
              .strict()
              .optional(),
          })
          .strict()
          .parse(input);
        return e.approveStage(p.id, p.instructions, p.artifact_id);
      }
      case "task.acceptDraft": {
        const p = idInput
          .extend({ run_id: z.string().uuid() })
          .strict()
          .parse(input);
        return e.acceptDraft(p.id, p.run_id);
      }
      case "task.followup": {
        const p = idInput
          .extend({
            content: z.string().max(32000),
            save_only: z.boolean().default(false),
            configuration: FollowupConfigSchema.optional(),
            request_id: z.string().uuid().optional(),
          })
          .parse(input);
        return e.followUp(
          p.id,
          p.content,
          p.configuration,
          p.save_only,
          p.request_id,
        );
      }
      case "task.complete": {
        const t = e.db.task(idInput.parse(input).id);
        if (e.isActive(t.id) || t.status !== "ready_for_review")
          throw new AdeError(
            "invalid_state",
            "Only Ready for Review tasks can be completed",
          );
        if (
          !t.final_review_hash?.startsWith("issue-v2:") ||
          t.final_review_hash !== (await e.git.fingerprint(t))
        )
          throw new AdeError(
            "stale_review",
            "The worktree changed or its final review uses an older integrity method. Retry Antigravity review before completing.",
          );
        e.db.saveTask({ ...t, status: "completed", updated_at: now() });
        e.changed(t.id);
        return null;
      }
      case "task.diff":
        return e.git.diff(e.db.task(idInput.parse(input).id));
      case "task.file": {
        const p = idInput
          .extend({
            path: z.string(),
            old_path: z.string().nullable().optional(),
          })
          .parse(input);
        return e.git.file(e.db.task(p.id), p.path, p.old_path);
      }
      case "task.discard": {
        const p = idInput
          .extend({ path: z.string().optional(), confirmed: z.literal(true) })
          .parse(input);
        if (e.isActive(p.id))
          throw new AdeError(
            "invalid_state",
            "Stop the task before discarding changes",
          );
        await e.git.discard(e.db.task(p.id), p.path);
        e.changed(p.id);
        return null;
      }
      case "task.command": {
        const p = idInput
          .extend({ argv: z.array(z.string()).min(1).max(100) })
          .parse(input);
        return e.runCommand(p.id, p.argv);
      }
      case "settings.save":
        e.db.saveSettings(SettingsSchema.parse(input));
        e.start();
        e.changed();
        return e.db.settings();
      case "providers.detect": {
        const [agents, github] = await Promise.all([
          e.providers(),
          new GitHubClient(e.root).detect(),
        ]);
        return [
          ...agents,
          {
            provider: "github",
            installed: github.installed,
            version: github.version,
            connected: github.connected,
            accountLabel: github.username ? `@${github.username}` : undefined,
            models: [],
            efforts: [],
            capabilities: github.installed
              ? ["repository-discovery", "pr-watch"]
              : [],
            error: github.error,
          },
        ];
      }
      case "auth.connect":
        return this.auth.connect(
          z
            .object({ provider: z.enum(["codex", "antigravity", "github"]) })
            .parse(input).provider,
        );
      case "auth.input": {
        const p = z
          .object({ session_id: z.string().uuid(), text: z.string() })
          .parse(input);
        this.auth.input(p.session_id, p.text);
        return null;
      }
      case "auth.close":
        this.auth.close(
          z.object({ session_id: z.string().uuid() }).parse(input).session_id,
        );
        return null;
      case "open.directory": {
        const p = idInput
          .extend({ kind: z.enum(["task", "repository", "repair"]) })
          .parse(input);
        const path =
          p.kind === "repair"
            ? await this.repairs.openPath(p.id)
            : p.kind === "task"
              ? await taskRoot(e.root, e.db.task(p.id))
              : await realpath(e.db.repository(p.id).path);
        if (process.env.WSL_DISTRO_NAME) {
          const windows = await checked("wslpath", ["-w", path], e.root);
          await capture("explorer.exe", [windows], e.root);
        } else await capture("xdg-open", [path], e.root);
        return null;
      }
      default:
        throw new AdeError("invalid_method", `Unknown method: ${method}`);
    }
  };
  close = async () => {
    this.auth.dispose();
    await this.issueWatch.close();
    await this.github.close();
    await this.scheduler.close();
    await this.repairTerminals.dispose();
    await this.repairs.close();
    await this.terminals.dispose();
  };
}
