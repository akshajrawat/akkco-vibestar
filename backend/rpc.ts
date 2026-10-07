import { GitHubService } from "./github/service";
import { GitHubClient } from "./github/client";
import { fetchIssue } from "./workspace/issue";
import { StageConfigSchema } from "./domain";
import { StorageService } from "./storage/service";
import { Usage } from "./execution/usage";
import { TaskTerminals } from "./execution/task-terminals";
import { readLogTail } from "./storage/logs";
import { ReviewService } from "./review/service";
import { Scheduler } from "./scheduled/scheduler";
import { GitHubMonitor } from "./scheduled/github";
import { z } from "zod";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { Engine } from "./execution/engine";
import { AuthSessions } from "./execution/auth";
import { AdeError, SettingsSchema, parseIssue, now } from "./domain";
import { capture, checked } from "./execution/process";
import { taskRoot, exists } from "./workspace/paths";
const idInput = z.object({ id: z.string().uuid() });
export class Rpc {
  private readonly auth: AuthSessions;
  readonly scheduler: Scheduler;
  readonly github: GitHubService;
  private readonly review: ReviewService;
  private readonly terminals: TaskTerminals;
  private readonly storage: StorageService;
  constructor(readonly engine: Engine) {
    this.scheduler = new Scheduler(engine);
    this.github = new GitHubService(engine, this.scheduler);
    this.review = new ReviewService(engine);
    this.terminals = new TaskTerminals(engine);
    this.storage = new StorageService(engine);
    this.auth = new AuthSessions(engine.root, (event) => {
      engine.publish(event);
      if (event.event === "auth.closed") void this.github.sync();
    });
  }
  call = async (method: string, input: unknown) => {
    const e = this.engine;
    switch (method) {
      case "snapshot":
        return {
          repositories: e.db.repositories(),
          tasks: e.db.tasks(),
          settings: e.db.settings(),
          root: e.root,
          repository_index: e.repositoryIndex.snapshot(),
          active_tasks: e.db
            .tasks()
            .filter((t) => e.isActive(t.id))
            .map((t) => t.id),
          scheduled: this.scheduler.jobs(),
          attention: this.scheduler.attention(),
          github: this.github.snapshot(),
        };
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
        const resolved = await this.github.resolve(
          metadata.fork && metadata.parent
            ? metadata.parent.full_name
            : p.repository,
        );
        await e.repositoryIndex.scan();
        e.changed();
        const registered = e.db
          .repositories()
          .find(
            (r) =>
              `${r.owner}/${r.name}`.toLowerCase() ===
              resolved.repository.full_name.toLowerCase(),
          );
        return {
          resolved,
          candidates:
            registered &&
            (registered.source === "imported" ||
              (await exists(join(registered.path, ".git"))))
              ? []
              : e.repositoryIndex.matches(resolved.repository.full_name),
        };
      }
      case "usage.list": {
        const p = z
          .object({
            task_id: z.string().uuid().optional(),
            job_id: z.string().uuid().optional(),
            days: z.number().int().min(1).max(3650).optional(),
          })
          .parse(input);
        return new Usage(e.db)
          .list(p.task_id, p.days)
          .filter((r) => !p.job_id || r.job_id === p.job_id);
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
          })
          .parse(input);
        const message = e.db.all<{
          content: string;
          configuration: string | null;
        }>(
          "SELECT content,configuration FROM task_messages WHERE id=? AND task_id=?",
          p.message_id,
          p.id,
        )[0];
        if (!message) throw new AdeError("not_found", "Message not found");
        return e.followUp(
          p.id,
          p.content || message.content,
          message.configuration ? JSON.parse(message.configuration) : undefined,
        );
      }
      case "terminal.status":
        return this.terminals.current(idInput.parse(input).id);
      case "terminal.open": {
        const p = idInput
          .extend({
            cols: z.number().int().min(20).max(500),
            rows: z.number().int().min(4).max(200),
          })
          .parse(input);
        return this.terminals.open(p.id, p.cols, p.rows);
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
      case "task.logs": {
        const p = idInput
          .extend({
            run_id: z.string().uuid().nullable(),
            stream: z.enum(["stdout", "stderr"]),
          })
          .parse(input);
        e.db.task(p.id);
        if (
          p.run_id &&
          !e.db.all(
            "SELECT id FROM agent_runs WHERE id=? AND task_id=?",
            p.run_id,
            p.id,
          ).length
        )
          throw new AdeError("isolation", "Run does not belong to this task");
        return readLogTail(e.root, p.id, p.run_id, p.stream);
      }
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
      case "scheduled.enabled": {
        const p = idInput.extend({ enabled: z.boolean() }).parse(input);
        return this.scheduler.setEnabled(p.id, p.enabled);
      }
      case "scheduled.run": {
        const p = idInput
          .extend({ retry: z.boolean().default(false) })
          .parse(input);
        return this.scheduler.runNow(p.id, p.retry);
      }
      case "scheduled.remove": {
        const p = idInput.extend({ confirmed: z.literal(true) }).parse(input);
        const job = this.scheduler.jobs().find((j) => j.id === p.id);
        if (job && ["analyzing", "polling"].includes(job.status))
          throw new AdeError("busy", "Wait for inspection to finish");
        e.db.run("DELETE FROM scheduled_jobs WHERE id=?", p.id);
        e.changed();
        return null;
      }
      case "scheduled.dismiss":
        return this.scheduler.dismiss(idInput.parse(input).id);
      case "scheduled.fix":
        return this.scheduler.fix(idInput.parse(input).id);
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
        const p = z.object({ issue_url: z.string() }).parse(input);
        const reference = parseIssue(p.issue_url);
        const [issue, resolved] = await Promise.all([
          fetchIssue(reference, e.root),
          this.github.resolve(`${reference.owner}/${reference.repo}`),
        ]);
        return {
          reference,
          issue,
          resolved,
          repository:
            e.db
              .repositories()
              .find(
                (r) =>
                  `${r.owner}/${r.name}`.toLowerCase() ===
                  `${reference.owner}/${reference.repo}`.toLowerCase(),
              ) || null,
        };
      }
      case "task.create": {
        const p = z
          .object({
            issue_url: z.string(),
            scope_mode: z.enum(["whole_issue", "partial"]).default("partial"),
            claimed_scope: z.string().max(1000).default(""),
            notes: z.string().max(32000).default(""),
            settings: SettingsSchema.optional(),
            advanced: z
              .object({
                upstream_url: z.string(),
                origin_url: z.string().nullable(),
                base_branch: z.string(),
              })
              .optional(),
          })
          .parse(input);
        if (p.scope_mode === "partial" && !p.claimed_scope.trim())
          throw new AdeError(
            "invalid_input",
            "Claimed scope is required for a partial task",
          );
        const ref = parseIssue(p.issue_url);
        const existing = e.db
          .repositories()
          .find(
            (r) =>
              `${r.owner}/${r.name}`.toLowerCase() ===
              `${ref.owner}/${ref.repo}`.toLowerCase(),
          );
        if (p.advanced) {
          const identity = (await import("./domain")).remoteIdentity(
            p.advanced.upstream_url,
          );
          if (
            `${identity.owner}/${identity.name}`.toLowerCase() !==
            `${ref.owner}/${ref.repo}`.toLowerCase()
          )
            throw new AdeError(
              "invalid_input",
              "Upstream must match the issue repository",
            );
          if (existing) await e.configureRepository(existing.id, p.advanced);
          else
            await e.register(
              p.advanced.upstream_url,
              p.advanced.origin_url,
              p.advanced.base_branch,
              true,
            );
        } else if (!existing)
          await this.github.useLocally(`${ref.owner}/${ref.repo}`, true);
        return e.createTask(
          p.issue_url,
          p.claimed_scope,
          p.notes,
          p.scope_mode,
          p.settings,
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
            stage: z.number().int().min(0).max(4).optional(),
            restart: z.boolean().optional(),
          })
          .parse(input);
        return e.retry(p.id, p.stage, p.restart);
      }
      case "task.followup": {
        const p = idInput
          .extend({
            content: z.string().max(32000),
            save_only: z.boolean().default(false),
            configuration: z
              .object({
                provider: z.enum(["codex", "antigravity"]),
                config: StageConfigSchema,
              })
              .optional(),
          })
          .parse(input);
        return e.followUp(p.id, p.content, p.configuration, p.save_only);
      }
      case "task.complete": {
        const t = e.db.task(idInput.parse(input).id);
        if (e.isActive(t.id) || t.status !== "ready_for_review")
          throw new AdeError(
            "invalid_state",
            "Only Ready for Review tasks can be completed",
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
          .extend({ kind: z.enum(["task", "repository"]) })
          .parse(input);
        const path =
          p.kind === "task"
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
    await this.github.close();
    await this.scheduler.close();
    await this.terminals.dispose();
  };
}
