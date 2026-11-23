import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { Rpc } from "../../apps/core/rpc";
import { AntigravityProvider } from "../../apps/core/execution/providers/antigravity";
import type { AgentRunRequest } from "../../apps/core/execution/providers/contracts";
import type { Settings } from "../../apps/core/domain";
import type { ViberSession } from "../../apps/core/vibers/contracts";
import { localMemoryModels } from "../../apps/core/vibers/memory-local";
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

const add = (text: string, topic?: string, repo?: string, profile_id: string = profileId) =>
  engine.memory.create({ profile_id, text, repository_id: repo, topic });

const facts = () => engine.memory.list({ profile_id: profileId });
const vectorCount = () => engine.db.all("SELECT 1 FROM viber_memory_vectors").length;
const codexSharing = { codex: true, antigravity: false } as const;

it("gates lookup locally, ranks within the Viber and repo or topic, and rechecks consent, revisions and thread history", async () => {
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
  const first = add("First useful fact", "tests");
  add("First useful fact", undefined, repo.id);
  add("Second useful fact", undefined, repo.id);
  add("Third useful fact", "tests");
  add("Fourth useful fact", undefined, repo.id);
  add("Private elsewhere", undefined, foreign.id);
  add("Private Viber", "tests", undefined, testProfileIds.reviewer);
  add("Private topic", "off-topic");
  add("Weak match", undefined, repo.id);
  add("Panel-only fact");

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
  embed.mockClear();
  expect(await recall()).toBeUndefined();
  expect(embed).not.toHaveBeenCalled();

  await configure({ share_with: codexSharing });
  expect(await recall("antigravity")).toBeUndefined();
  const pick = (await recall())!;
  const matches = pick("native-thread");

  expect(matches.map(({ text }) => text)).toEqual([
    "First useful fact",
    "Second useful fact",
    "Third useful fact",
  ]);

  engine.memory.recordShares(turn(session), "native-thread", matches);
  expect(pick("native-thread").map(({ text }) => text)).toEqual(["Fourth useful fact"]);
  expect(pick("new-thread")).toEqual(matches);

  expect(facts().find(({ id }) => id === first.id)?.shared).toEqual([
    { provider: "codex", at: expect.any(String), earlier_revision: false },
  ]);

  engine.memory.compact(turn(session), "native-thread");
  expect(pick("native-thread")).toEqual(matches);
  engine.memory.forget({ profile_id: profileId, id: first.id });
  expect(pick().map(({ id }) => id)).not.toContain(first.id);
  await configure({ share_with: { codex: false, antigravity: false } });
  expect(pick()).toEqual([]);

  await configure({ embedding_model: "fixture-v2", share_with: codexSharing });

  await expect
    .poll(() => engine.db.all("SELECT DISTINCT model,dimensions FROM viber_memory_vectors"))
    .toEqual([{ model: "fixture-v2", dimensions: 5 }]);

  expect(pick()).toEqual([]);
  expect(engine.db.all("PRAGMA foreign_key_check")).toEqual([]);
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
      source: expect.objectContaining({ message_id: message }),
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
  await expect.poll(() => facts().map((fact) => fact.needs_review)).toEqual([true, true]);
  expect(vectorCount()).toBe(0);

  learn("For database examples, use SQL from now on.", undefined, "completed", false);
  await expect.poll(() => propose.mock.calls.length).toBe(1);

  expect(propose).toHaveBeenCalledWith(
    "fixture-suggester",
    "For database examples, use SQL from now on.",
    expect.any(AbortSignal),
  );
});

it("cannot re-index a forgotten fact when a pending embedding returns", async () => {
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
  const forgotten = add("Use Python examples.", "coding");
  await configure({ recall: true, embedding_model: "fixture" });
  try {
    await expect.poll(() => embed.mock.calls.length).toBe(1);
    engine.memory.forget({ profile_id: profileId, id: forgotten.id });
    const kept = add("Use Java for exercises.", "coding");

    finishEmbedding([
      [1, 0],
      [1, 0],
    ]);

    await expect
      .poll(() => engine.db.all("SELECT fact_id FROM viber_memory_vectors"))
      .toEqual([{ fact_id: kept.id }]);
  } finally {
    finishEmbedding([
      [1, 0],
      [1, 0],
    ]);
  }
});

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
    console.error(fact);
  }
  emit({event:'result',result:{status:'SUCCESS',response:expected ? fact : 'Normal response',conversation_id:thread}});
});`;

      cliInputs.push(request.runId);
      return { ...invocation, program: process.execPath, args: ["-e", script] };
    },
  }));

  await configure({
    recall: true,
    share_with: { codex: false, antigravity: true },
    embedding_model: "fixture",
  });

  const { id } = add(fact, "coding examples");
  await expect.poll(vectorCount).toBe(1);
  const session = await create(undefined, "antigravity");

  const send = async (content: string, provider = session.selection.provider) => {
    const request_id = randomUUID();

    await rpc.call("viber.session.send", {
      session_id: session.id,
      profile_id: profileId,
      request_id,
      content,
      history_ids: [],
      selection: { ...session.selection, provider },
    });

    await expect
      .poll(
        () =>
          engine.viberSessions.store
            .detail(session.id, profileId)
            .messages.find(({ id }) => id === request_id)?.status,
      )
      .toBe("completed");

    await expect.poll(() => engine.isActive(`viber:${session.id}`)).toBe(false);
  };

  const prompt = "Walk me through Two Sum.";
  await send(prompt);
  const detail = engine.viberSessions.detail(session.id, profileId);
  expect(detail.messages.map(({ content }) => content)).toEqual([prompt, fact]);
  expect(requests[0].prompt).not.toContain(fact);
  expect(JSON.stringify(detail.events)).not.toContain(fact);
  expect(JSON.stringify(detail.runs)).not.toContain(fact);
  for (const suffix of [".jsonl", ".stderr.log"]) {
    expect(
      await readFile(
        join(engine.root, "logs", `viber-${session.id}`, `${requests[0].runId}${suffix}`),
        "utf8",
      ),
    ).not.toContain(fact);
  }

  await send("A related follow-up.");
  expect(requests[1].conversation?.threadId).toBe(requests[0].runId);
  await send("Continue with the other provider.", "codex");
  expect(requests[2].prompt).not.toContain(fact);

  await send("/clear");
  expect(requests).toHaveLength(3);

  expect(facts()).toEqual([
    expect.objectContaining({
      id,
      text: fact,
      shared: [expect.objectContaining({ provider: "antigravity" })],
    }),
  ]);
});
