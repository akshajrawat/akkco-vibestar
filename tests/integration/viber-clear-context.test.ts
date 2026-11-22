import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { AntigravityProvider } from "../../apps/core/execution/providers/antigravity";
import { CodexProvider } from "../../apps/core/execution/providers/codex";
import type { AgentRunRequest } from "../../apps/core/execution/providers/contracts";
import { Rpc } from "../../apps/core/rpc";
import type { ViberSession, ViberSessionDetail } from "../../apps/core/vibers/contracts";
import { createFixtureEngine, detectFixtureProvider } from "../helpers/fixtures";
import { testProfileIds } from "../helpers/viber-fixtures";

const firstProvider = "antigravity";
const lastProvider = "codex";

const scope = (session: ViberSession) => ({
  session_id: session.id,
  profile_id: session.profile_id,
});

it("/clear clears both native contexts only when the target Viber is idle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibestar-clear-context-"));
  const requests: AgentRunRequest[] = [];
  const adapters = { codex: new CodexProvider(), antigravity: new AntigravityProvider() };
  const hold = "Hold this fake turn open";

  const engine = await createFixtureEngine(join(directory, "data"), (_stage, name = "codex") => ({
    ...adapters[name],
    detect: async () => ({ ...(await detectFixtureProvider()), provider: name }),
    invocation: (request) => {
      requests.push(request);
      const threadId = request.conversation?.threadId ?? request.runId;
      const response = `Saved answer from ${name}`;

      const events =
        name === "codex"
          ? [
              { type: "thread.started", thread_id: threadId },
              { type: "item.completed", item: { type: "agent_message", text: response } },
              { type: "turn.completed" },
            ]
          : [
              {
                event: "result",
                result: { status: "SUCCESS", conversation_id: threadId, response },
              },
            ];

      return {
        program: process.execPath,
        args: [
          "-e",
          request.prompt.includes(hold)
            ? "setInterval(() => {}, 1000)"
            : `for (const event of ${JSON.stringify(events)}) { console.log(JSON.stringify(event)); }`,
        ],
      };
    },
  }));

  const rpc = new Rpc(engine);

  try {
    const selection = (provider: keyof typeof adapters) => ({
      provider,
      model: "next-model",
      effort: "high",
    });

    const create = async (profile_id: string) =>
      (await rpc.call("viber.session.create", {
        profile_id,
        request_id: randomUUID(),
        selection: selection(firstProvider),
      })) as ViberSession;

    const send = (
      session: ViberSession,
      content: string,
      provider?: keyof typeof adapters,
      requestId: string = randomUUID(),
    ) =>
      rpc.call("viber.session.send", {
        ...scope(session),
        request_id: requestId,
        content,
        history_ids: [],
        ...(provider ? { selection: selection(provider) } : {}),
      });

    const detail = async (session: ViberSession) =>
      (await rpc.call("viber.session.detail", scope(session))) as ViberSessionDetail;

    const turn = async (
      session: ViberSession,
      content: string,
      provider?: keyof typeof adapters,
    ) => {
      const count = requests.length;
      await send(session, content, provider);
      await expect.poll(() => engine.isActive(`viber:${session.id}`)).toBe(false);

      expect((await detail(session)).messages.at(-1)).toMatchObject({
        role: "assistant",
        status: "completed",
      });

      expect(requests).toHaveLength(count + 1);
      return requests[count];
    };

    const startHeldTurn = async (session: ViberSession) => {
      await send(session, hold);

      await expect
        .poll(
          () =>
            engine.db.all<{ pid: number }>(
              "SELECT pid FROM utility_runs WHERE viber_session_id=? AND status='running'",
              session.id,
            )[0]?.pid,
        )
        .toBeGreaterThan(1);

      expect(engine.isActive(`viber:${session.id}`)).toBe(true);
    };

    const session = await create(testProfileIds.implementer);
    const unrelated = await create(testProfileIds.reviewer);
    const markers = ["pre-clear first provider marker", "pre-clear second provider marker"];

    await turn(session, markers[0]);
    await turn(session, markers[1], lastProvider);
    const original = await detail(session);
    const originalThreads = original.session.threads;
    expect(originalThreads?.[firstProvider]?.thread_id).toBeTruthy();
    expect(originalThreads?.[lastProvider]?.thread_id).toBeTruthy();

    const assignment = engine.viberSessions.store.workspace(session.id);
    const cwd = await engine.git.assertOwnedTask(assignment);
    const file = join(cwd, "owned.bin");
    const bytes = Buffer.from([0, 255, 42, 13, 10]);
    await writeFile(file, bytes);

    await startHeldTurn(unrelated);
    const beforeClear = requests.length;

    await expect(send(session, "/clear")).resolves.toMatchObject({
      content: "/clear",
      status: "completed",
    });

    expect(requests).toHaveLength(beforeClear);
    expect(engine.isActive(`viber:${unrelated.id}`)).toBe(true);
    const cleared = await detail(session);

    expect(cleared.session).toMatchObject({
      thread: null,
      threads: {},
      selection: selection(lastProvider),
    });

    expect(cleared.messages.slice(0, original.messages.length)).toEqual(original.messages);
    expect(engine.viberSessions.store.workspace(session.id)).toEqual(assignment);
    expect(await readFile(file)).toEqual(bytes);

    const next = await turn(session, "First ordinary turn after clear");
    expect(next.config).toMatchObject(selection(lastProvider));
    expect(next.conversation).toEqual({});
    expect(next.cwd).toBe(cwd);
    expect((await detail(session)).session.thread?.thread_id).toBe(next.runId);
    expect(next.runId).not.toBe(originalThreads?.[lastProvider]?.thread_id);

    const switched = await turn(
      session,
      "Continue with the other provider after clear",
      firstProvider,
    );

    expect(switched.conversation).toEqual({});
    expect(switched.prompt).toContain("First ordinary turn after clear");
    for (const marker of markers) {
      expect(next.prompt).not.toContain(marker);
      expect(switched.prompt).not.toContain(marker);
    }

    await startHeldTurn(session);
    const active = await detail(session);
    const beforeRefusal = requests.length;
    const requestId = randomUUID();
    const clear = () => send(session, "/clear", undefined, requestId);
    await expect(clear()).rejects.toMatchObject({ kind: "busy" });
    expect(await detail(session)).toEqual(active);
    expect(await readFile(file)).toEqual(bytes);
    expect(requests).toHaveLength(beforeRefusal);

    await rpc.call("viber.session.cancel", scope(session));
    await expect(clear()).resolves.toMatchObject({ id: requestId, status: "completed" });
    expect((await detail(session)).session).toMatchObject({ thread: null, threads: {} });
  } finally {
    await rpc.close();
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
