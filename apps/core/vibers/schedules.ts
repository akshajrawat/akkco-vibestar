import { randomUUID } from "node:crypto";
import type { z } from "zod";

import { now } from "../domain";
import { redact } from "../execution/runtime/process";
import type { GitHubClient } from "../github/client";
import { canonicalPullRequest } from "../github/contracts";
import { checkScheduledPullRequests } from "../github/scheduled-pull-requests";
import type { Database } from "../storage/database";
import type { ViberSessionSendSchema } from "./contracts";
import {
  minimumScheduleMinutes,
  scheduleCadenceLabel,
  scheduleStatusLabel,
  type Cadence,
  type ScheduleStatus,
  type ScheduleTask,
  type ViberSchedule,
} from "./schedule-contracts";
import {
  parseScheduleIntent,
  parseScheduleTime,
  reminderInstructions,
  type ScheduleClarification,
  type ScheduleIntent,
} from "./schedule-intent";

interface ScheduleRow extends Omit<ViberSchedule, "task" | "cadence"> {
  task: string;
  cadence: string;
  profile_id: string;
  revision: number;
  cursor: string | null;
  account: string | null;
  error: string | null;
}

interface ScheduleOutcome {
  status: ScheduleStatus;
  cursor?: string;
  account?: string;
  error?: string;
  message?: string;
}

interface ScheduleReply {
  message: string;
  clarification?: ScheduleClarification;
}

type ScheduleChange = Extract<ScheduleIntent, { action: "pause" | "resume" | "cancel" | "edit" }>;

const minDelay = minimumScheduleMinutes * 60000;
const runtimeNote = "Runs while your laptop is awake and Vibestar's backend is running.";
const signIn = "Please sign in from **Providers → GitHub → Connect GitHub**.";
const runnable = "next_run_at IS NOT NULL AND status IN ('pending','active','blocked_sign_in','retrying')";
const nextRun = (cadence: Cadence, time: number) => {
  if (cadence.kind === "once") {
    return Math.max(cadence.at, time);
  }
  if (cadence.kind === "interval") {
    return time + cadence.minutes * 60000;
  }

  const next = new Date(time);
  for (let day = 0; day <= 7; day++) {
    const date = new Date(time);
    date.setDate(next.getDate() + day);
    date.setHours(cadence.hour, cadence.minute, 0, 0);
    const weekday = date.getDay();
    if (
      date.getTime() > time &&
      (cadence.day === undefined || weekday === cadence.day) &&
      (!cadence.weekdays || (weekday >= 1 && weekday <= 5))
    ) {
      return date.getTime();
    }
  }
  throw new Error("Could not compute the next schedule time.");
};

const unpack = (row: ScheduleRow): ViberSchedule => ({
  id: row.id,
  name: row.name,
  instructions: row.instructions,
  task: JSON.parse(row.task) as ScheduleTask,
  cadence: JSON.parse(row.cadence) as Cadence,
  next_run_at: row.next_run_at,
  status: row.status,
});

const normalizeTarget = (text: string) =>
  text.trim().replace(/^(?:the|my)\s+/i, "").replace(/^["“']|["”']$/g, "").toLowerCase();

export class ViberSchedules {
  private inFlight?: { id: string; controller: AbortController };
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private started = false;

  constructor(
    private readonly db: Database,
    private readonly client: GitHubClient,
    private readonly canRun: () => boolean,
    private readonly changed: () => void,
  ) {}

  start = () => {
    this.started = true;
    this.wake();
  };

  stop = () => {
    this.started = false;
    clearTimeout(this.timer);
    this.inFlight?.controller.abort();
  };

  close = async () => {
    this.stop();
    await this.running;
  };

  wake = () => {
    clearTimeout(this.timer);
    if (!this.started || this.running || !this.canRun()) {
      return;
    }

    const [row] = this.db.all<{ next_run_at: number }>(
      `SELECT next_run_at FROM viber_schedules WHERE ${runnable}
       AND EXISTS (SELECT 1 FROM viber_sessions WHERE profile_id=viber_schedules.profile_id)
       AND NOT EXISTS (SELECT 1 FROM retired_viber_profiles WHERE profile_id=viber_schedules.profile_id)
       ORDER BY next_run_at LIMIT 1`,
    );
    if (row) {
      // Bound the wait so wall-clock changes and waking from sleep get noticed.
      const delay = Math.max(0, Math.min(60000, row.next_run_at - Date.now()));
      this.timer = setTimeout(() => {
        this.running = this.runDue()
          .catch((error: unknown) => {
            process.stderr.write(`Viber schedules: ${redact(String(error))}\n`);
          })
          .finally(() => {
            this.running = undefined;
            this.wake();
          });
      }, delay);
      this.timer.unref();
    }
  };

  list = (profileId: string) =>
    this.db.all<ScheduleRow>(
      `SELECT * FROM viber_schedules WHERE profile_id=?
       AND NOT EXISTS (SELECT 1 FROM retired_viber_profiles WHERE profile_id=?)
       ORDER BY status IN ('completed','cancelled'), name COLLATE NOCASE, rowid`,
      profileId,
      profileId,
    ).map(unpack);

  cancelForProfile = (profileId: string) => {
    const running = this.inFlight;
    if (running && this.db.all(
      "SELECT id FROM viber_schedules WHERE id=? AND profile_id=?",
      running.id,
      profileId,
    ).length) {
      running.controller.abort();
    }
    this.db.run(
      "UPDATE viber_schedules SET status='cancelled',next_run_at=NULL,revision=revision+1 WHERE profile_id=? AND status NOT IN ('completed','cancelled')",
      profileId,
    );
  };

  clarification = (sessionId: string): ScheduleClarification | undefined => {
    const [row] = this.db.all<{ clarification: string | null }>(
      `SELECT json_extract(configuration,'$.schedule_clarification') AS clarification FROM viber_messages
       WHERE session_id=? AND coalesce(json_extract(configuration,'$.kind'),'')<>'schedule_notification'
       ORDER BY rowid DESC LIMIT 1`,
      sessionId,
    );
    return row?.clarification ? JSON.parse(row.clarification) as ScheduleClarification : undefined;
  };

  handleChat = (input: z.output<typeof ViberSessionSendSchema>, assertWritable: () => void) => {
    if (input.continue_message_id) {
      return false;
    }
    const content = redact(input.content);
    const intent = parseScheduleIntent(content, this.clarification(input.session_id));
    if (!intent) {
      return false;
    }

    assertWritable();
    this.db.transaction(() => {
      const timestamp = now();
      const reply = this.reply(input.profile_id, intent);
      this.db.run(
        `INSERT INTO viber_messages(id,session_id,role,content,status,configuration,created_at,effects)
         VALUES(?,?,'user',?,'completed','{"kind":"schedule_chat"}',?,'none')`,
        input.request_id,
        input.session_id,
        content,
        timestamp,
      );
      this.post(input.session_id, reply.message, "schedule_chat", reply.clarification);
      this.db.run("UPDATE viber_sessions SET updated_at=? WHERE id=?", timestamp, input.session_id);
    });
    this.changed();
    this.wake();
    return true;
  };

  private reply = (profileId: string, intent: ScheduleIntent): ScheduleReply => {
    const time = Date.now();
    switch (intent.action) {
      case "reminder": {
        const parsed = parseScheduleTime(intent.request, time);
        if ("error" in parsed) {
          return { message: parsed.error, clarification: { kind: "reminder", request: intent.request } };
        }

        const instructions = reminderInstructions(parsed.rest);
        if (!instructions) {
          return { message: "What should I remind you to do?", clarification: { kind: "reminder", request: intent.request } };
        }
        return this.create(profileId, instructions, instructions, { kind: "reminder" }, parsed.cadence, time);
      }
      case "watch": {
        const request = intent.request;
        const url = request.match(/https?:\/\/\S+/i)?.[0].replace(/[),.;]+$/, "");
        const repo = request.match(/\b(?:in|for|on)\s+([\w.-]+\/[\w.-]+)\b/i)?.[1].toLowerCase();
        const task: Extract<ScheduleTask, { kind: "github" }> = { kind: "github" };
        try {
          if (url) {
            task.pull = canonicalPullRequest(url).url;
          } else if (repo && !repo.split("/").some((part) => part === "." || part === "..")) {
            task.repository = repo;
          } else if (!/\b(?:my (?:PRs?|pull requests?|review requests?)|(?:needs?|requires?) (?:me|my review)|asked to review|review requests?)\b/i.test(request)) {
            throw new Error("Missing PR scope");
          }
        } catch {
          return {
            message: "Which PRs should I watch? You can say “my PRs,” give an owner/repository, or send a GitHub PR link.",
            clarification: { kind: "watch", request: request.replace(url ?? "", "") },
          };
        }

        const parsed = /\bevery\b/i.test(request) ? parseScheduleTime(request, time) : undefined;
        if (parsed && ("error" in parsed || parsed.cadence.kind !== "interval")) {
          return {
            message: "error" in parsed ? parsed.error : "How many minutes or hours apart should I check GitHub?",
            clarification: { kind: "watch_cadence", request: request.replace(/\bevery\b.*/i, "") },
          };
        }

        const name = task.pull
          ? task.pull.replace("https://github.com/", "").replace("/pull/", " #")
          : task.repository ? `${task.repository} PR reviews` : "PR reviews";
        return this.create(
          profileId,
          name,
          request,
          task,
          parsed?.cadence ?? { kind: "interval", minutes: minimumScheduleMinutes },
          time,
        );
      }
      case "list": {
        const schedules = this.list(profileId);
        return {
          message: schedules.length
            ? schedules.map((schedule) => `- **${schedule.name}** · ${scheduleCadenceLabel(schedule)} · ${scheduleStatusLabel[schedule.status]}${schedule.next_run_at == null ? "" : ` · next ${new Date(schedule.next_run_at).toLocaleString()}`}`).join("\n")
            : "This Viber has no schedules.",
        };
      }
      default:
        return this.change(profileId, intent, time);
    }
  };

  private create = (
    profileId: string,
    name: string,
    instructions: string,
    task: ScheduleTask,
    cadence: Cadence,
    time: number,
  ): ScheduleReply => {
    const duplicate = this.list(profileId).find((schedule) =>
      schedule.status !== "cancelled" && schedule.status !== "completed" &&
      (task.kind === "github" ? JSON.stringify(schedule.task) === JSON.stringify(task)
        : schedule.task.kind === "reminder" &&
          schedule.instructions.toLowerCase() === instructions.toLowerCase() &&
          JSON.stringify(schedule.cadence) === JSON.stringify(cadence)),
    );
    if (duplicate) {
      return { message: `“${duplicate.name}” is already saved for this Viber (${scheduleStatusLabel[duplicate.status]}).` };
    }

    const watch = task.kind === "github";
    const label = name.slice(0, 100);
    const dueAt = watch ? time : nextRun(cadence, time);
    this.db.run(
      "INSERT INTO viber_schedules(id,profile_id,name,instructions,task,cadence,next_run_at,status) VALUES(?,?,?,?,?,?,?,?)",
      randomUUID(), profileId, label, instructions, JSON.stringify(task), JSON.stringify(cadence), dueAt,
      watch ? "pending" : "active",
    );
    return {
      message: watch
        ? `Saved “${label}.” I’ll check GitHub access before starting this read-only watch. ${runtimeNote}`
        : `I’ll remind you to ${instructions}. Next run is ${new Date(dueAt).toLocaleString()} (${scheduleCadenceLabel({ task, cadence })}). ${runtimeNote}`,
    };
  };

  private change = (profileId: string, change: ScheduleChange, time: number): ScheduleReply => {
    const target = normalizeTarget(change.target);
    const schedules = this.list(profileId).filter(({ status }) => status !== "completed" && status !== "cancelled");
    const exact = schedules.filter(({ name, id, task }) =>
      name.toLowerCase() === target || id === target || (task.kind === "github" && task.pull === target),
    );
    const matches = exact.length ? exact : schedules.filter(({ name, task }) => {
      const prefix = target.replace(/\s+(?:schedule|reminder|watch)$/, "");
      return target === "schedule" || target === "schedules" ||
        (/^reminders?$/.test(target) && task.kind === "reminder") ||
        (/^(?:pr )?watch(?:es)?$/.test(target) && task.kind === "github") ||
        name.toLowerCase() === prefix || name.toLowerCase().includes(prefix);
    });

    if (matches.length !== 1) {
      const choices = (matches.length ? matches : schedules).map(({ id, name }) =>
        schedules.filter((schedule) => schedule.name === name).length > 1 ? id : name,
      );
      if (!choices.length) {
        return { message: "This Viber has no schedules to change." };
      }
      return { message: `Which schedule? ${choices.map((choice) => `“${choice}”`).join(", ")}.`, clarification: { kind: "target", change, choices } };
    }

    const schedule = matches[0];
    let { cadence, instructions, name, next_run_at: dueAt, status } = schedule;
    switch (change.action) {
      case "pause":
        status = "paused";
        dueAt = null;
        break;
      case "cancel":
        status = "cancelled";
        dueAt = null;
        break;
      case "resume":
        if (status !== "paused") {
          return { message: `“${name}” is ${scheduleStatusLabel[status].toLowerCase()}.` };
        }
        status = schedule.task.kind === "github" ? "pending" : "active";
        dueAt = schedule.task.kind === "github" ? time : nextRun(cadence, time);
        break;
      case "edit":
        if (!change.value) {
          return {
            message: `What should I change about “${name}”? You can change its name or cadence, or update what a reminder says.`,
            clarification: { kind: "edit", target: schedule.id },
          };
        }
        if (change.field === "name") {
          name = change.value.slice(0, 100);
        } else if (change.field === "instructions") {
          if (schedule.task.kind !== "reminder") {
            return { message: "You can change this watch’s name or polling cadence. For a different PR scope, create a watch for that scope." };
          }
          instructions = reminderInstructions(change.value);
        } else {
          const parsed = parseScheduleTime(change.value, time);
          if ("error" in parsed) {
            return { message: parsed.error, clarification: { kind: "edit", target: schedule.id } };
          }
          if (schedule.task.kind === "github" && parsed.cadence.kind !== "interval") {
            return { message: "Give me the number of minutes or hours between GitHub checks." };
          }
          cadence = parsed.cadence;
          if (dueAt !== null) {
            dueAt = nextRun(cadence, time);
          }
        }
        break;
    }

    if (this.inFlight?.id === schedule.id) {
      this.inFlight.controller.abort();
    }
    this.db.run(
      `UPDATE viber_schedules SET name=?,instructions=?,cadence=?,next_run_at=?,status=?,revision=revision+1
       WHERE id=? AND profile_id=?`,
      name, instructions, JSON.stringify(cadence), dueAt, status, schedule.id, profileId,
    );
    return { message: `“${name}” is ${change.action === "edit" ? "updated" : scheduleStatusLabel[status].toLowerCase()}.` };
  };

  private runDue = async () => {
    const due = this.db.all<{ id: string }>(
      `SELECT id FROM viber_schedules WHERE ${runnable} AND next_run_at<=?
       AND EXISTS (SELECT 1 FROM viber_sessions WHERE profile_id=viber_schedules.profile_id)
       AND NOT EXISTS (SELECT 1 FROM retired_viber_profiles WHERE profile_id=viber_schedules.profile_id)
       ORDER BY next_run_at,rowid`,
      Date.now(),
    );
    for (const { id } of due) {
      if (!this.started || !this.canRun()) {
        return;
      }

      const [row] = this.db.all<ScheduleRow & { session_id: string }>(
        `SELECT schedule.*,session.id AS session_id FROM viber_schedules schedule
         JOIN viber_sessions session ON session.profile_id=schedule.profile_id
         WHERE schedule.id=? AND ${runnable} AND next_run_at<=?
         AND NOT EXISTS (SELECT 1 FROM retired_viber_profiles WHERE profile_id=schedule.profile_id)`,
        id,
        Date.now(),
      );
      if (row) {
        await this.run(row);
      }
    }
  };

  private run = async (row: ScheduleRow & { session_id: string }) => {
    const schedule = unpack(row);
    const controller = new AbortController();
    this.inFlight = { id: row.id, controller };
    let result: ScheduleOutcome;
    try {
      result = schedule.task.kind === "reminder"
        ? {
          status: schedule.cadence.kind === "once" ? "completed" : "active",
          message: `**Reminder**\n\n${schedule.instructions}`,
        }
        : await this.checkGitHub(row, schedule.task, AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]));
    } catch {
      result = { status: "retrying", error: "GitHub is unavailable or returned incomplete data. The watch will retry." };
    } finally {
      this.inFlight = undefined;
    }
    if (controller.signal.aborted || !this.canRun()) {
      return;
    }

    const dueAt = result.status === "completed"
      ? null
      : result.status === "active"
        ? nextRun(schedule.cadence, Date.now())
        : Date.now() + minDelay;
    const committed = this.db.transaction(() => {
      const update = this.db.run(
        `UPDATE viber_schedules SET status=?,next_run_at=?,cursor=coalesce(?,cursor),account=coalesce(?,account),error=?
         WHERE id=? AND revision=? AND ${runnable} AND NOT EXISTS
          (SELECT 1 FROM retired_viber_profiles WHERE profile_id=viber_schedules.profile_id)`,
        result.status, dueAt, result.cursor ?? null, result.account ?? null, result.error ?? null,
        row.id, row.revision,
      );
      if (update.changes && result.message) {
        this.post(row.session_id, result.message, "schedule_notification");
      }
      return update.changes > 0;
    });
    if (committed) {
      this.changed();
    }
  };

  private checkGitHub = async (
    row: ScheduleRow,
    task: Extract<ScheduleTask, { kind: "github" }>,
    signal: AbortSignal,
  ): Promise<ScheduleOutcome> => {
    const auth = await this.client.detect(signal);
    signal.throwIfAborted();
    const account = auth.username?.toLowerCase();
    if (!auth.connected || !account || (row.account && row.account !== account)) {
      if (auth.installed && !auth.connected && auth.error && !/HTTP 401|bad credentials/i.test(auth.error)) {
        return { status: "retrying", error: "Could not check GitHub sign-in. The watch will retry." };
      }
      const message = row.account && row.account !== account
        ? `“${row.name}” needs its original GitHub account. Please reconnect it from **Providers → GitHub**.`
        : auth.installed
          ? `“${row.name}” is waiting for GitHub access. ${signIn}`
          : `“${row.name}” needs the GitHub CLI in the execution environment. After installing it, ${signIn.replace("Please ", "please ")}`;
      return { status: "blocked_sign_in", error: message, message: row.status === "blocked_sign_in" ? undefined : message };
    }

    const result = await checkScheduledPullRequests(this.client, task, account, row.cursor, signal);
    signal.throwIfAborted();
    return {
      ...result,
      account,
      status: result.completed ? "completed" : "active",
    };
  };

  private post = (
    sessionId: string,
    content: string,
    kind: "schedule_chat" | "schedule_notification",
    clarification?: ScheduleClarification,
  ) => {
    this.db.run(
      `INSERT INTO viber_messages(id,session_id,role,content,status,configuration,created_at,effects)
       VALUES(?,?,'assistant',?,'completed',?,?,'none')`,
      randomUUID(), sessionId, content, JSON.stringify({ kind, schedule_clarification: clarification }), now(),
    );
  };
}
