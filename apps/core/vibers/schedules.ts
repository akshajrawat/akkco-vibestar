import { randomUUID } from "node:crypto";
import { z } from "zod";

import { AdeError, now } from "../domain";
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
import type { ScheduleProposal } from "./schedule-operation";
import { nextScheduleRun, scheduleTimezone } from "./schedule-time";
import { scheduleRequestDigest, ViberSessionStore } from "./store";

type SendRequest = z.output<typeof ViberSessionSendSchema>;

interface ScheduleRow extends Omit<ViberSchedule, "task" | "cadence"> {
  task: string;
  cadence: string;
  profile_id: string;
  revision: number;
  cursor: string | null;
  account: string | null;
  claim: string | null;
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
  clarify?: boolean;
}

const minDelay = minimumScheduleMinutes * 60000;
const runtimeNote = "Runs while the Vibestar engine is running and your device is awake.";
const signIn = "Connect from **Providers → GitHub → Connect GitHub**.";

const runnable =
  "next_run_at IS NOT NULL AND status IN ('pending','active','blocked_sign_in','retrying')";

const scheduleTiming = (proposal: ScheduleProposal, time: number, existing?: ViberSchedule) => {
  const timezone = scheduleTimezone(proposal.timezone ?? existing?.timezone);
  const previous = existing?.cadence;

  const hasClockFields = [proposal.hour, proposal.minute, proposal.weekday, proposal.weekdays].some(
    (field) => field !== undefined,
  );

  const timingKinds = [
    proposal.at === undefined ? undefined : "once",
    proposal.minutes === undefined ? undefined : "interval",
    hasClockFields ? "clock" : undefined,
  ].filter((kind) => kind !== undefined);

  const kind = proposal.cadence ?? timingKinds[0];
  if (timingKinds.some((fieldKind) => fieldKind !== kind)) {
    throw new Error("Should this run once or repeat?");
  }

  let cadence = previous;
  switch (kind) {
    case "once": {
      const at =
        proposal.at === undefined && previous?.kind === "once"
          ? previous.at
          : Date.parse(proposal.at ?? "");

      if (
        (proposal.at !== undefined &&
          !z.iso.datetime({ offset: true }).safeParse(proposal.at).success) ||
        !Number.isFinite(at) ||
        at <= time
      ) {
        throw new Error("What future date and time should I use?");
      }

      cadence = { kind: "once", at };
      break;
    }

    case "interval": {
      const minutes =
        proposal.minutes ?? (previous?.kind === "interval" ? previous.minutes : undefined);

      if (
        minutes === undefined ||
        !Number.isInteger(minutes) ||
        minutes < minimumScheduleMinutes ||
        minutes > 525600
      ) {
        throw new Error(
          "What interval should I use? Recurring schedules need at least five minutes between runs.",
        );
      }

      cadence = { kind: "interval", minutes };
      break;
    }

    case "clock": {
      const clock = previous?.kind === "clock" ? previous : undefined;
      const hour = proposal.hour ?? clock?.hour;
      const minute = proposal.minute ?? clock?.minute;

      const weekday =
        proposal.weekday ?? (proposal.weekdays === undefined ? clock?.day : undefined);

      const weekdays =
        proposal.weekdays ?? (proposal.weekday === undefined ? clock?.weekdays : undefined);

      if (
        hour === undefined ||
        !Number.isInteger(hour) ||
        hour < 0 ||
        hour > 23 ||
        minute === undefined ||
        !Number.isInteger(minute) ||
        minute < 0 ||
        minute > 59 ||
        (weekday !== undefined &&
          (!Number.isInteger(weekday) || weekday < 0 || weekday > 6 || weekdays))
      ) {
        throw new Error("What local time and days should I use?");
      }

      cadence = {
        kind: "clock",
        hour,
        minute,
        ...(weekday !== undefined ? { day: weekday } : {}),
        ...(weekdays ? { weekdays: true } : {}),
      };

      break;
    }
  }

  if (!cadence) {
    throw new Error("When should this run?");
  }

  return { cadence, timezone, changed: kind !== undefined || proposal.timezone !== undefined };
};

const unpack = (row: ScheduleRow): ViberSchedule => ({
  id: row.id,
  name: row.name,
  instructions: row.instructions,
  task: JSON.parse(row.task) as ScheduleTask,
  cadence: JSON.parse(row.cadence) as Cadence,
  timezone: row.timezone,
  error: row.error,
  next_run_at: row.next_run_at,
  status: row.status,
});

const pullUrl = (value: string) => canonicalPullRequest(value.split(/[?#]/, 1)[0]).url;

const normalizeTarget = (text: string) =>
  text
    .trim()
    .replace(/^(?:the|my)\s+/i, "")
    .replace(/^["“']|["”']$/g, "")
    .toLowerCase();

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
    private readonly instruct: (
      profileId: string,
      sessionId: string,
      instructions: string,
      signal: AbortSignal,
    ) => Promise<string>,
  ) {}

  start = () => {
    this.db.run("UPDATE viber_schedules SET claim=NULL WHERE claim IS NOT NULL");
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
      `SELECT next_run_at FROM viber_schedules WHERE claim IS NULL AND ${runnable}
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
    this.db
      .all<ScheduleRow>(
        `SELECT * FROM viber_schedules WHERE profile_id=?
       AND NOT EXISTS (SELECT 1 FROM retired_viber_profiles WHERE profile_id=?)
       ORDER BY status IN ('completed','cancelled'), name COLLATE NOCASE, rowid`,
        profileId,
        profileId,
      )
      .map(unpack);

  cancelForProfile = (profileId: string) => {
    const running = this.inFlight;
    if (
      running &&
      this.db.all(
        "SELECT id FROM viber_schedules WHERE id=? AND profile_id=?",
        running.id,
        profileId,
      ).length
    ) {
      running.controller.abort();
    }

    this.db.run(
      "UPDATE viber_schedules SET status='cancelled',next_run_at=NULL,claim=NULL,revision=revision+1 WHERE profile_id=? AND status NOT IN ('completed','cancelled')",
      profileId,
    );
  };

  clarification = (sessionId: string) => {
    const [row] = this.db.all<{ clarification: string | null }>(
      `SELECT json_extract(configuration,'$.clarification') AS clarification FROM viber_messages
       WHERE session_id=? AND timeline_kind IS NOT 'schedule_notification'
       ORDER BY rowid DESC LIMIT 1`,
      sessionId,
    );

    return row?.clarification
      ? (JSON.parse(row.clarification) as { request: string; question: string })
      : undefined;
  };

  apply = (input: SendRequest, proposal: ScheduleProposal) => {
    const store = new ViberSessionStore(this.db);
    const previous = store.previous(input);
    if (previous) {
      return previous;
    }

    this.db.transaction(() => {
      store.writableSession(input.session_id, input.profile_id);
      const timestamp = now();
      const content = redact(input.content);
      const reply = this.reply(input.profile_id, proposal);

      this.db.run(
        `INSERT INTO viber_messages(id,session_id,role,content,status,configuration,created_at,effects,timeline_kind)
         VALUES(?,?,'user',?,'completed',?,?,'none','schedule_chat')`,
        input.request_id,
        input.session_id,
        content,
        JSON.stringify({ request_digest: scheduleRequestDigest(input) }),
        timestamp,
      );

      this.post(
        input.session_id,
        reply.message,
        "schedule_chat",
        reply.clarify ? { request: content, question: reply.message } : undefined,
      );

      this.db.run(
        `UPDATE viber_sessions SET updated_at=?,title=CASE
           WHEN NOT EXISTS(SELECT 1 FROM viber_messages WHERE session_id=? AND id<>? AND role='user')
           THEN ? ELSE title END WHERE id=?`,
        timestamp,
        input.session_id,
        input.request_id,
        content.slice(0, 90),
        input.session_id,
      );
    });

    this.changed();
    this.wake();
    return store.previous(input)!;
  };

  private reply = (profileId: string, proposal: ScheduleProposal): ScheduleReply => {
    const time = Date.now();
    switch (proposal.action) {
      case "clarify":
        return {
          message: redact(proposal.question?.slice(0, 500) || "What should I schedule?"),
          clarify: true,
        };
      case "create":
        return this.create(profileId, proposal, time);
      case "list": {
        const schedules = this.list(profileId);
        return {
          message: schedules.length
            ? schedules
                .map(
                  (schedule) =>
                    `- **${schedule.name}** · ${scheduleCadenceLabel(schedule)} · ${scheduleStatusLabel[schedule.status]}${schedule.next_run_at === null ? "" : ` · next ${this.formatTime(schedule.next_run_at, schedule.timezone)}`}`,
                )
                .join("\n")
            : "This Viber has no schedules.",
        };
      }

      default:
        return this.change(profileId, proposal, time);
    }
  };

  private formatTime = (at: number, timezone: string) =>
    new Date(at).toLocaleString(undefined, { timeZone: timezone, timeZoneName: "short" });

  private create = (profileId: string, proposal: ScheduleProposal, time: number): ScheduleReply => {
    const name = redact(proposal.name?.trim().slice(0, 100) ?? "");
    const instructions = redact(proposal.instructions?.trim().slice(0, 32000) ?? "");
    if (!name || !instructions || !proposal.task) {
      return { message: "What should this schedule do?", clarify: true };
    }

    let task: ScheduleTask;
    if (proposal.task === "github") {
      const repository = proposal.repository?.toLowerCase();
      if (
        repository &&
        (!/^[\w.-]+\/[\w.-]+$/.test(repository) ||
          repository.split("/").some((part) => part === "." || part === ".."))
      ) {
        return {
          message: "Which GitHub repository should I monitor? Use owner/repository.",
          clarify: true,
        };
      }

      try {
        task = {
          kind: "github",
          ...(proposal.pull ? { pull: pullUrl(proposal.pull) } : repository ? { repository } : {}),
          events: proposal.events ?? "all",
        };
      } catch {
        return {
          message: "Which pull request should I monitor? Send its GitHub URL.",
          clarify: true,
        };
      }
    } else {
      task = { kind: proposal.task };
    }

    let timing;
    try {
      timing = scheduleTiming(proposal, time);
    } catch (error) {
      return {
        message:
          error instanceof RangeError
            ? "Which IANA timezone should I use?"
            : (error as Error).message,
        clarify: true,
      };
    }

    const { cadence, timezone } = timing;
    if (task.kind === "github" && cadence.kind === "once") {
      return { message: "How often should I check GitHub?", clarify: true };
    }

    const duplicate = this.list(profileId).find(
      (schedule) =>
        schedule.status !== "completed" &&
        schedule.status !== "cancelled" &&
        schedule.timezone === timezone &&
        JSON.stringify(schedule.task) === JSON.stringify(task) &&
        JSON.stringify(schedule.cadence) === JSON.stringify(cadence) &&
        (task.kind === "github" || schedule.instructions === instructions),
    );

    if (duplicate) {
      return { message: `“${duplicate.name}” is already saved for this Viber.` };
    }

    const github = task.kind === "github";
    const dueAt = github ? time : nextScheduleRun(cadence, time, timezone);

    this.db.run(
      "INSERT INTO viber_schedules(id,profile_id,name,instructions,task,cadence,timezone,next_run_at,status) VALUES(?,?,?,?,?,?,?,?,?)",
      randomUUID(),
      profileId,
      name,
      instructions,
      JSON.stringify(task),
      JSON.stringify(cadence),
      timezone,
      dueAt,
      github ? "pending" : "active",
    );

    return {
      message: github
        ? `Saved “${name}.” I’ll check GitHub access and record the current state before sending updates. ${runtimeNote}`
        : `Saved “${name}.” Next run is ${this.formatTime(dueAt, timezone)}. ${runtimeNote}`,
    };
  };

  private change = (profileId: string, proposal: ScheduleProposal, time: number): ScheduleReply => {
    const target = normalizeTarget(proposal.target ?? "");

    const schedules = this.list(profileId).filter(
      ({ status }) => status !== "completed" && status !== "cancelled",
    );

    const number = /^(?:pr\s*)?#?(\d+)$/.exec(target)?.[1];
    let targetUrl: string | undefined;
    if (target.startsWith("https://")) {
      try {
        targetUrl = pullUrl(target);
      } catch {
        // Match a literal schedule name even when it resembles a URL.
      }
    }

    const matches = number
      ? schedules.filter(
          ({ task }) =>
            task.kind === "github" &&
            task.pull &&
            canonicalPullRequest(task.pull).number === Number(number),
        )
      : schedules.filter(
          ({ name, id, task }) =>
            name.toLowerCase() === target ||
            id === target ||
            (targetUrl && task.kind === "github" && task.pull === targetUrl),
        );

    if (matches.length !== 1) {
      const choices = (matches.length ? matches : schedules).map(({ id, name, task }) => {
        if (task.kind === "github" && task.pull) {
          const samePull = schedules.filter(
            (schedule) => schedule.task.kind === "github" && schedule.task.pull === task.pull,
          );

          return samePull.length === 1 ? task.pull : `${name} (${id})`;
        }

        return schedules.filter((schedule) => schedule.name.toLowerCase() === name.toLowerCase())
          .length > 1
          ? `${name} (${id})`
          : name;
      });

      return choices.length
        ? {
            message: `Which schedule? ${choices.map((choice) => `“${choice}”`).join(", ")}.`,
            clarify: true,
          }
        : { message: "This Viber has no schedules to change." };
    }

    const schedule = matches[0];
    let { cadence, timezone, instructions, name, next_run_at: dueAt, status, error } = schedule;
    switch (proposal.action) {
      case "pause":
        status = "paused";
        dueAt = null;
        break;
      case "cancel":
        status = "cancelled";
        dueAt = null;
        break;
      case "resume":
        if (status !== "paused" && status !== "blocked_sign_in") {
          return { message: `“${name}” is ${scheduleStatusLabel[status].toLowerCase()}.` };
        }

        status = schedule.task.kind === "github" ? "pending" : "active";
        dueAt = schedule.task.kind === "github" ? time : nextScheduleRun(cadence, time, timezone);
        error = null;
        break;
      case "edit": {
        let timing;
        try {
          timing = scheduleTiming(proposal, time, schedule);
        } catch (timingError) {
          return {
            message:
              timingError instanceof RangeError
                ? "Which IANA timezone should I use?"
                : (timingError as Error).message,
            clarify: true,
          };
        }

        if (!proposal.name && !proposal.instructions && !timing.changed) {
          return { message: `What should I change about “${name}”?`, clarify: true };
        }

        if (
          schedule.task.kind === "github" &&
          (proposal.instructions || timing.cadence.kind === "once")
        ) {
          return { message: "You can change this GitHub schedule’s name, cadence, or timezone." };
        }

        ({ cadence, timezone } = timing);
        name = redact(proposal.name?.trim().slice(0, 100) || name);
        instructions = redact(proposal.instructions?.trim().slice(0, 32000) || instructions);
        if ((status === "active" || status === "retrying") && timing.changed) {
          dueAt = nextScheduleRun(cadence, time, timezone);
          status = "active";
          error = null;
        }

        break;
      }

      default:
        throw new Error("Unsupported schedule operation.");
    }

    if (this.inFlight?.id === schedule.id) {
      this.inFlight.controller.abort();
    }

    this.db.run(
      `UPDATE viber_schedules SET name=?,instructions=?,cadence=?,timezone=?,next_run_at=?,status=?,error=?,claim=NULL,revision=revision+1
       WHERE id=? AND profile_id=?`,
      name,
      instructions,
      JSON.stringify(cadence),
      timezone,
      dueAt,
      status,
      error,
      schedule.id,
      profileId,
    );

    return {
      message: `“${name}” is ${proposal.action === "edit" ? "updated" : scheduleStatusLabel[status].toLowerCase()}.`,
    };
  };

  private runDue = async () => {
    const due = this.db.all<{ id: string }>(
      `SELECT id FROM viber_schedules WHERE claim IS NULL AND ${runnable} AND next_run_at<=?
       AND EXISTS (SELECT 1 FROM viber_sessions WHERE profile_id=viber_schedules.profile_id)
       AND NOT EXISTS (SELECT 1 FROM retired_viber_profiles WHERE profile_id=viber_schedules.profile_id)
       ORDER BY next_run_at,rowid`,
      Date.now(),
    );

    for (const { id } of due) {
      if (!this.started || !this.canRun()) {
        return;
      }

      const claim = randomUUID();

      const row = this.db.transaction(() => {
        const updated = this.db.run(
          `UPDATE viber_schedules SET claim=?
           WHERE id=? AND claim IS NULL AND ${runnable} AND next_run_at<=?
           AND EXISTS (SELECT 1 FROM viber_sessions WHERE profile_id=viber_schedules.profile_id)
           AND NOT EXISTS (SELECT 1 FROM retired_viber_profiles WHERE profile_id=viber_schedules.profile_id)`,
          claim,
          id,
          Date.now(),
        );

        if (updated.changes) {
          return this.db.all<ScheduleRow & { session_id: string }>(
            `SELECT schedule.*,session.id AS session_id FROM viber_schedules schedule
             JOIN viber_sessions session ON session.profile_id=schedule.profile_id WHERE schedule.id=?`,
            id,
          )[0];
        }
      });

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
      const signal =
        schedule.task.kind === "github"
          ? AbortSignal.any([controller.signal, AbortSignal.timeout(60000)])
          : controller.signal;

      if (schedule.task.kind === "github") {
        result = await this.checkGitHub(row, schedule.task, signal);
      } else {
        const message =
          schedule.task.kind === "reminder"
            ? `**Reminder**\n\n${schedule.instructions}`
            : await this.instruct(row.profile_id, row.session_id, schedule.instructions, signal);

        result = {
          status: schedule.cadence.kind === "once" ? "completed" : "active",
          message,
        };
      }
    } catch (error) {
      if (
        error instanceof AdeError &&
        error.kind === "not_found" &&
        schedule.task.kind === "github"
      ) {
        result = {
          status: "paused",
          error: "GitHub could not find this pull request or grant access to it.",
          message: `“${schedule.name}” is paused. GitHub could not find this pull request or grant access to it. Check the URL and account before resuming.`,
        };
      } else {
        result = {
          status: "retrying",
          error:
            schedule.task.kind === "github"
              ? "GitHub is unavailable or returned incomplete data. The schedule will retry."
              : redact(error instanceof Error ? error.message : String(error)).slice(0, 500),
        };
      }
    } finally {
      this.inFlight = undefined;
    }

    if (controller.signal.aborted || !this.canRun()) {
      this.db.run(
        "UPDATE viber_schedules SET claim=NULL WHERE id=? AND claim=?",
        row.id,
        row.claim,
      );

      return;
    }

    const time = Date.now();

    const dueAt =
      result.status === "completed" || result.status === "paused"
        ? null
        : result.status === "active"
          ? nextScheduleRun(
              schedule.cadence,
              schedule.cadence.kind === "clock" ? time + minDelay - 1 : time,
              schedule.timezone,
            )
          : time + minDelay;

    const committed = this.db.transaction(() => {
      const update = this.db.run(
        `UPDATE viber_schedules SET status=?,next_run_at=?,cursor=coalesce(?,cursor),account=coalesce(?,account),error=?,claim=NULL
         WHERE id=? AND profile_id=? AND claim=? AND revision=? AND cursor IS ? AND next_run_at IS ? AND ${runnable} AND NOT EXISTS
          (SELECT 1 FROM retired_viber_profiles WHERE profile_id=viber_schedules.profile_id)`,
        result.status,
        dueAt,
        result.cursor ?? null,
        result.account ?? null,
        result.error ?? null,
        row.id,
        row.profile_id,
        row.claim,
        row.revision,
        row.cursor,
        row.next_run_at,
      );

      if (!update.changes) {
        this.db.run(
          "UPDATE viber_schedules SET claim=NULL WHERE id=? AND claim=?",
          row.id,
          row.claim,
        );

        return false;
      }

      if (result.message) {
        this.post(row.session_id, result.message, "schedule_notification");
      }

      return true;
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
      if (
        auth.installed &&
        !auth.connected &&
        auth.error &&
        !/HTTP 401|bad credentials/i.test(auth.error)
      ) {
        return {
          status: "retrying",
          error: "Could not check GitHub sign-in. The watch will retry.",
        };
      }

      const message =
        row.account && row.account !== account
          ? `“${row.name}” needs its original GitHub account. Please reconnect it from **Providers → GitHub**.`
          : auth.installed
            ? `“${row.name}” is waiting for GitHub access. ${signIn}`
            : `“${row.name}” needs the GitHub CLI in the execution environment. ${signIn}`;

      return {
        status: "blocked_sign_in",
        error: message,
        message: row.status === "blocked_sign_in" ? undefined : message,
      };
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
    clarification?: { request: string; question: string },
  ) => {
    this.db.run(
      `INSERT INTO viber_messages(id,session_id,role,content,status,configuration,created_at,effects,timeline_kind)
       VALUES(?,?,'assistant',?,'completed',?,?,'none',?)`,
      randomUUID(),
      sessionId,
      redact(content),
      clarification ? JSON.stringify({ clarification }) : null,
      now(),
      kind,
    );
  };
}
