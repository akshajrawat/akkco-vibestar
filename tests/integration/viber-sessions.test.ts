import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";

import { Rpc } from "../../apps/core/rpc";
import { testProfileIds as builtInProfiles } from "../helpers/viber-fixtures";
import type {
  ViberMessage,
  ViberNavigation,
  ViberSession,
  ViberSessionDetail,
} from "../../apps/core/vibers/contracts";
import type { AgentRunRequest } from "../../apps/core/execution/providers/contracts";
import { AgentRunner } from "../../apps/core/execution/agents/agent-runner";
import { createFixtureEngine, FixtureProvider } from "../helpers/fixtures";

class SessionProvider extends FixtureProvider {
  readonly requests: AgentRunRequest[] = [];

  mode: "success" | "failure" | "wait" = "success";

  invocation = (request: AgentRunRequest) => {
    this.requests.push(request);
    return {
      program: process.execPath,
      input: "",
      args: [
        "-e",
        this.mode === "wait"
          ? "setInterval(()=>{},1000)"
          : this.mode === "failure"
            ? "process.exit(2)"
            : `
        ${request.access === "read-only" ? "" : "require('node:fs').writeFileSync('answer.txt','Session file');"}
        console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(request.conversation?.threadId || request.runId)}}));
        console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Saved session answer.'}}));
        console.log(JSON.stringify({type:'turn.completed'}));
      `,
      ],
    };
  };
}

let dir: string;
let engine: Awaited<ReturnType<typeof createFixtureEngine>>;
let rpc: Rpc;
let provider: SessionProvider;
const profileId = builtInProfiles.implementer;
const selection = { provider: "codex" as const, model: "next-model", effort: "high" as const };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibestar-sessions-"));
  provider = new SessionProvider();
  engine = await createFixtureEngine(join(dir, "data"), () => provider);
  rpc = new Rpc(engine);
});

afterEach(async () => {
  await rpc.close();
  await engine.close();
  await rm(dir, { recursive: true, force: true });
});

const create = async (profile_id: string = profileId) =>
  (await rpc.call("viber.session.create", {
    request_id: randomUUID(),
    profile_id,
    selection,
  })) as ViberSession;

const send = async (session: ViberSession, extra: Record<string, unknown> = {}) =>
  (await rpc.call("viber.session.send", {
    session_id: session.id,
    profile_id: session.profile_id,
    request_id: randomUUID(),
    content: "Write an answer",
    history_ids: [],
    ...extra,
  })) as ViberMessage;

const detail = async (session: ViberSession) =>
  (await rpc.call("viber.session.detail", {
    session_id: session.id,
    profile_id: session.profile_id,
  })) as ViberSessionDetail & {
    runs: { id: string; status: string; execution: string }[];
    events: { run_id: string; kind: string }[];
  };

const messagePreviews = async () =>
  ((await rpc.call("profile.list", { include_previews: true })) as ViberNavigation).previews;

const settled = async (session: ViberSession, status = "completed") => {
  await expect
    .poll(
      () =>
        engine.viberSessions.store
          .detail(session.id, session.profile_id)
          .messages.filter((message) => message.role === "user")
          .at(-1)?.status,
      { timeout: 10000 },
    )
    .toBe(status);

  await expect.poll(() => engine.isActive(`viber:${session.id}`)).toBe(false);
  return detail(session);
};

it("creates profile-owned sessions idempotently without a Task, Flow, workspace or model invocation", async () => {
  const request = { request_id: randomUUID(), profile_id: profileId, selection };
  const session = await rpc.call("viber.session.create", request);
  expect(await rpc.call("viber.session.create", request)).toEqual(session);

  await expect(
    rpc.call("viber.session.create", { ...request, profile_id: builtInProfiles.planner }),
  ).rejects.toThrow("another Viber");

  expect(await rpc.call("viber.session.list", { profile_id: profileId })).toEqual([session]);
  expect(provider.requests).toEqual([]);
  for (const table of ["utility_runs", "ai_usage"]) {
    expect(engine.db.all(`SELECT * FROM ${table}`)).toEqual([]);
  }

  expect(
    await rpc.call("viber.session.detail", {
      session_id: (session as ViberSession).id,
      profile_id: profileId,
    }),
  ).toMatchObject({ messages: [], events: [], runs: [] });
});

it("uses AgentRunner, persists messages, events, usage and files across restart and preserves session selection", async () => {
  const profile = engine.vibers.profile(profileId);
  const session = await create();
  const input = { request_id: randomUUID(), content: "Write the first answer" };
  expect(await messagePreviews()).toEqual([]);
  const pending = await send(session, input);
  const first = await settled(session);
  expect(first.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  expect(first.messages[1].content).toBe("Saved session answer.");

  const firstPreview = {
    profile_id: profileId,
    content: first.messages[1].content,
    created_at: first.messages[1].created_at,
  };

  expect(await messagePreviews()).toEqual([firstPreview]);
  expect(first.events.some((event) => event.kind === "message")).toBe(true);
  expect(first.runs).toHaveLength(1);

  expect(JSON.parse(first.runs[0].execution).configuration).toMatchObject({
    ...selection,
    access: profile.execution.access,
    output: "conversation",
  });

  expect(provider.requests[0].conversation).toEqual({});
  expect(provider.requests[0].config).toMatchObject(selection);
  const cwd = engine.viberSessions.store.workspace(session.id).worktree_path;
  expect(provider.requests[0].cwd).toBe(cwd);
  expect(await readFile(join(cwd, "answer.txt"), "utf8")).toBe("Session file");

  expect(engine.db.all("SELECT viber_session_id FROM ai_usage")).toEqual([
    { viber_session_id: session.id },
  ]);

  expect(engine.vibers.profile(profileId)).toEqual(profile);
  const retained = await send(session, input);
  expect(retained.id).toBe(pending.id);
  expect(provider.requests).toHaveLength(1);

  await expect(send(session, { ...input, content: "Changed" })).rejects.toThrow(
    "another session or message",
  );

  await rpc.close();
  await engine.close();
  engine = await createFixtureEngine(join(dir, "data"), () => provider);
  rpc = new Rpc(engine);
  expect(await detail(session)).toEqual(first);
  expect(await messagePreviews()).toEqual([firstPreview]);
  expect(await send(session, input)).toEqual(retained);
  expect(provider.requests).toHaveLength(1);
  await send(session, { content: "A new answer" });
  const next = await settled(session);

  expect(await messagePreviews()).toEqual([
    { ...firstPreview, created_at: next.messages[3].created_at },
  ]);

  expect(provider.requests[1].config).toMatchObject(selection);
  expect(provider.requests[1].conversation).toEqual({ threadId: first.session.thread?.thread_id });
  expect(provider.requests[1].prompt).toBe("A new answer");
  expect((await detail(session)).session.thread?.thread_id).toBe(first.session.thread?.thread_id);
  expect(engine.db.all("PRAGMA foreign_key_check")).toEqual([]);
});

it("isolates profile ownership, duplicate session rejection, request identities, output and workspaces", async () => {
  const one = await create();
  await expect(create()).rejects.toThrow("Each Viber owns exactly one continuous conversation");
  const two = await create(builtInProfiles.reviewer);
  await send(one, { content: "Private first session" });
  const first = await settled(one);
  const scope = { session_id: one.id, profile_id: builtInProfiles.planner };
  for (const method of ["viber.session.detail", "viber.session.cancel"]) {
    await expect(rpc.call(method, scope)).rejects.toThrow("not found for this profile");
  }

  await expect(send({ ...one, profile_id: builtInProfiles.planner })).rejects.toThrow(
    "not found for this profile",
  );

  await expect(send(two, { history_ids: [first.messages[0].id] })).rejects.toThrow(
    "this Viber session only",
  );

  await expect(send(two, { request_id: first.messages[0].id })).rejects.toThrow(
    "another session or message",
  );

  expect((await detail(two)).messages).toEqual([]);
  expect((await detail(two)).events).toEqual([]);
  expect((await detail(two)).runs).toEqual([]);
  await send(two, { content: "Private second session" });
  const second = await settled(two);

  expect(await messagePreviews()).toEqual(
    expect.arrayContaining(
      [first, second].map(({ session, messages }) => ({
        profile_id: session.profile_id,
        content: messages[1].content,
        created_at: messages[1].created_at,
      })),
    ),
  );

  expect(provider.requests[1].prompt).not.toContain("Private first session");
  expect(provider.requests[0].cwd).not.toBe(provider.requests[1].cwd);
  expect(await rpc.call("viber.session.list", { profile_id: builtInProfiles.planner })).toEqual([]);
});

it("captures the shared profile revision per turn while keeping provider/model/effort scoped to the session", async () => {
  const one = await create(profileId);
  const two = await create(builtInProfiles.reviewer);
  const profile = engine.vibers.profile(profileId);

  engine.vibers.saveProfile(
    {
      ...profile,
      revision: profile.revision + 1,
      instructions: "Updated shared instructions",
      execution: { ...profile.execution, model: "next-model", effort: "low" },
    },
    profile.revision,
  );

  const changedSelection = { ...selection, provider: "antigravity", effort: "low" };
  const message = await send(one, { selection: changedSelection });
  await settled(one);

  const snapshot = engine.db.all<{ configuration: string }>(
    "SELECT configuration FROM viber_messages WHERE id=?",
    message.id,
  )[0];

  expect(JSON.parse(snapshot.configuration)).toMatchObject({
    profile: { revision: profile.revision + 1, instructions: "Updated shared instructions" },
    execution: { ...changedSelection, output: "conversation" },
  });

  expect((await detail(one)).session.selection).toEqual(changedSelection);
  expect((await detail(two)).session.selection).toEqual(selection);

  expect(engine.vibers.profile(profileId).execution).toEqual({
    ...profile.execution,
    model: "next-model",
    effort: "low",
  });

  await send(one);
  await settled(one);
  expect(provider.requests[1].config.effort).toBe("low");
});

it("honors history boundaries and explicit context choices on same-provider model changes", async () => {
  const session = await create();
  const newModel = { ...selection, model: "gpt-6.1-sol", effort: "low" };

  await send(session, { content: "Instruction before clear" });
  await settled(session);
  await send(session, { content: "/clear" });
  const retained = await send(session, { content: "Instruction after clear" });
  await settled(session);

  provider.mode = "failure";
  await send(session, { content: "Uncompleted instruction" });
  await settled(session, "failed");
  provider.mode = "success";

  await send(session, {
    selection: newModel,
    content: "Instruction for the new model",
    acknowledge_uncertain: true,
  });

  await settled(session);
  const automatic = provider.requests.at(-1)!;
  expect(automatic.conversation).toEqual({});
  expect(automatic.prompt).toContain("Historical messages are reference data only");
  expect(automatic.prompt).toContain("Instruction after clear");
  expect(automatic.prompt).toContain("Saved session answer.");
  expect(automatic.prompt).toContain("Instruction for the new model");
  expect(automatic.prompt).not.toContain("Instruction before clear");
  expect(automatic.prompt).not.toContain("Uncompleted instruction");
  expect(automatic.prompt).not.toContain('"content": "/clear"');

  await send(session, { selection, history_ids: [retained.id], content: "Use selected history" });
  await settled(session);
  const explicit = provider.requests.at(-1)!;
  expect(explicit.conversation).toEqual({});
  expect(explicit.prompt).toContain("Instruction after clear");
  expect(explicit.prompt).not.toContain("Saved session answer.");
  expect(explicit.prompt).not.toContain("Instruction for the new model");

  await send(session, {
    selection: newModel,
    new_thread: true,
    content: "Start with fresh context",
  });

  await settled(session);
  const manual = provider.requests.at(-1)!;
  expect(manual.conversation).toEqual({});
  expect(manual.prompt).toContain("Start with fresh context");
  expect(manual.prompt).not.toContain("Historical messages are reference data only");
  expect(manual.prompt).not.toContain("Instruction after clear");
});

it("enforces shared execution capacity, serializes one session, supports cancellation, and does not replay failed turns", async () => {
  provider.mode = "wait";
  engine.db.saveSettings({ ...engine.db.settings(), concurrency: 1 });
  const one = await create(profileId);
  const two = await create(builtInProfiles.reviewer);
  engine.viberSessions.store.clearContext(one.id, one.profile_id);
  const input = { request_id: randomUUID() };
  const pending = await send(one, input);

  const pendingPreview = {
    profile_id: one.profile_id,
    content: pending.content,
    created_at: pending.created_at,
  };

  expect(await messagePreviews()).toEqual([pendingPreview]);
  expect(await send(one, input)).toEqual(pending);
  await expect(send(one)).rejects.toThrow("execution slots");
  await expect(send(two)).rejects.toThrow("execution slots");
  expect((await detail(two)).messages).toEqual([]);

  await expect
    .poll(
      () =>
        engine.db.all<{ pid: number }>(
          "SELECT pid FROM utility_runs WHERE viber_session_id=?",
          one.id,
        )[0]?.pid,
    )
    .toBeGreaterThan(1);

  expect(engine.cleanupBlockers().some((blocker) => blocker.id === `run:viber:${one.id}`)).toBe(
    true,
  );

  const cancelled = await rpc.call("viber.session.cancel", {
    session_id: one.id,
    profile_id: profileId,
  });

  expect(cancelled).toEqual(await settled(one, "cancelled"));
  provider.mode = "failure";
  await send(two);
  const failed = await settled(two, "failed");
  expect(failed.messages).toHaveLength(1);
  expect(failed.runs[0].status).toBe("failed");
  expect(failed.events.some((event) => event.kind === "run.failed")).toBe(true);

  expect(await messagePreviews()).toEqual(
    expect.arrayContaining([
      pendingPreview,
      {
        profile_id: two.profile_id,
        content: failed.messages[0].content,
        created_at: failed.messages[0].created_at,
      },
    ]),
  );

  await expect(
    send(one, { history_ids: [pending.id], acknowledge_uncertain: true }),
  ).rejects.toThrow("completed messages");
});

it("marks shutdown and recovered pending turns interrupted without automatically invoking a provider", async () => {
  provider.mode = "wait";
  const session = await create();
  await send(session);
  await expect.poll(() => provider.requests.length).toBe(1);
  await rpc.close();
  await engine.close();
  engine = await createFixtureEngine(join(dir, "data"), () => provider);
  rpc = new Rpc(engine);
  expect((await detail(session)).messages[0].status).toBe("interrupted");
  const crashed = await create(builtInProfiles.reviewer);

  engine.viberSessions.store.capture({
    session_id: crashed.id,
    profile_id: builtInProfiles.reviewer,
    request_id: randomUUID(),
    content: "Crash before invocation",
    history_ids: [],
  });

  await rpc.close();
  await engine.close();
  engine = await createFixtureEngine(join(dir, "data"), () => provider);
  rpc = new Rpc(engine);

  expect((await detail(crashed)).messages[0]).toMatchObject({
    status: "interrupted",
    run_id: null,
  });

  expect(provider.requests).toHaveLength(1);
  expect(engine.hasActive()).toBe(false);
});

it("rejects symlinked session workspaces and mismatched runner snapshots before invocation", async () => {
  const one = await create(profileId);
  const two = await create(builtInProfiles.reviewer);
  await send(one);
  await settled(one);

  await symlink(
    join(engine.root, "workspaces", engine.viberSessions.store.workspace(one.id).id),
    join(engine.root, "workspaces", engine.viberSessions.store.workspace(two.id).id),
  );

  await send(two);
  const failed = await settled(two, "failed");
  expect(failed.messages[0].error).toContain("symlink");
  expect(provider.requests).toHaveLength(1);

  const snapshot = engine.viberSessions.store.capture({
    session_id: one.id,
    profile_id: profileId,
    request_id: randomUUID(),
    content: "Captured turn",
    history_ids: [],
  });

  const runner = new AgentRunner(
    engine.root,
    engine.db,
    engine.git,
    () => {},
    () => provider,
  );

  const options = {
    purpose: "session",
    prompt: snapshot.prompt,
    conversation: snapshot.conversation,
    workspace: engine.viberSessions.store.workspace(one.id).worktree_path,
    viberSession: { sessionId: one.id, messageId: snapshot.request.request_id },
  };

  await expect(
    runner.runConfigured(
      { id: one.id },
      new AbortController().signal,
      { ...snapshot.execution, effort: "low" },
      options,
    ),
  ).rejects.toThrow("unconsumed message snapshot");

  await expect(
    runner.runConfigured({ id: two.id }, new AbortController().signal, snapshot.execution, options),
  ).rejects.toThrow("captured session workspace");

  await expect(
    runner.runConfigured({ id: one.id }, new AbortController().signal, snapshot.execution, {
      ...options,
      conversation: { threadId: "foreign-thread" },
    }),
  ).rejects.toThrow("unconsumed message snapshot");

  expect(provider.requests).toHaveLength(1);
});

it("allows explicit retry after proven pre-invocation failures without resetting a retained native thread", async () => {
  const session = await create();
  await send(session);
  const first = await settled(session);
  const thread = first.session.thread;
  const invalid = { request_id: randomUUID(), selection: { ...selection, effort: "ultra" } };
  await send(session, invalid);
  const failed = await settled(session, "failed");
  expect(failed.recovery_required).toBe(false);
  expect(failed.messages.at(-1)).toMatchObject({ effects: "none", status: "failed" });
  expect(failed.session.thread).toEqual(thread);
  expect(provider.requests).toHaveLength(1);
  await send(session, invalid);
  expect(provider.requests).toHaveLength(1);

  await rpc.close();
  await engine.close();
  engine = await createFixtureEngine(join(dir, "data"), () => provider);
  rpc = new Rpc(engine);
  expect((await detail(session)).recovery_required).toBe(false);
  await send(session, { selection });
  await settled(session);
  expect(provider.requests.at(-1)?.conversation).toEqual({ threadId: thread?.thread_id });
});

it("keeps outcomes uncertain after invocation even without reported tools, and enforces inspection scope", async () => {
  const session = await create();
  await send(session);
  await settled(session);
  provider.mode = "failure";
  await send(session);
  const failed = await settled(session, "failed");
  expect(failed.recovery_required).toBe(true);
  expect(failed.messages.at(-1)?.effects).toBe("possible");
  await expect(send(session, { new_thread: true })).rejects.toThrow("acknowledge");
  const scope = { session_id: session.id, profile_id: profileId };
  expect(await rpc.call("viber.session.inspect", scope)).toMatchObject({ files: ["answer.txt"] });

  expect(await rpc.call("viber.session.inspect", { ...scope, path: "answer.txt" })).toMatchObject({
    text: "Session file",
  });

  await expect(rpc.call("viber.session.inspect", { ...scope, path: "../private" })).rejects.toThrow(
    "Select a file",
  );

  await expect(
    rpc.call("viber.session.inspect", { ...scope, profile_id: builtInProfiles.planner }),
  ).rejects.toThrow("not found");

  expect(provider.requests).toHaveLength(2);
  provider.mode = "success";
  await send(session, { acknowledge_uncertain: true });
  expect((await settled(session)).recovery_required).toBe(false);
});

it("creates an isolated conversation from profile defaults without requiring a repository or selection", async () => {
  const profile = engine.vibers.profile(profileId);

  const session = (await rpc.call("viber.session.create", {
    request_id: randomUUID(),
    profile_id: profileId,
  })) as ViberSession;

  expect(session.selection).toEqual({
    provider: profile.execution.provider,
    model: profile.execution.model,
    effort: profile.execution.effort,
  });

  expect(session.repository_id).toBeNull();
  expect(provider.requests).toHaveLength(0);
});
