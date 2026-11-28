import { minimumScheduleMinutes, type Cadence } from "./schedule-contracts";

type Change = {
  action: "pause" | "resume" | "cancel" | "edit";
  target: string;
  value?: string;
  field?: "name" | "instructions" | "cadence";
};

export type ScheduleClarification =
  | { kind: "reminder"; request: string }
  | { kind: "watch" | "watch_cadence"; request: string }
  | { kind: "edit"; target: string }
  | { kind: "target"; change: Change; choices: string[] };

export type ScheduleIntent =
  | { action: "reminder" | "watch"; request: string }
  | { action: "list" }
  | Change;

const clean = (text: string) => text.trim().replace(/[.!?]+$/, "").trim();
const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const duration = /\b(every|in)\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)\b/i;
const clock =
  /\b(?:(every\s+weekdays?|weekdays|daily|every\s+day|every\s+(?:sun|mon|tues|wednes|thurs|fri|satur)day|tomorrow|today)\s+)?at\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?=\s|$)/i;

export const parseScheduleTime = (
  text: string,
  time: number,
): { cadence: Cadence; rest: string } | { error: string } => {
  const normalized = clean(text)
    .replace(/(at\s+\d{1,2}(?::\d{2})?(?:\s+[ap]m)?)\s+(every weekday|daily|every day)\b/i, "$2 $1");
  const match = normalized.match(duration);
  if (match) {
    const minutes = Number(match[2]) * (/^(?:hour|hr)/i.test(match[3]) ? 60 : 1);
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 525600) {
      return { error: "Choose a duration between one minute and one year." };
    }
    if (match[1].toLowerCase() === "every" && minutes < minimumScheduleMinutes) {
      return { error: "Recurring schedules need at least 5 minutes between runs. What cadence should I use?" };
    }
    const cadence: Cadence = match[1].toLowerCase() === "every"
      ? { kind: "interval", minutes }
      : { kind: "once", at: time + minutes * 60000 };
    return { cadence, rest: clean(normalized.replace(match[0], " ")) };
  }

  const local = normalized.match(clock);
  if (!local) {
    return { error: "What time or cadence should I use?" };
  }
  const [, rawDay, rawHour, rawMinute, meridiem] = local;
  if (!rawDay && /\b(?:every|each)\b/i.test(normalized)) {
    return { error: "Which days should this repeat?" };
  }
  if (Number(rawHour) > 0 && Number(rawHour) <= 12 && !rawMinute && !meridiem) {
    return { error: "Did you mean AM or PM? Please include the time." };
  }
  const hour = Number(rawHour);
  const minute = Number(rawMinute ?? 0);
  if (hour > 23 || minute > 59 || (meridiem && (hour < 1 || hour > 12))) {
    return { error: "What valid time should I use?" };
  }

  const day = rawDay?.toLowerCase();
  const hours = meridiem ? (hour % 12) + (/^p/i.test(meridiem) ? 12 : 0) : hour;
  const weekday = days.indexOf(day?.replace(/^every\s+/, "") ?? "");
  const candidate = new Date(time);
  candidate.setHours(hours, minute, 0, 0);
  let cadence: Cadence;
  if (day && day !== "today" && day !== "tomorrow") {
    cadence = {
      kind: "clock",
      hour: hours,
      minute,
      ...(day.includes("weekday") ? { weekdays: true } : {}),
      ...(weekday >= 0 ? { day: weekday } : {}),
    };
  } else {
    if (day === "tomorrow" || (!day && candidate.getTime() <= time)) {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(hours, minute, 0, 0);
    }
    if (candidate.getTime() <= time) {
      return { error: "That time has passed. When should I remind you?" };
    }
    cadence = { kind: "once", at: candidate.getTime() };
  }

  return { cadence, rest: clean(normalized.replace(local[0], " ")) };
};

export const reminderInstructions = (value: string) =>
  clean(value.replace(/^\s*(?:to\s+)?/, "").replace(/\s+/g, " "));

export const parseScheduleIntent = (
  content: string,
  clarification?: ScheduleClarification,
): ScheduleIntent | null => {
  const text = clean(content).replace(/^(?:please\s+|(?:can|could|would|will) you\s+)/i, "");
  const reminder = text.match(/^(?:remind me\b|(?:set(?: up)?|create|schedule) (?:me )?an? reminder\b)\s*(.*)/i);
  if (reminder && !/^(?:how|why|what|who|where|whether)\b/i.test(reminder[1])) {
    return { action: "reminder", request: reminder[1] };
  }

  const thing = "(?:active |upcoming )?(?:schedules?|reminders?|watches?|(?:PR|pull request) watches?)";
  if (new RegExp(`^(?:(?:show|list|tell) me (?:all )?|(?:list|show) (?:all )?|what (?:are|about) (?:all )?|what have you )(?:(?:my|your|the) )?${thing}(?: (?:do I have|for me|here))?$`, "i").test(text)
    || new RegExp(`^what ${thing} (?:do I have|are (?:active|running|scheduled))$`, "i").test(text)) {
    return { action: "list" };
  }

  const change = text.match(/^(pause|resume|restart|cancel|remove|delete|stop|edit|change|move|reschedule|rename)\s+(.+)/i);
  if (change && /\b(?:reminders?|schedules?|watch(?:es)?|watching|PR reviews?)\b/i.test(change[2])) {
    const [, verb, rest] = change;
    const target = rest.replace(/^watching\s+(?:my\s+)?(?:PRs?|pull requests?)$/i, "PR reviews");
    if (/^(pause|resume|restart|cancel|remove|delete|stop)$/i.test(verb)) {
      const action = /pause/i.test(verb) ? "pause" : /resume|restart/i.test(verb) ? "resume" : "cancel";
      return { action, target };
    }

    const update = /rename/i.test(verb)
      ? target.match(/^(.+?)\s+to\s+(.+)$/i)
      : target.match(/^(.+?)\s+(?:to\s+)?((?:every|in|at|daily|weekdays|tomorrow|today|say)\b.*)$/i);
    if (!update) {
      return { action: "edit", target };
    }
    const [, name, value] = update;
    return /rename/i.test(verb)
      ? { action: "edit", target: name, field: "name", value }
      : /^say\s+/i.test(value)
        ? { action: "edit", target: name, field: "instructions", value: value.replace(/^say\s+/i, "") }
        : { action: "edit", target: name, field: "cadence", value };
  }

  if (
    /^(?:keep an eye on|watch|monitor|track|(?:let me know|tell me|notify me|alert me) (?:when|whenever))\b/i.test(text) &&
    /\b(?:PRs?|pull requests?|review requests?|needs? (?:my review|me to review))\b|github\.com\//i.test(text)
  ) {
    return { action: "watch", request: text };
  }

  if (clarification?.kind === "target") {
    const target = text.replace(/^["“']|["”']$/g, "");
    if (clarification.choices.some((choice) => choice.toLowerCase() === target.toLowerCase())) {
      return { ...clarification.change, target };
    }
  }

  if (clarification?.kind === "reminder") {
    const time = /^\d{1,2}(?::\d{2})?\s*[ap]m$/i.test(text) ? `at ${text}` : text;
    if (/^(?:every|in|at|daily|weekdays|tomorrow|today)\b/i.test(time)) {
      const prior = clarification.request.replace(duration, "").replace(clock, "").trim();
      return { action: "reminder", request: `${time} ${prior}`.trim() };
    }
    if (/^to\s+\S/i.test(text)) {
      return { action: "reminder", request: `${clarification.request} ${text}`.trim() };
    }
  }

  if (clarification?.kind === "watch" &&
      /^(?:my (?:PRs|pull requests|review requests)|https:\/\/github\.com\/[^\s]+|[\w.-]+\/[\w.-]+)$/i.test(text)) {
    const scope = /^[\w.-]+\/[\w.-]+$/.test(text) ? `in ${text}` : text;
    return { action: "watch", request: `${clarification.request} ${scope}` };
  }

  if (clarification?.kind === "watch_cadence" && /^every\s+/i.test(text)) {
    return { action: "watch", request: `${clarification.request} ${text}` };
  }

  if (clarification?.kind === "edit") {
    const update = text.match(/^(?:to\s+)?(?:(rename to|say)\s+)?(.+)$/i);
    if (update && (update[1] || /^(?:every|in|at|daily|weekdays|tomorrow|today)\b/i.test(update[2]))) {
      return {
        action: "edit",
        target: clarification.target,
        field: /^rename/i.test(update[1] ?? "") ? "name" : update[1] ? "instructions" : "cadence",
        value: update[2],
      };
    }
  }

  return null;
};
