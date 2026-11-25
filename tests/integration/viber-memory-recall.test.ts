import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { Rpc } from "../../apps/core/rpc";
import { AntigravityProvider } from "../../apps/core/execution/providers/antigravity";
import { CodexProvider } from "../../apps/core/execution/providers/codex";
import type { AgentRunRequest } from "../../apps/core/execution/providers/contracts";
import type { Settings } from "../../apps/core/domain";
import type { ViberSession } from "../../apps/core/vibers/contracts";
import { EmbeddingInputRejected, localMemoryModels } from "../../apps/core/vibers/memory-local";
import { createFixtureEngine, detectFixtureProvider, fixtureRepository } from "../helpers/fixtures";
import { testProfileIds } from "../helpers/viber-fixtures";

let dir: string;
let engine: Awaited<ReturnType<typeof createFixtureEngine>>;
let rpc: Rpc;
const profileId = testProfileIds.implementer;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibestar-recall-"));
});

afterEach(async () => {
  await rpc?.close();
  await engine?.close();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const start = async (providers?: Parameters<typeof createFixtureEngine>[1]) => {
  engine = await createFixtureEngine(join(dir, "data"), providers);
  rpc = new Rpc(engine);
};

const configure = async (overrides: Partial<Settings["viber_memory"]>) => {
  const settings = engine.db.settings();

  await rpc.call("settings.save", {
    ...settings,
    viber_memory: { ...settings.viber_memory, ...overrides },
  });
};

const create = (repo?: string, provider = "codex") =>
  rpc.call("viber.session.create", {
    request_id: randomUUID(),
    profile_id: profileId,
    repository_id: repo,
    selection: { provider, model: "next-model", effort: "high" },
  }) as Promise<ViberSession>;

const turn = (session: ViberSession, messageId = randomUUID()) => ({
  profileId,
  sessionId: session.id,
  messageId,
  repositoryId: session.repository_id,
  provider: session.selection.provider,
});

const seedFact = (text: string, topic?: string, repo?: string, owner: string = profileId) => {
  const id = randomUUID();
  engine.db.run("INSERT INTO viber_memory_facts VALUES(?,?,?)", owner, id, text);
  if (topic || repo) {
    engine.db.run(
      "INSERT INTO viber_memory_details(profile_id,fact_id,repository_id,topic) VALUES(?,?,?,?)",
      owner,
      id,
      repo ?? null,
      topic ?? null,
    );
  }

  return id;
};

const facts = () =>
  engine.db.all<{ id: string; text: string; topic: string; needs_review: number }>(
    `SELECT f.id,f.text,d.topic,d.revision,d.needs_review,d.source_message_id,d.source_session_id
   FROM viber_memory_facts f JOIN viber_memory_details d ON d.profile_id=f.profile_id AND d.fact_id=f.id
   WHERE f.profile_id=? ORDER BY f.rowid`,
    profileId,
  );

const vectorCount = () => engine.db.all("SELECT 1 FROM viber_memory_vectors").length;

const send = async (
  session: ViberSession,
  content: string,
  provider = session.selection.provider,
  status = "completed",
  acknowledgeUncertain = false,
) => {
  const request_id = randomUUID();

  await rpc.call("viber.session.send", {
    session_id: session.id,
    profile_id: profileId,
    request_id,
    content,
    history_ids: [],
    ...(acknowledgeUncertain ? { acknowledge_uncertain: true } : {}),
    selection: { ...session.selection, provider },
  });

  await expect
    .poll(
      () =>
        engine.viberSessions.store
          .detail(session.id, profileId)
          .messages.find(({ id }) => id === request_id)?.status,
    )
    .toBe(status);

  await expect.poll(() => engine.isActive(`viber:${session.id}`)).toBe(false);
  return request_id;
};

it("gates lookup locally, ranks within the Viber and repo or topic, and uses one recall setting across providers, and rechecks revisions and thread history", async () => {
  const identify = vi.spyOn(localMemoryModels, "identify").mockResolvedValue("digest-a");

  const embed = vi.spyOn(localMemoryModels, "embed").mockImplementation(async (_model, text) =>
    text.map((input) => {
      const vectors: Record<string, number[]> = {
        "How do I test this?": [1, 0, 0, 0, 0],
        "First useful fact": [0.91, 0.41, 0, 0, 0],
        "Second useful fact": [0.87, 0, 0.49, 0, 0],
        "Third useful fact": [0.82, 0, 0, 0.57, 0],
        "Fourth useful fact": [0.75, 0, 0, 0, 0.66],
        "Topic: tests": [1, 0, 0, 0, 0],
        "Topic: off-topic": [0, 1, 0, 0, 0],
        "Weak match": [0, 0, 1, 0, 0],
      };

      return vectors[input] ?? [1, 0, 0, 0, 0];
    }),
  );

  await start();
  const { repo } = await fixtureRepository(engine, dir);
  const foreign = { ...repo, id: randomUUID(), name: "another-repository" };
  engine.db.saveRepository(foreign);
  const session = await create(repo.id);
  const first = seedFact("First useful fact", "tests");
  seedFact("First useful fact", undefined, repo.id);
  seedFact("Second useful fact", undefined, repo.id);
  seedFact("Third useful fact", "tests");
  seedFact("Fourth useful fact", undefined, repo.id);
  seedFact("Private elsewhere", undefined, foreign.id);
  seedFact("Private Viber", "tests", undefined, testProfileIds.reviewer);
  seedFact("Private topic", "off-topic");
  seedFact("Weak match", undefined, repo.id);
  seedFact("Unscoped legacy fact");

  const recall = (provider = session.selection.provider) =>
    engine.memory.prepareRecall(
      { ...turn(session), provider },
      "How do I test this?",
      new AbortController().signal,
    );

  expect(await recall()).toBeUndefined();
  expect(identify).not.toHaveBeenCalled();
  await configure({ recall: true, embedding_model: "fixture" });
  await expect.poll(vectorCount).toBe(9);
  const pick = (await recall())!;
  const pickForAntigravity = (await recall("antigravity"))!;
  const matches = pick("native-thread");

  expect(matches.map(({ text }) => text)).toEqual([
    "First useful fact",
    "Second useful fact",
    "Third useful fact",
  ]);

  engine.memory.recordShares(turn(session), "native-thread", matches);
  expect(pick("native-thread").map(({ text }) => text)).toEqual(["Fourth useful fact"]);
  expect(pick("new-thread")).toEqual(matches);
  expect(pickForAntigravity("native-thread")).toEqual(matches);

  expect(
    engine.db.all("SELECT provider,revision FROM viber_memory_shares WHERE fact_id=?", first),
  ).toEqual([{ provider: "codex", revision: 1 }]);

  engine.memory.compact(turn(session), "native-thread");
  expect(pick("native-thread")).toEqual(matches);
  engine.db.run("DELETE FROM viber_memory_facts WHERE profile_id=? AND id=?", profileId, first);
  expect(pick().map(({ id }) => id)).not.toContain(first);
  await configure({ recall: false });
  expect(pick()).toEqual([]);
  expect(pickForAntigravity()).toEqual([]);
  embed.mockClear();
  expect(await recall("antigravity")).toBeUndefined();
  expect(embed).not.toHaveBeenCalled();

  await configure({ recall: true, embedding_model: "fixture-v2" });

  await expect
    .poll(() => engine.db.all("SELECT DISTINCT model,dimensions FROM viber_memory_vectors"))
    .toEqual([{ model: "fixture-v2", dimensions: 5 }]);

  expect(pick()).toEqual([]);
  expect(engine.db.all("PRAGMA foreign_key_check")).toEqual([]);
});

it("discards a query vector when the installed model changes during embedding", async () => {
  let digest = "initial";
  vi.spyOn(localMemoryModels, "identify").mockImplementation(async () => digest);

  const embed = vi
    .spyOn(localMemoryModels, "embed")
    .mockImplementation(async (_model, inputs) => inputs.map(() => [1, 0]));

  await start();
  const session = await create();
  seedFact("Fixture fact", "fixture topic");
  await configure({ recall: true, embedding_model: "fixture" });
  await expect.poll(vectorCount).toBe(1);

  embed.mockImplementationOnce(async () => {
    digest = "updated";
    return [[1, 0]];
  });

  const recall = () =>
    engine.memory.prepareRecall(turn(session), "Fixture query", new AbortController().signal);

  expect(await recall()).toBeUndefined();

  await expect
    .poll(() => engine.db.all("SELECT digest FROM viber_memory_vectors"))
    .toEqual([{ digest: "updated" }]);

  expect((await recall())?.("thread")).toEqual([expect.objectContaining({ text: "Fixture fact" })]);
});

it("continues indexing after a budget expires without repeating rejected or committed facts", async () => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const budget = new AbortController();

  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
    ms === 120_000 && !budget.signal.aborted ? budget.signal : timeout(ms),
  );

  vi.spyOn(localMemoryModels, "identify").mockResolvedValue("digest");
  let interrupted = false;

  const embed = vi
    .spyOn(localMemoryModels, "embed")
    .mockImplementation(async (_model, inputs, signal) => {
      if (inputs[0] === "Long fact") {
        throw new EmbeddingInputRejected();
      }

      if (inputs[0] === "Last fact" && !interrupted) {
        interrupted = true;
        budget.abort();
        signal.throwIfAborted();
      }

      return inputs.map(() => [1, 0]);
    });

  await start();
  seedFact("Long fact", "fixture topic");
  const first = seedFact("Valid fact", "fixture topic");
  const last = seedFact("Last fact", "other topic", undefined, testProfileIds.reviewer);

  await configure({ recall: true, embedding_model: "fixture" });

  await expect
    .poll(() => engine.db.all("SELECT fact_id FROM viber_memory_vectors ORDER BY rowid"))
    .toEqual([{ fact_id: first }, { fact_id: last }]);

  expect(embed.mock.calls.map(([, inputs]) => inputs[0])).toEqual([
    "Long fact",
    "Valid fact",
    "Last fact",
    "Last fact",
  ]);
});

it("backs off when the index budget expires before any progress", async () => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const budget = new AbortController();

  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
    ms === 120_000 && !budget.signal.aborted ? budget.signal : timeout(ms),
  );

  let expiredAt = 0;

  const identify = vi
    .spyOn(localMemoryModels, "identify")
    .mockImplementationOnce(async (_model, signal) => {
      expiredAt = performance.now();
      budget.abort();
      signal.throwIfAborted();
      return "digest";
    })
    .mockResolvedValue("digest");

  vi.spyOn(localMemoryModels, "embed").mockResolvedValue([
    [1, 0],
    [1, 0],
  ]);

  await start();
  seedFact("Valid fact", "fixture topic");
  await configure({ recall: true, embedding_model: "fixture" });
  await expect.poll(vectorCount, { timeout: 3000 }).toBe(1);
  expect(identify).toHaveBeenCalledTimes(3);
  expect(performance.now() - expiredAt).toBeGreaterThanOrEqual(950);
});

it("learns from completed user evidence, corrects an explicit replacement and withholds ambiguous changes", async () => {
  const propose = vi.spyOn(localMemoryModels, "suggest").mockResolvedValue([]);
  await start();
  const session = await create();
  const java = "For DSA examples, use Java from now on.";
  expect(engine.memory.suggestionSignal(java)).toBeUndefined();
  await configure({ automatic_saving: true, suggestion_model: "fixture-suggester" });

  const learn = (
    content: string,
    evidence = content,
    status: "completed" | "failed" = "completed",
    suggestions = true,
  ) => {
    const scope = turn(session);

    engine.viberSessions.store.capture({
      session_id: scope.sessionId,
      profile_id: profileId,
      request_id: scope.messageId,
      content,
      history_ids: [],
    });

    engine.viberSessions.store.finish(scope.messageId, status, { summary: "Fixture response" });
    const signal = engine.memory.suggestionSignal(content);
    if (signal) {
      engine.memory.learn(
        scope,
        content,
        suggestions
          ? [{ action: "save_memory", text: "A model paraphrase", evidence, topic: "DSA" }]
          : [],
        signal,
      );
    }

    return scope.messageId;
  };

  learn(java, java, "failed");
  learn("Can you explain this?", java);
  learn("For this task, use Java.");
  learn("README says: For DSA examples, use Java from now on.");
  learn("For DSA examples, use password abcdef from now on.");
  const message = learn(java);

  await expect.poll(facts).toEqual([
    expect.objectContaining({
      text: java,
      topic: "DSA examples",
      source_message_id: message,
    }),
  ]);

  expect(propose).not.toHaveBeenCalled();
  const id = facts()[0].id;
  const correction = "Correction: For DSA examples, use Python from now on.";
  learn(correction);

  await expect
    .poll(facts)
    .toEqual([expect.objectContaining({ id, text: "For DSA examples, use Python from now on." })]);

  learn("For DSA examples, use C++ from now on.");
  await expect.poll(() => facts().map((fact) => fact.needs_review)).toEqual([1, 1]);
  expect(vectorCount()).toBe(0);

  learn("Correction: For DSA examples, use C++ from now on.");

  await expect
    .poll(() =>
      facts()
        .filter(({ needs_review }) => !needs_review)
        .map(({ text }) => text),
    )
    .toEqual(["For DSA examples, use C++ from now on."]);

  learn("For database examples, use SQL from now on.", undefined, "completed", false);
  await expect.poll(() => propose.mock.calls.length).toBe(1);

  expect(propose).toHaveBeenCalledWith(
    "fixture-suggester",
    "For database examples, use SQL from now on.",
    expect.any(AbortSignal),
  );
});

it.each(["codex", "antigravity"] as const)(
  "saves and indexes a fact after a simulated %s reply",
  async (provider) => {
    const evidence = "For DSA examples, use Java from now on.";
    const reply = "I'll use Java for those examples.";

    const suggestion = {
      action: "save_memory",
      text: "Use Java for DSA examples.",
      evidence,
      topic: "DSA",
    };

    const adapter = provider === "codex" ? new CodexProvider() : new AntigravityProvider();
    const extract = vi.spyOn(localMemoryModels, "suggest").mockResolvedValue([suggestion]);
    vi.spyOn(localMemoryModels, "identify").mockResolvedValue("digest");

    vi.spyOn(localMemoryModels, "embed").mockImplementation(async (_model, inputs) =>
      inputs.map(() => [1, 0]),
    );

    await start(() => ({
      ...adapter,
      detect: async () => {
        const detected = await detectFixtureProvider();
        if (provider === "codex") {
          detected.capabilities.push("native-memory-suggestions");
        }

        return { ...detected, provider };
      },
      invocation: (request) => {
        const invocation = adapter.invocation(request);

        const setup = `
const emit = value => console.log(JSON.stringify(value));
const threadId = ${JSON.stringify(request.runId)};
const reply = ${JSON.stringify(reply)};
const read = handler => require('node:readline').createInterface({input:process.stdin}).on('line', line => handler(JSON.parse(line)));
`;

        const script =
          provider === "codex"
            ? `
${setup}
read(message => {
  if (message.method === 'initialize') emit({ id: message.id, result: {} });
  if (message.method === 'thread/start') {
    if (message.params.dynamicTools?.[0]?.name !== 'save_memory') process.exit(4);
    emit({ id: message.id, result: { thread: { id: threadId } } });
  }
  if (message.method === 'turn/start') {
    emit({ id: message.id, result: { turn: { id: 'turn' } } });
    const { action, ...args } = ${JSON.stringify(suggestion)};
    emit({ id: 10, method: 'item/tool/call', params: { tool: action, threadId, turnId: 'turn', arguments: args } });
  }
  if (message.id === 10) {
    if (message.result?.success !== true) process.exit(5);
    emit({ method: 'item/completed', params: { item: { id: 'reply', type: 'agentMessage', text: reply } } });
    emit({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  }
});`
            : `
${setup}
emit({ event: 'init', conversation_id: threadId });
read(() => emit({ event: 'result', result: { status: 'SUCCESS', response: reply, conversation_id: threadId } }));`;

        return { ...invocation, program: process.execPath, args: ["-e", script] };
      },
    }));

    await configure({
      automatic_saving: true,
      recall: true,
      embedding_model: "fixture",
      suggestion_model: "fixture-extractor",
    });

    const session = await create(undefined, provider);

    await expect(
      rpc.call("viber.memory.create", { profile_id: profileId, text: evidence }),
    ).rejects.toMatchObject({ kind: "invalid_method" });

    expect(facts()).toEqual([]);

    const requestId = await send(session, evidence);

    expect(
      engine.viberSessions.detail(session.id, profileId).messages.map(({ content }) => content),
    ).toEqual([evidence, reply]);

    await expect.poll(facts).toEqual([
      expect.objectContaining({
        text: evidence,
        topic: "DSA examples",
        source_message_id: requestId,
        source_session_id: session.id,
      }),
    ]);

    await expect.poll(vectorCount).toBe(1);
    if (provider === "antigravity") {
      expect(extract).toHaveBeenCalledWith("fixture-extractor", evidence, expect.any(AbortSignal));
    } else {
      expect(extract).not.toHaveBeenCalled();
    }

    const saved = facts();
    await rpc.close();
    await engine.close();
    await start();
    expect(facts()).toEqual(saved);
  },
);

const captureMemory = (session: ViberSession, content: string, topic: string | null = null) => {
  const scope = turn(session);

  engine.viberSessions.store.capture({
    session_id: session.id,
    profile_id: profileId,
    request_id: scope.messageId,
    content,
    history_ids: [],
  });

  engine.viberSessions.store.finish(scope.messageId, "completed", { summary: "Fixture" });

  const learn = () => {
    engine.memory.learn(
      scope,
      content,
      [{ action: "save_memory", text: content, evidence: content, topic }],
      engine.memory.suggestionSignal(content)!,
    );
  };

  return { learn, id: scope.messageId };
};

it.each(["learned", "legacy"])(
  "recalls only the corrected topicless project default after replacing a %s fact",
  async (source) => {
    const original = "This project defaults to tabs.";
    const corrected = "this project defaults to spaces.";
    vi.spyOn(localMemoryModels, "identify").mockResolvedValue("digest");

    vi.spyOn(localMemoryModels, "embed").mockImplementation(async (_model, inputs) => {
      const vectors: Record<string, number[]> = {
        [original]: [0.8, 0.6],
        [corrected]: [0.8, -0.6],
      };

      return inputs.map((input) => vectors[input] ?? [1, 0]);
    });

    await start();
    const { repo } = await fixtureRepository(engine, dir);
    const otherRepo = { ...repo, id: randomUUID(), name: "another-repository" };
    engine.db.saveRepository(otherRepo);
    const session = await create(repo.id);
    const otherId = seedFact(original, undefined, otherRepo.id);

    await configure({
      automatic_saving: true,
      recall: true,
      embedding_model: "fixture",
    });

    if (source === "legacy") {
      seedFact(original, undefined, repo.id);
    } else {
      captureMemory(session, original).learn();
    }

    const recall = async () => {
      const pick = await engine.memory.prepareRecall(
        turn(session),
        "Which indentation should I use?",
        new AbortController().signal,
      );

      return pick?.().map(({ text }) => text);
    };

    await expect.poll(recall).toEqual([original]);
    const id = facts()[1].id;
    captureMemory(session, "Actually, " + corrected).learn();

    await expect.poll(recall).toEqual([corrected]);

    expect(facts()).toEqual([
      expect.objectContaining({ id: otherId, text: original, topic: null, revision: 1 }),
      expect.objectContaining({ id, text: corrected, topic: null, revision: 2 }),
    ]);
  },
);

it("learns independent project facts and polarity while honoring submission order", async () => {
  await start();
  const { repo } = await fixtureRepository(engine, dir);
  const session = await create(repo.id);
  await configure({ automatic_saving: true });

  const capture = (content: string, topic?: string) => captureMemory(session, content, topic);

  capture("This project uses React.").learn();
  capture("This project uses SQLite.").learn();
  const recursion = "recursion";
  capture("Always use recursion.", recursion).learn();
  await expect.poll(() => facts().map(({ needs_review }) => needs_review)).toEqual([0, 0, 0]);

  expect(
    facts()
      .slice(0, 2)
      .map(({ text }) => text),
  ).toEqual(["This project uses React.", "This project uses SQLite."]);

  const initial = facts()[2].id;
  const older = capture("Correction: Always use recursion.", recursion);
  const newer = capture("Actually, always avoid recursion.", recursion);
  newer.learn();

  await expect
    .poll(() => facts()[2])
    .toMatchObject({
      id: initial,
      text: "always avoid recursion.",
      revision: 2,
      source_message_id: newer.id,
    });

  older.learn();
  const stale = capture("Actually, always use recursion.", recursion);
  const equivalent = capture("Never use recursion.", recursion);
  equivalent.learn();

  await expect
    .poll(() => facts()[2])
    .toMatchObject({
      text: "always avoid recursion.",
      revision: 2,
      source_message_id: equivalent.id,
    });

  stale.learn();
  capture("This project targets Linux.").learn();
  await expect.poll(() => facts()).toHaveLength(4);

  expect(facts()[2]).toMatchObject({
    id: initial,
    text: "always avoid recursion.",
    revision: 2,
    needs_review: 0,
    source_message_id: equivalent.id,
  });
});

it("cannot re-index a retired Viber's facts when a pending embedding returns", async () => {
  vi.spyOn(localMemoryModels, "identify").mockResolvedValue("digest");
  let finishEmbedding: (value: number[][]) => void = () => {};

  const waiting = new Promise<number[][]>((resolve) => {
    finishEmbedding = resolve;
  });

  const embed = vi
    .spyOn(localMemoryModels, "embed")
    .mockReturnValueOnce(waiting)
    .mockImplementation(async (_model, inputs) => inputs.map(() => [1, 0]));

  await start();
  seedFact("Use Python examples.", "coding");
  const kept = seedFact("Use Java for exercises.", "coding", undefined, testProfileIds.reviewer);
  await configure({ recall: true, embedding_model: "fixture" });
  try {
    await expect.poll(() => embed.mock.calls.length).toBe(1);
    await rpc.call("profile.delete", { profile_id: profileId, confirmed: true });

    finishEmbedding([
      [1, 0],
      [1, 0],
    ]);

    await expect
      .poll(() => engine.db.all("SELECT fact_id FROM viber_memory_vectors"))
      .toEqual([{ fact_id: kept }]);

    expect(
      engine.db.all("SELECT id FROM viber_memory_facts WHERE profile_id=?", profileId),
    ).toEqual([]);
  } finally {
    finishEmbedding([
      [1, 0],
      [1, 0],
    ]);
  }
});

it.each(["reject", "accept-then-fail"])(
  "retries a failed Codex turn with the same thread after %s",
  async (failure) => {
    const adapter = new CodexProvider();
    const fact = "Always use Java.";
    const prompt = "Give me an example.";
    let attempt = 0;
    vi.spyOn(localMemoryModels, "identify").mockResolvedValue("digest");

    vi.spyOn(localMemoryModels, "embed").mockImplementation(async (_model, inputs) =>
      inputs.map(() => [1, 0]),
    );

    await start(() => ({
      ...adapter,
      detect: detectFixtureProvider,
      invocation: (request) => {
        const invocation = adapter.invocation(request);
        const run = attempt++;
        const expected = run === 1 || (run === 2 && failure === "reject");

        const script = `
const emit = value => console.log(JSON.stringify(value));
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') emit({ id: 0, result: {} });
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    if (message.params.threadId !== ${run === 0 ? "undefined" : "'thread'"}) process.exit(4);
    emit({ id: 1, result: { thread: { id: 'thread' } } });
  }
  if (message.method === 'turn/start') {
    if (message.params.input[0].text.includes(${JSON.stringify(fact)}) !== ${expected}) process.exit(4);
    if (${run === 1 && failure === "reject"}) {
      emit({ id: 2, error: { message: 'Admission rejected' } });
      return;
    }
    emit({ id: 2, result: { turn: { id: 'turn' } } });
    emit({ method: 'item/completed', params: { item: { id: 'reply', type: 'agentMessage', text: 'Reply' } } });
    emit({ method: 'turn/completed', params: { turn: { status: ${JSON.stringify(run === 1 ? "failed" : "completed")} } } });
  }
});`;

        return { ...invocation, program: process.execPath, args: ["-e", script] };
      },
    }));

    const session = await create();
    await send(session, "Start a session.");
    seedFact(fact, "coding examples");
    await configure({ recall: true, embedding_model: "fixture" });
    await expect.poll(vectorCount).toBe(1);

    const shares = () => engine.db.all("SELECT thread_id,in_context FROM viber_memory_shares");
    await send(session, prompt, "codex", "failed");
    expect(shares()).toEqual(failure === "reject" ? [] : [{ thread_id: "thread", in_context: 1 }]);

    await send(session, prompt, "codex", "completed", true);
    expect(shares()).toEqual([{ thread_id: "thread", in_context: 1 }]);
  },
);

it("dispatches isolated Antigravity reference text and keeps replies out of logs and provider handoffs", async () => {
  const adapter = new AntigravityProvider();
  const fact = "Use Java for coding examples.";
  const requests: AgentRunRequest[] = [];
  const cliInputs: string[] = [];
  vi.spyOn(localMemoryModels, "identify").mockResolvedValue("digest");

  vi.spyOn(localMemoryModels, "embed").mockImplementation(async (_model, inputs) =>
    inputs.map(() => [1, 0]),
  );

  await start((_stage, provider) => ({
    ...adapter,
    name: provider ?? adapter.name,
    detect: async () => ({
      ...(await detectFixtureProvider()),
      provider: provider ?? "antigravity",
    }),
    invocation: (request) => {
      requests.push(request);
      const invocation = adapter.invocation(request);
      const thread = request.conversation?.threadId ?? request.runId;
      const expected = cliInputs.length === 0;

      const script = `
const expected = ${expected};
const thread = ${JSON.stringify(thread)};
const fact = ${JSON.stringify(fact)};
const emit = value => console.log(JSON.stringify(value));
emit({event:'init',conversation_id:thread,init:{model:'next-model'}});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const { message: { content } } = JSON.parse(line);
  if (content.includes(fact) !== expected) process.exit(4);
  if (expected) {
    emit({event:'user',message:{content}});
  }
  if (thread === ${JSON.stringify(requests[0].runId)}) console.error(fact);
  emit({event:'result',result:{status:'SUCCESS',response:thread === ${JSON.stringify(requests[0].runId)} ? fact : 'Normal response',conversation_id:thread}});
});`;

      cliInputs.push(request.runId);
      return { ...invocation, program: process.execPath, args: ["-e", script] };
    },
  }));

  const id = seedFact(fact, "coding examples");

  await configure({
    recall: true,
    embedding_model: "fixture",
  });

  await expect.poll(vectorCount).toBe(1);
  const session = await create(undefined, "antigravity");

  const prompt = "Walk me through Two Sum.";
  await send(session, prompt);
  const detail = engine.viberSessions.detail(session.id, profileId);
  expect(detail.messages.map(({ content }) => content)).toEqual([prompt, fact]);
  expect(requests[0].prompt).not.toContain(fact);
  expect(JSON.stringify(detail.events)).not.toContain(fact);
  expect(JSON.stringify(detail.runs)).not.toContain(fact);

  const expectPrivateLogs = async (runId: string) => {
    for (const suffix of [".jsonl", ".stderr.log"]) {
      expect(
        await readFile(
          join(engine.root, "logs", `viber-${session.id}`, `${runId}${suffix}`),
          "utf8",
        ),
      ).not.toContain(fact);
    }
  };

  await expectPrivateLogs(requests[0].runId);

  await send(session, "A related follow-up.");
  expect(requests[1].conversation?.threadId).toBe(requests[0].runId);
  expect(engine.viberSessions.detail(session.id, profileId).messages.at(-1)?.content).toBe(fact);
  await expectPrivateLogs(requests[1].runId);
  await configure({ recall: false });
  await send(session, "Continue with the other provider.", "codex");
  expect(requests[2].prompt).not.toContain(fact);

  await send(session, "/clear");
  expect(requests).toHaveLength(3);

  expect(facts()).toEqual([expect.objectContaining({ id, text: fact })]);

  expect(engine.db.all("SELECT provider FROM viber_memory_shares WHERE fact_id=?", id)).toEqual([
    { provider: "antigravity" },
  ]);
});
