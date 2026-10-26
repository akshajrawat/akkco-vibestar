import { beforeEach, afterEach, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { fetchIssue } from "../../backend/workspace/issue";
import { StorageService } from "../../backend/storage/service";
import { createFixtureEngine, fixtureRepository, FixtureProvider } from "../helpers/fixtures";

vi.mock("../../backend/workspace/issue", () => ({ fetchIssue: vi.fn() }));

const context = {
  title: "Fixture issue",
  body: "Fixture requirements",
  labels: [],
  state: "open",
  comments: [],
  linkedPullRequests: [],
  contextWarnings: [],
  url: "https://github.com/fixture/fixture/issues/1",
  number: 1,
  context_fetched_at: "2026-10-20T00:00:00Z",
};

let dir: string;
let engine: Awaited<ReturnType<typeof createFixtureEngine>>;
let provider: FixtureProvider;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(fetchIssue).mockResolvedValue(context);
  dir = await mkdtemp(join(tmpdir(), "vibestar-task-requests-"));
  provider = new FixtureProvider();
  engine = await createFixtureEngine(join(dir, "data"), () => provider);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await engine.close();
  await rm(dir, { recursive: true, force: true });
});

it("shares simultaneous requests, preserves their task through restart and rejects changed payloads without more GitHub reads or agents", async () => {
  const { repo } = await fixtureRepository(engine, dir);
  const request = randomUUID();
  let release!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  vi.mocked(fetchIssue).mockImplementation(async () => {
    await gate;
    return context;
  });

  const calls = vi.spyOn(provider, "invocation");

  const first = engine.createTask(
    repo.id,
    context.url,
    " Task A ",
    "notes",
    "partial",
    undefined,
    request,
  );

  const duplicate = engine.createTask(
    repo.id,
    context.url,
    "Task A",
    "notes",
    "partial",
    undefined,
    request,
  );

  await expect(
    engine.createTask(
      repo.id,
      context.url,
      "Task A",
      "changed notes",
      "partial",
      undefined,
      request,
    ),
  ).rejects.toThrow("different payload");

  release();
  const [a, b] = await Promise.all([first, duplicate]);
  expect(a.id).toBe(b.id);
  expect(fetchIssue).toHaveBeenCalledTimes(1);
  expect(engine.db.task(a.id).status).toBe("not_started");
  expect(engine.db.tasks()).toHaveLength(1);
  expect(calls).toHaveBeenCalledTimes(0);

  expect(engine.db.all("SELECT * FROM task_requests")).toMatchObject([
    { request_id: request, task_id: a.id },
  ]);

  await engine.close();
  engine = await createFixtureEngine(join(dir, "data"), () => provider);
  engine.db.saveSettings({ ...engine.db.settings(), concurrency: 1 });

  expect(
    (
      await engine.createTask(
        repo.id,
        context.url,
        "Task A",
        "notes",
        "partial",
        undefined,
        request,
      )
    ).id,
  ).toBe(a.id);

  expect(fetchIssue).toHaveBeenCalledTimes(1);
  expect(calls).toHaveBeenCalledTimes(0);

  await expect(
    engine.createTask(
      repo.id,
      context.url,
      "different scope",
      "notes",
      "partial",
      undefined,
      request,
    ),
  ).rejects.toThrow("different payload");

  expect(engine.db.tasks()).toHaveLength(1);
});

it("retains a request tombstone after history removal rather than creating another pipeline on retry", async () => {
  const { repo } = await fixtureRepository(engine, dir);
  const request = randomUUID();

  const task = await engine.createTask(
    repo.id,
    context.url,
    "Task A",
    "",
    "partial",
    undefined,
    request,
  );

  await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false));

  await new StorageService(engine).cleanupTask(task.id, {
    worktree: true,
    logs: true,
    artifacts: true,
    history: true,
  });

  expect(engine.db.tasks()).toEqual([]);

  expect(engine.db.all("SELECT task_id FROM task_requests WHERE request_id=?", request)).toEqual([
    { task_id: null },
  ]);

  await expect(
    engine.createTask(repo.id, context.url, "Task A", "", "partial", undefined, request),
  ).rejects.toThrow("history was removed");

  expect(fetchIssue).toHaveBeenCalledTimes(1);
  expect(engine.db.tasks()).toEqual([]);
});

it("rolls back task and request together when reservation fails, then permits an explicit retry", async () => {
  const { repo } = await fixtureRepository(engine, dir);
  const request = randomUUID();
  const run = engine.db.run;

  const spy = vi.spyOn(engine.db, "run").mockImplementation((sql, ...parameters) => {
    if (sql.startsWith("INSERT INTO task_requests")) throw new Error("fixture reservation failure");
    return run(sql, ...parameters);
  });

  await expect(
    engine.createTask(repo.id, context.url, "Task A", "", "partial", undefined, request),
  ).rejects.toThrow("reservation failure");

  expect(engine.db.tasks()).toEqual([]);
  expect(engine.db.all("SELECT * FROM issues")).toEqual([]);
  expect(engine.db.all("SELECT * FROM task_requests")).toEqual([]);
  spy.mockRestore();

  const task = await engine.createTask(
    repo.id,
    context.url,
    "Task A",
    "",
    "partial",
    undefined,
    request,
  );

  expect(engine.db.tasks()).toHaveLength(1);
  expect(engine.db.all("SELECT task_id FROM task_requests")).toEqual([{ task_id: task.id }]);
});

it("settles an interrupted context request before closing persistence and never enqueues it on startup", async () => {
  const { repo } = await fixtureRepository(engine, dir);
  const request = randomUUID();

  vi.mocked(fetchIssue).mockImplementation(
    (_reference, _root, signal) =>
      new Promise((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(new Error("fixture context cancelled")), {
          once: true,
        });
      }),
  );

  const pending = engine.createTask(
    repo.id,
    context.url,
    "Task A",
    "",
    "partial",
    undefined,
    request,
  );

  const rejected = expect(pending).rejects.toThrow("context cancelled");
  await vi.waitFor(() => expect(fetchIssue).toHaveBeenCalledTimes(1));
  await engine.close();
  await rejected;
  engine = await createFixtureEngine(join(dir, "data"), () => provider);
  expect(engine.db.tasks()).toEqual([]);
  expect(engine.db.all("SELECT * FROM task_requests")).toEqual([]);
  expect(engine.db.all("SELECT * FROM ai_usage")).toEqual([]);
});
