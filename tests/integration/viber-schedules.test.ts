import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { Engine } from "../../apps/core/execution/engine";
import { CodexProvider } from "../../apps/core/execution/providers/codex";
import type { AgentRunRequest } from "../../apps/core/execution/providers/contracts";
import { GitHubClient } from "../../apps/core/github/client";
import { Rpc } from "../../apps/core/rpc";
import type { ViberMessage, ViberSession } from "../../apps/core/vibers/contracts";
import type { ScheduleProposal } from "../../apps/core/vibers/schedule-operation";
import type { ViberSchedule } from "../../apps/core/vibers/schedule-contracts";
import { createTestProfiles, testProfileIds } from "../helpers/viber-fixtures";
import { detectFixtureProvider } from "../helpers/fixtures";

const profileId = testProfileIds.implementer;
const selection = { provider: "codex", model: "next-model", effort: "high" } as const;
const monitor = "Keep an eye on my PRs and tell me when a reviewer asks for changes";
const remind = "Remind me tomorrow at 9 to send the demo";
const pull = "https://github.com/owner/example/pull/10";

const tomorrow = () => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 1);
  date.setUTCHours(9, 0, 0, 0);
  return date.toISOString();
};

const githubProposal = (url?: string): ScheduleProposal => ({
  action: "create",
  name: "Review updates",
  instructions: monitor,
  task: "github",
  ...(url ? { pull: url } : { events: "changes_requested" }),
  cadence: "interval",
  minutes: 5,
});

class ScheduleProvider extends CodexProvider {
  detect = detectFixtureProvider;

  calls: AgentRunRequest[] = [];

  proposals = new Map<string, ScheduleProposal | (() => ScheduleProposal)>([
    [monitor, githubProposal()],
    [
      remind,
      () => ({
        action: "create",
        name: "Send the demo",
        instructions: "Send the demo",
        task: "reminder",
        cadence: "once",
        at: tomorrow(),
        timezone: "UTC",
      }),
    ],
    ["What schedules are running?", { action: "list" }],
    ["Monitor this PR", githubProposal(pull)],
    ["Cancel PR 10", { action: "cancel", target: "#10" }],
  ]);

  invocation = (request: AgentRunRequest) => {
    this.calls.push(request);

    const prompt = request.interpretSchedule
      ? (JSON.parse(request.prompt.split("\n").at(-1)!) as { message: string })
      : undefined;

    const proposal = prompt ? this.proposals.get(prompt.message) : undefined;

    const reply = prompt
      ? JSON.stringify(
          typeof proposal === "function" ? proposal() : (proposal ?? { action: "chat" }),
        )
      : request.conversation
        ? "Foreground answer"
        : JSON.stringify({ summary: "Scheduled answer" });

    return {
      program: process.execPath,
      input: "",
      args: [
        "-e",
        [
          { type: "thread.started", thread_id: request.conversation?.threadId ?? request.runId },
          { type: "item.completed", item: { type: "agent_message", text: reply } },
          { type: "turn.completed" },
        ]
          .map((event) => `console.log(${JSON.stringify(JSON.stringify(event))})`)
          .join(";"),
      ],
    };
  };
}

class ScheduleGitHub extends GitHubClient {
  connected = true;

  attention: string[] = [pull];

  gate?: Promise<void>;

  calls: AbortSignal[] = [];

  decision = "APPROVED";

  mergeable = "CONFLICTING";

  head = "first";

  detect = async () => ({
    installed: true,
    version: "fixture",
    connected: this.connected,
    username: this.connected ? "owner" : null,
    error: null,
  });

  graphql = async (query: string, variables: Record<string, string>, signal?: AbortSignal) => {
    this.calls.push(signal!);
    await this.gate;
    const viewer = { login: "owner" };
    if (query.includes("search(type: ISSUE")) {
      return {
        data: {
          viewer,
          search: {
            issueCount: this.attention.length,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: this.attention.map((url) => ({ url })),
          },
        },
      };
    }

    return {
      data: {
        viewer,
        repository: {
          pullRequest: {
            url: `https://github.com/${variables.owner}/${variables.repo}/pull/10`,
            number: 10,
            title: "Fixture",
            state: "OPEN",
            isDraft: false,
            updatedAt: "2026-11-28",
            headRefName: "feature",
            headRefOid: this.head,
            reviewDecision: this.decision,
            mergeable: this.mergeable,
          },
        },
      },
    };
  };
}

let directory: string;
let engine: Engine;
let rpc: Rpc;
let provider: ScheduleProvider;
let github: ScheduleGitHub;
let session: ViberSession;

const open = async () => {
  engine = await Engine.create(directory, () => provider, undefined, github);
  rpc = new Rpc(engine);
};

const close = async () => {
  await rpc.close();
  await engine.close();
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "vibestar-schedules-"));
  provider = new ScheduleProvider();
  github = new ScheduleGitHub(directory);
  await open();
  createTestProfiles(engine.db);

  session = (await rpc.call("viber.session.create", {
    profile_id: profileId,
    request_id: randomUUID(),
    selection,
  })) as ViberSession;
});

afterEach(async () => {
  await close();
  await rm(directory, { recursive: true, force: true });
});

const request = (content: string) => ({
  session_id: session.id,
  profile_id: profileId,
  request_id: randomUUID(),
  content,
  history_ids: [],
});

const send = (content: string) =>
  rpc.call("viber.session.send", request(content)) as Promise<ViberMessage>;

const list = () =>
  rpc.call("viber.schedule.list", { profile_id: profileId }) as Promise<ViberSchedule[]>;

const messages = () => engine.viberSessions.store.detail(session.id, profileId).messages;

const notices = () =>
  messages().filter(
    ({ role, local_schedule, content }) =>
      role === "assistant" &&
      local_schedule &&
      (content.includes("**Reminder**") || content.includes("**PRs") || content.includes("**[PR")),
  );

const due = (id: string) => {
  engine.db.run("UPDATE viber_schedules SET next_run_at=? WHERE id=?", Date.now() - 10, id);
  engine.schedules.wake();
};

const next = (id: string) =>
  expect
    .poll(() => engine.schedules.list(profileId).find((row) => row.id === id)?.next_run_at ?? 0)
    .toBeGreaterThan(Date.now());

it("routes both example requests through the structured provider and the same profile scheduler", async () => {
  const input = request(monitor);

  const [first, retry] = await Promise.all([
    rpc.call("viber.session.send", input),
    rpc.call("viber.session.send", input),
  ]);

  expect(first).toEqual(retry);
  expect(provider.calls.filter(({ interpretSchedule }) => interpretSchedule)).toHaveLength(1);

  await expect(
    rpc.call("viber.session.send", { ...input, shared_computer: true }),
  ).rejects.toMatchObject({ kind: "request_conflict" });

  await send(remind);
  const [review, reminder] = await list();
  expect(review.task).toEqual({ kind: "github", events: "changes_requested" });

  expect(reminder).toMatchObject({
    name: "Send the demo",
    task: { kind: "reminder" },
    timezone: "UTC",
  });

  expect(reminder.next_run_at).toBe(Date.parse(tomorrow()));
  await next(review.id);
  expect(notices()).toHaveLength(0);

  github.attention.push("https://github.com/owner/another/pull/3");
  due(review.id);
  await next(review.id);
  expect(notices()).toHaveLength(1);
  const classifierCalls = provider.calls.length;
  due(review.id);
  await next(review.id);
  expect(notices()).toHaveLength(1);
  expect(provider.calls).toHaveLength(classifierCalls);

  engine.db.run(
    "UPDATE viber_schedules SET claim='interrupted',next_run_at=? WHERE id=?",
    Date.now() - 10,
    reminder.id,
  );

  await close();
  await open();
  await expect.poll(() => notices().length).toBe(2);
  expect((await list()).find(({ id }) => id === reminder.id)?.status).toBe("completed");
  expect(await rpc.call("viber.session.send", input)).toEqual(first);
  await close();
  await open();
  expect(notices()).toHaveLength(2);

  expect(await rpc.call("viber.schedule.list", { profile_id: testProfileIds.reviewer })).toEqual(
    [],
  );
});

it.each(["cancel", "retire", "shutdown"] as const)(
  "invalidates a pending baseline on %s",
  async (action) => {
    let release!: () => void;

    github.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      await send("Monitor this PR");
      await expect.poll(() => github.calls.length).toBe(1);
      expect((await list())[0].status).toBe("pending");
      if (action === "shutdown") {
        const closed = vi.fn();
        const closing = engine.close().then(closed);
        expect(github.calls[0].aborted).toBe(true);
        expect(closed).not.toHaveBeenCalled();
        release();
        await closing;
        await rpc.close();
        github.connected = false;
        await open();
        expect((await list())[0].status).toBe("pending");
        expect(notices()).toHaveLength(0);
      } else {
        if (action === "cancel") {
          await send("Cancel PR 10");
          expect((await list())[0].status).toBe("cancelled");
        } else {
          await rpc.call("profile.delete", { profile_id: profileId, confirmed: true });
          expect(await list()).toEqual([]);
        }

        expect(github.calls[0].aborted).toBe(true);
        release();
        await engine.schedules.close();

        expect(engine.db.all("SELECT status,cursor FROM viber_schedules")).toEqual([
          { status: "cancelled", cursor: null },
        ]);
      }
    } finally {
      release();
    }
  },
);

it("asks before cancelling matching PR numbers and preserves review and mergeability transitions", async () => {
  provider.proposals.set(
    "Monitor another PR",
    githubProposal("https://github.com/other/repo/pull/10"),
  );

  await send("Monitor this PR");
  await send("Monitor another PR");
  const [first, second] = await list();
  await next(first.id);
  await next(second.id);
  await send("Cancel PR 10");
  expect(messages().at(-1)?.content).toMatch(/Which schedule\?/);
  expect((await list()).every(({ status }) => status === "active")).toBe(true);

  github.decision = "REVIEW_REQUIRED";
  github.mergeable = "UNKNOWN";
  github.head = "second";
  due(first.id);
  await next(first.id);
  expect(notices().at(-1)?.content).toContain("Review required again");
  expect(notices().at(-1)?.content).not.toContain("Merge conflict resolved");

  github.mergeable = "MERGEABLE";
  due(first.id);
  await next(first.id);
  expect(notices().at(-1)?.content).toContain("Merge conflict resolved");
  github.head = "third";
  due(first.id);
  await next(first.id);
  expect(notices()).toHaveLength(2);

  provider.proposals.set("Cancel the other PR", {
    action: "cancel",
    target: "https://github.com/Other/Repo/pull/10/?source=chat#discussion",
  });

  await send("Cancel the other PR");
  expect((await list()).find(({ id }) => id === second.id)?.status).toBe("cancelled");
});

it("uses existing sign-in status and runs general instructions outside native conversation", async () => {
  github.connected = false;
  await send(monitor);
  await expect.poll(() => engine.schedules.list(profileId)[0]?.status).toBe("blocked_sign_in");
  expect((await list())[0].error).toContain("Providers → GitHub");

  provider.proposals.set("Summarize my workspace tomorrow", () => ({
    action: "create",
    name: "Workspace summary",
    instructions: "Summarize files",
    task: "instruction",
    cadence: "once",
    at: tomorrow(),
  }));

  await send("Summarize my workspace tomorrow");
  const schedule = (await list()).find(({ task }) => task.kind === "instruction")!;
  due(schedule.id);
  await expect.poll(() => messages().at(-1)?.content).toBe("Scheduled answer");

  expect(provider.calls.at(-1)).toMatchObject({
    access: "read-only",
    config: { output: "summary" },
  });

  expect(provider.calls.at(-1)?.conversation).toBeUndefined();
  expect(engine.viberSessions.store.session(session.id, profileId).thread).toBeNull();
});

it("excludes schedule timeline entries from history, handoff and Continue", async () => {
  const scope = { session_id: session.id, profile_id: profileId };

  const stopped = engine.viberSessions.store.capture({
    ...request("Continue this work"),
    selection,
  });

  const stoppedId = stopped.request.request_id;
  engine.viberSessions.store.finish(stoppedId, "cancelled");
  const local = await send(remind);
  await send("What schedules are running?");
  const reminder = (await list())[0];
  due(reminder.id);
  await expect.poll(() => notices().length).toBe(1);
  const notice = notices()[0];

  for (const historyId of [local.id, notice.id]) {
    expect(() =>
      engine.viberSessions.store.capture({
        ...request("Use selected context"),
        history_ids: [historyId],
        selection,
        new_thread: true,
      }),
    ).toThrow("Select completed messages");
  }

  const continuation = engine.viberSessions.store.capture({
    ...request("Continue where you left off."),
    ...scope,
    continue_message_id: stoppedId,
  });

  expect(continuation.originalPrompt).toBe("Continue this work");
  expect(continuation.prompt).not.toContain(remind);
  expect(continuation.prompt).not.toContain(notice.content);
  engine.viberSessions.store.finish(continuation.request.request_id, "cancelled");

  const handoff = engine.viberSessions.store.continuationPreparation({
    ...scope,
    continue_message_id: continuation.request.request_id,
    selection: { provider: "antigravity", model: "next-model", effort: "high" },
  });

  expect(handoff?.context).toContain("Continue this work");
  expect(handoff?.context).not.toContain(remind);
  expect(handoff?.context).not.toContain(notice.content);
});

it("validates, edits, pauses, and resumes cadence through typed chat operations", async () => {
  provider.proposals.set("Every minute", { ...githubProposal(), minutes: 1 });
  await send("Every minute");
  expect(await list()).toEqual([]);
  expect(messages().at(-1)?.content).toContain("at least five minutes");

  await send(remind);
  const [saved] = await list();
  provider.proposals.set("Pause my reminder", { action: "pause", target: saved.id });
  await send("Pause my reminder");
  expect((await list())[0]).toMatchObject({ status: "paused", next_run_at: null });

  provider.proposals.set("Move it to 5 every weekday", {
    action: "edit",
    target: saved.id,
    cadence: "clock",
    hour: 17,
    minute: 0,
    weekdays: true,
    timezone: "America/New_York",
  });

  await send("Move it to 5 every weekday");

  expect((await list())[0]).toMatchObject({
    status: "paused",
    next_run_at: null,
    timezone: "America/New_York",
    cadence: { kind: "clock", hour: 17, minute: 0, weekdays: true },
  });

  provider.proposals.set("Resume the demo reminder", { action: "resume", target: saved.id });
  await send("Resume the demo reminder");
  expect((await list())[0].status).toBe("active");
  await next(saved.id);

  const retryAt = Date.now() + 5 * 60_000;

  engine.db.run(
    "UPDATE viber_schedules SET status='retrying',next_run_at=?,error='Temporary failure' WHERE id=?",
    retryAt,
    saved.id,
  );

  provider.proposals.set("Make it every 45 minutes", {
    action: "edit",
    target: saved.id,
    minutes: 45,
  });

  await send("Make it every 45 minutes");
  const [edited] = await list();

  expect(edited).toMatchObject({
    cadence: { kind: "interval", minutes: 45 },
    status: "active",
    error: null,
  });

  expect(edited.next_run_at).toBeGreaterThan(retryAt);
});

it("carries forward only saved legacy state and preserves cancelled schedules and chats", async () => {
  const active = randomUUID();
  const cancelled = randomUUID();
  const transcript = randomUUID();

  engine.db.run("ALTER TABLE viber_messages DROP COLUMN timeline_kind");

  const cursor = {
    state: "OPEN",
    draft: false,
    head_sha: "old",
    review_decision: "APPROVED",
    mergeable: "CONFLICTING",
    check_status: null,
  };

  engine.db.run(`CREATE TABLE viber_pr_watches (
    id TEXT, session_id TEXT, owner TEXT, repo TEXT, pull_number INTEGER,
    url TEXT, status TEXT, cursor TEXT, last_checked_at TEXT
  )`);

  for (const [id, status] of [
    [active, "active"],
    [cancelled, "cancelled"],
  ]) {
    engine.db.run(
      "INSERT INTO viber_pr_watches VALUES(?,?,?,?,?,?,?,?,?)",
      id,
      session.id,
      "owner",
      "example",
      10,
      pull,
      status,
      JSON.stringify(cursor),
      new Date().toISOString(),
    );
  }

  engine.db.run(
    `INSERT INTO viber_messages(id,session_id,role,content,status,configuration,created_at,effects)
      VALUES(?,?,'assistant','Archived schedule notice','completed','{"kind":"pr_watch"}',?,'none')`,
    transcript,
    session.id,
    new Date().toISOString(),
  );

  await close();
  await open();

  expect(engine.db.all("SELECT name FROM sqlite_schema WHERE name='viber_pr_watches'")).toEqual([]);
  const rows = await list();
  expect(rows.find(({ id }) => id === active)).toMatchObject({ status: "pending" });

  expect(rows.find(({ id }) => id === cancelled)).toMatchObject({
    status: "cancelled",
    next_run_at: null,
  });

  expect(engine.db.all("SELECT cursor FROM viber_schedules WHERE id=?", active)).toEqual([
    { cursor: JSON.stringify({ pull: cursor }) },
  ]);

  expect(messages().find(({ id }) => id === transcript)).toMatchObject({ local_schedule: true });
  due(active);
  await next(active);
  expect(notices()).toHaveLength(0);
  expect(github.calls).toHaveLength(1);
});
