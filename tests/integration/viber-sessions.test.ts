import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";

import { Rpc } from "../../apps/core/rpc";
import { builtInProfiles } from "../../apps/core/flows/templates";
import type {
  ViberMessage,
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
        require('node:fs').writeFileSync('answer.txt','Session file');
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

const create = async (profile_id = profileId) =>
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
  for (const table of [
    "tasks",
    "flow_definitions",
    "flow_runs",
    "agent_runs",
    "utility_runs",
    "ai_usage",
  ]) {
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
  const profile = engine.flows.profile(profileId);
  const session = await create();
  const input = { request_id: randomUUID(), content: "Write the first answer" };
  const pending = await send(session, input);
  const first = await settled(session);
  expect(first.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  expect(first.messages[1].content).toBe("Saved session answer.");
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

  expect(engine.db.all("SELECT viber_session_id,task_id FROM ai_usage")).toEqual([
    { viber_session_id: session.id, task_id: null },
  ]);

  expect(engine.flows.profile(profileId)).toEqual(profile);
  expect(engine.db.tasks()).toEqual([]);
  expect(engine.db.all("SELECT * FROM flow_runs")).toEqual([]);
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
  expect(await send(session, input)).toEqual(retained);
  expect(provider.requests).toHaveLength(1);
  await send(session, { content: "A new answer" });
  await settled(session);
  expect(provider.requests[1].config).toMatchObject(selection);
  expect(provider.requests[1].conversation).toEqual({ threadId: first.session.thread?.thread_id });
  expect(provider.requests[1].prompt).toBe("A new answer");
  expect((await detail(session)).session.thread?.thread_id).toBe(first.session.thread?.thread_id);
  expect(engine.db.all("PRAGMA foreign_key_check")).toEqual([]);
});

it("isolates profile ownership, same-profile histories, request identities, output and workspaces", async () => {
  const one = await create();
  const two = await create();
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
  await settled(two);
  expect(provider.requests[1].prompt).not.toContain("Private first session");
  expect(provider.requests[0].cwd).not.toBe(provider.requests[1].cwd);
  expect(await rpc.call("viber.session.list", { profile_id: builtInProfiles.planner })).toEqual([]);
});

it("captures the shared profile revision per turn while keeping provider/model/effort scoped to the session", async () => {
  const one = await create();
  const two = await create();
  const profile = engine.flows.profile(profileId);

  engine.flows.saveProfile(
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

  expect(engine.flows.profile(profileId).execution).toEqual({
    ...profile.execution,
    model: "next-model",
    effort: "low",
  });

  await send(one);
  await settled(one);
  expect(provider.requests[1].config.effort).toBe("low");
});

it("enforces shared execution capacity, serializes one session, supports cancellation, and does not replay failed turns", async () => {
  provider.mode = "wait";
  engine.db.saveSettings({ ...engine.db.settings(), concurrency: 1 });
  const one = await create();
  const two = await create();
  const input = { request_id: randomUUID() };
  const pending = await send(one, input);
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
  const crashed = await create();

  engine.viberSessions.store.capture({
    session_id: crashed.id,
    profile_id: profileId,
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
  const one = await create();
  const two = await create();
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
