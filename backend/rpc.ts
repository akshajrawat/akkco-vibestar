import { TaskTerminals } from "./execution/task-terminals";
import { readLogTail } from "./storage/logs";
import { ReviewService } from "./review/service";
import { Scheduler } from "./scheduled/scheduler";
import { GitHubMonitor } from "./scheduled/github";
import { z } from "zod";
import { realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { Engine } from "./execution/engine";
import { AuthSessions } from "./execution/auth";
import {
  AdeError,
  SettingsSchema,
  branchName,
  parseIssue,
  now,
} from "./domain";
import { capture, checked } from "./execution/process";
import { inside, taskRoot } from "./workspace/paths";
const idInput = z.object({ id: z.string().uuid() });
export class Rpc {
  private readonly auth: AuthSessions;
  readonly scheduler: Scheduler;
  private readonly review: ReviewService;
  private readonly terminals: TaskTerminals;
  constructor(readonly engine: Engine) {
    this.scheduler = new Scheduler(engine);
    this.review = new ReviewService(engine);
    this.terminals = new TaskTerminals(engine);
    this.auth = new AuthSessions(engine.root, engine.publish);
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
          active_tasks: e.db
            .tasks()
            .filter((t) => e.isActive(t.id))
            .map((t) => t.id),
          scheduled: this.scheduler.jobs(),
          attention: this.scheduler.attention(),
        };
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
        const r = e.db.repository(p.id);
        const tasks = e.db.tasks().filter((t) => t.repo_id === r.id);
        if (tasks.some((t) => e.isActive(t.id)))
          throw new AdeError(
            "invalid_state",
            "Cancel active tasks before removing the repository",
          );
        if (
          this.scheduler
            .jobs()
            .some((j) => tasks.some((t) => t.id === j.task_id))
        )
          throw new AdeError(
            "invalid_state",
            "Pause and unlink scheduled PRs before removing their repository",
          );
        await e.git.withLock(r.id, async () => {
          for (const t of tasks) {
            if (t.worktree_path) {
              const path = await taskRoot(e.root, t);
              await checked(
                "git",
                ["worktree", "remove", "--force", "--", path],
                r.path,
              );
            }
            for (const table of [
              "agent_events",
              "test_runs",
              "task_artifacts",
              "task_messages",
              "agent_runs",
            ])
              e.db.run(`DELETE FROM ${table} WHERE task_id=?`, t.id);
            e.db.run("DELETE FROM tasks WHERE id=?", t.id);
          }
          e.db.run("DELETE FROM issues WHERE repo_id=?", r.id);
          const path = await realpath(r.path);
          if (!inside(join(e.root, "repos"), path))
            throw new AdeError("isolation", "Invalid managed clone path");
          await rm(path, { recursive: true });
          e.db.run("DELETE FROM repositories WHERE id=?", r.id);
        });
        e.changed();
        return null;
      }
      case "task.preview": {
        const p = z
          .object({
            issue_url: z.string(),
            claimed_scope: z.string().min(1).max(1000),
          })
          .parse(input);
        const issue = parseIssue(p.issue_url);
        return {
          issue,
          repository:
            e.db
              .repositories()
              .find(
                (r) =>
                  r.owner.toLowerCase() === issue.owner.toLowerCase() &&
                  r.name.toLowerCase() === issue.repo.toLowerCase(),
              ) ?? null,
          branch_name: branchName(issue.number, p.claimed_scope),
        };
      }
      case "task.create": {
        const p = z
          .object({
            issue_url: z.string(),
            claimed_scope: z.string(),
            notes: z.string().default(""),
          })
          .parse(input);
        return e.createTask(p.issue_url, p.claimed_scope, p.notes);
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
        const p = idInput.extend({ content: z.string() }).parse(input);
        return e.followUp(p.id, p.content);
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
      case "providers.detect":
        return e.providers();
      case "auth.connect":
        return this.auth.connect(
          z.object({ provider: z.enum(["codex", "antigravity"]) }).parse(input)
            .provider,
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
    await this.scheduler.close();
    await this.terminals.dispose();
  };
}
