import { it, expect, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  readdir,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../backend/execution/engine";
import { defaultSettings, parseIssue, now, type Task } from "../backend/domain";
import { Usage } from "../backend/execution/usage";
import { ActionSchema } from "../backend/scheduled/action";
import { StorageService } from "../backend/storage/service";
import { Database } from "../backend/storage/database";
import { migrateDataRoot } from "../backend/storage/migrate-root";
import { dataRootChoice, chooseDataRoot } from "../backend/storage/bootstrap";
import { checked } from "../backend/execution/process";
import { discoveryRoot } from "../backend/workspace/discovery";
import { createLayout } from "../backend/workspace/paths";
import {
  fixtureRepository,
  FixtureProvider,
  finishFixtureTask as waitForTask,
} from "./fixtures";

it.each([1, 2])(
  "persists instructions before execution and resumes cancelled planning stage %i",
  async (stage) => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-chat-"));
    let release = () => {};
    let notify = () => {};
    const entered = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blocked = false;
    const engine = await Engine.create(
      join(dir, "data"),
      (current) =>
        new FixtureProvider(async () => {
          if (current === stage && !blocked) {
            blocked = true;
            notify();
            await gate;
          }
        }),
    );
    try {
      const { repo } = await fixtureRepository(engine, dir);
      const task = engine.enqueue(
        repo,
        parseIssue("https://github.com/fixture/fixture/issues/1"),
        "Task A",
        "",
        {},
      );
      if (stage === 2) {
        await waitForTask(
          engine,
          task.id,
          (status) => status === "awaiting_approval",
        );
        await vi.waitFor(() => expect(engine.isActive(task.id)).toBe(false));
        await engine.approveStage(task.id);
      }
      await entered;
      expect(
        engine.followUp(task.id, "Include regression coverage"),
      ).toMatchObject({ disposition: "queued" });
      expect(engine.db.detail(task.id).messages[0]).toMatchObject({
        content: "Include regression coverage",
        status: "queued",
      });
      engine.cancel(task.id);
      release();
      await waitForTask(engine, task.id, (status) => status === "cancelled");
      expect(
        engine.followUp(task.id, "Resume with the saved instruction"),
      ).toMatchObject({ disposition: "resume_planning" });
      await waitForTask(engine, task.id, (status) =>
        ["ready_for_review", "failed"].includes(status),
      );
      expect(engine.db.task(task.id).status).toBe("ready_for_review");
      const run = engine.db
        .detail(task.id)
        .runs.filter((r) => r.stage === stage)
        .at(-1)!;
      expect(run.prompt).toContain("Resume with the saved instruction");
      expect(run.prompt).toContain("Include regression coverage");
      expect(run.status).toBe("completed");
    } finally {
      release();
      await engine.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
  30000,
);

it("keeps the provider sequence after explicitly reviewed planning feedback when a different chat provider is queued during planning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-queued-planning-"));
  let release = () => {};
  let notify = () => {};
  const entered = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let blocked = false;
  const providers: { stage: number; name?: string }[] = [];
  const engine = await Engine.create(join(dir, "data"), (stage, name) => {
    providers.push({ stage, name });
    return new FixtureProvider(async () => {
      if (stage === 1 && !blocked) {
        blocked = true;
        notify();
        await gate;
      }
    });
  });
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const task = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/1"),
      "Task A",
      "",
      {},
    );
    await entered;
    engine.followUp(task.id, "Include a regression test", {
      provider: "antigravity",
      config: { model: "next-model", effort: "low", timeout_secs: 30 },
    });
    release();
    await waitForTask(engine, task.id, (status) =>
      ["ready_for_review", "failed"].includes(status),
    );
    expect(engine.db.task(task.id).status).toBe("ready_for_review");
    expect(providers).toEqual([
      { stage: 1, name: undefined },
      { stage: 1, name: undefined },
      { stage: 2, name: undefined },
      { stage: 3, name: undefined },
      { stage: 5, name: "antigravity" },
    ]);
    expect(
      engine.db.detail(task.id).runs.find((r) => r.stage === 2)?.prompt,
    ).toContain("Include a regression test");
    expect(engine.db.detail(task.id).messages[0].status).toBe("delivered");
  } finally {
    release();
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

it("keeps a user message when the selected model fails validation, and records every attempted run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-usage-"));
  const engine = await Engine.create(
    join(dir, "data"),
    () => new FixtureProvider(),
  );
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const task = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/1"),
      "Task A",
      "",
      {},
    );
    await waitForTask(
      engine,
      task.id,
      (status) => status === "ready_for_review",
    );
    const saved = engine.followUp(task.id, "Keep this message after failure", {
      provider: "codex",
      config: { model: "unknown", effort: "high", timeout_secs: 30 },
    });
    expect(
      engine.db.detail(task.id).messages.some((m) => m.id === saved.message.id),
    ).toBe(true);
    await waitForTask(engine, task.id, (status) => status === "failed");
    expect(engine.db.detail(task.id).messages.at(-1)?.content).toBe(
      "Keep this message after failure",
    );
    const usage = new Usage(engine.db).list(task.id);
    expect(usage).toHaveLength(5);
    expect(usage[0]).toMatchObject({
      provider: "codex",
      model: "unknown",
      purpose: "Chat Follow-up",
      status: "failed",
      input_tokens: null,
      total_tokens: null,
    });
    expect(
      usage.every((r) => r.duration_ms !== null && r.duration_ms >= 0),
    ).toBe(true);
    engine.db.saveSettings({
      ...defaultSettings,
      utility_ai: {
        provider: "codex",
        model: "next-model",
        effort: "low",
        timeout_secs: 30,
      },
    });
    await engine.utility.run({
      purpose: "Utility AI",
      prompt: "Classify review",
      schema: ActionSchema,
    });
    expect(new Usage(engine.db).list()[0]).toMatchObject({
      purpose: "Utility AI",
      model: "next-model",
      effort: "low",
      status: "completed",
    });
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

it("honors the selected checkout for an older deferred clone registration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-deferred-import-"));
  const engine = await Engine.create(
    join(dir, "data"),
    () => new FixtureProvider(),
  );
  try {
    const { upstream } = await fixtureRepository(engine, dir);
    const home = join(dir, "home");
    await mkdir(home);
    const paths = [join(home, "a-oppia"), join(home, "z-oppia")];
    for (const path of paths) {
      await checked("git", ["clone", upstream, path], dir);
      await checked(
        "git",
        ["remote", "set-url", "origin", "https://github.com/oppia/oppia.git"],
        path,
      );
    }
    engine.db.saveSettings({
      ...defaultSettings,
      repository_discovery: { roots: [home], max_depth: 4, scan_home: false },
    });
    const registered = await engine.register(
      "https://github.com/oppia/oppia.git",
      null,
      "main",
      true,
    );
    const deferred = {
      ...registered,
      source: "managed" as const,
      path: join(engine.root, "repos", registered.id),
    };
    engine.db.saveRepository(deferred);
    const clone = vi.spyOn(engine.git, "clone");
    await engine.prepareClone(deferred, undefined, paths[1]);
    expect(engine.db.repository(deferred.id)).toMatchObject({
      source: "imported",
      path: paths[1],
    });
    expect(clone).not.toHaveBeenCalled();
    expect(await readFile(join(paths[0], "source.txt"), "utf8")).toBe("base\n");
    expect(await readFile(join(paths[1], "source.txt"), "utf8")).toBe("base\n");
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

it("stores only reported token counts and keeps totals unavailable when absent", () => {
  const db = new Database(":memory:");
  try {
    const usage = new Usage(db);
    usage.start("run", {
      task_id: null,
      job_id: null,
      repository: null,
      purpose: "Utility AI",
      provider: "codex",
      model: "",
      effort: "high",
    });
    expect(usage.list()[0].total_tokens).toBeNull();
    usage.observe("run", {
      usage: {
        input_tokens: 42,
        cached_input_tokens: 10,
        output_tokens: 7,
        reasoning_tokens: 3,
        total_tokens: 49,
      },
    });
    usage.observe("run", { usage: { total_tokens: -1, output_tokens: "100" } });
    expect(usage.list()[0]).toMatchObject({
      input_tokens: 42,
      cached_input_tokens: 10,
      output_tokens: 7,
      reasoning_tokens: 3,
      total_tokens: 49,
    });
    usage.recordLimits("run", {
      reportedAt: now(),
      windows: [
        { usedPercent: 20, windowDurationMins: 300, resetsAt: 2000000000 },
      ],
    });
    expect(usage.list()[0].subscription_limits).toContain('"usedPercent":20');
    usage.observe("run", {
      result: { usage: { thinking_tokens: 12, cache_read_tokens: 5 } },
    });
    expect(usage.list()[0]).toMatchObject({
      reasoning_tokens: 12,
      cached_input_tokens: 5,
    });
    usage.observe("run", { usage: { reasoning_output_tokens: 17 } });
    expect(usage.list()[0].reasoning_tokens).toBe(17);
  } finally {
    db.close();
  }
});

it("indexes an existing checkout and creates isolated worktrees while preserving its files, branch and remotes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-index-"));
  const engine = await Engine.create(
    join(dir, "data"),
    () => new FixtureProvider(),
  );
  try {
    const { upstream } = await fixtureRepository(engine, dir);
    const home = join(dir, "home");
    await mkdir(home);
    const source = join(home, "oppia");
    await checked("git", ["clone", upstream, source], dir);
    await checked(
      "git",
      ["remote", "set-url", "origin", "git@github.com:me/oppia.git"],
      source,
    );
    await checked(
      "git",
      ["remote", "add", "upstream", "https://github.com/oppia/oppia.git"],
      source,
    );
    await writeFile(join(source, "source.txt"), "my uncommitted work\n");
    engine.db.saveSettings({
      ...defaultSettings,
      repository_discovery: { roots: [home], max_depth: 4, scan_home: false },
    });
    const index = await engine.repositoryIndex.scan();
    expect(index.scanning).toBe(false);
    expect(index.repositories[0]).toMatchObject({
      path: source,
      branch: "main",
      identities: ["me/oppia", "oppia/oppia"],
    });
    expect(discoveryRoot("~/oppia", home)).toBe(source);
    expect(() => discoveryRoot("/")).toThrow();
    expect(() => discoveryRoot("/mnt/c")).toThrow();
    const clone = vi.spyOn(engine.git, "clone");
    const imported = await engine.register(
      "https://github.com/oppia/oppia.git",
      "git@github.com:me/oppia.git",
      "main",
      true,
      source,
    );
    await engine.prepareClone(imported);
    expect(clone).not.toHaveBeenCalled();
    expect(imported.source).toBe("imported");
    const before = await checked(
      "git",
      ["status", "--porcelain=v1", "--branch"],
      source,
    );
    const task: Task = {
      id: "isolated-task",
      repo_id: imported.id,
      issue_number: 1,
      issue_url: "https://github.com/oppia/oppia/issues/1",
      claimed_scope: "source.txt",
      notes: "",
      issue: {},
      branch_name: "",
      base_branch: "main",
      base_commit_sha: "",
      worktree_path: "",
      stage: 0,
      status: "cancelled",
      error: null,
      created_at: now(),
      updated_at: now(),
    };
    const offline = { ...imported, upstream_url: upstream };
    await engine.git.prepare(offline, task);
    engine.db.saveTask(task);
    await writeFile(
      join(task.worktree_path, "source.txt"),
      "isolated change\n",
    );
    expect(await readFile(join(source, "source.txt"), "utf8")).toBe(
      "my uncommitted work\n",
    );
    expect(
      await checked("git", ["status", "--porcelain=v1", "--branch"], source),
    ).toBe(before);
    expect(await checked("git", ["remote", "get-url", "origin"], source)).toBe(
      "git@github.com:me/oppia.git",
    );
    expect(task.worktree_path.startsWith(join(engine.root, "worktrees"))).toBe(
      true,
    );
    await new StorageService(engine).removeRepository(imported.id);
    expect(await readFile(join(source, "source.txt"), "utf8")).toBe(
      "my uncommitted work\n",
    );
    expect(await checked("git", ["branch", "--show-current"], source)).toBe(
      "main",
    );
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

it("measures storage and restricts each cleanup action to its selected category", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-storage-"));
  const engine = await Engine.create(join(dir, "data"));
  try {
    await writeFile(join(engine.root, "logs", "sample.log"), "12345");
    await writeFile(join(engine.root, "cache", "sample.bin"), "1234567");
    const storage = new StorageService(engine);
    const sizes = await storage.info();
    expect(sizes.sizes.logs).toBe(5);
    expect(sizes.sizes.cache).toBe(7);
    expect(sizes.total).toBe(
      Object.values(sizes.sizes).reduce((n, s) => n + s, 0),
    );
    await storage.clear("logs");
    expect(await readdir(join(engine.root, "logs"))).toEqual([]);
    expect(
      await readFile(join(engine.root, "cache", "sample.bin"), "utf8"),
    ).toBe("1234567");
    await storage.clear("cache");
    expect(await readdir(join(engine.root, "cache"))).toEqual([]);
    expect(
      (await stat(join(engine.root, "state", "vibestar.sqlite"))).size,
    ).toBeGreaterThan(0);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});
it("recovers an interrupted root migration before activating a partially promoted database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-migration-journal-"));
  const old = await createLayout(join(dir, ".akkco-ade"));
  const target = await createLayout(join(dir, ".akkco-vibestar"));
  const db = new Database(join(old, "state", "vibestar.sqlite"));
  db.saveSettings({ ...defaultSettings, concurrency: 3 });
  const staging = await createLayout(
    join(target, "cache", "migration-1234-abcd"),
  );
  await db.backup(join(staging, "state", "vibestar.sqlite"));
  db.close();
  try {
    await rename(join(staging, "state"), join(target, "state"));
    await writeFile(
      join(target, "runtime", "migration-pending.json"),
      JSON.stringify({ source: old, target, staging }),
    );
    expect((await dataRootChoice(dir, "")).migration).not.toBeNull();
    await expect(
      chooseDataRoot({ old_root: old, new_root: target }, "fresh"),
    ).rejects.toThrow("interrupted migration");
    await migrateDataRoot(old, target);
    expect((await dataRootChoice(dir, "")).migration).toBeNull();
    const migrated = new Database(join(target, "state", "vibestar.sqlite"));
    expect(migrated.settings().concurrency).toBe(3);
    migrated.close();
    expect(await readdir(join(target, "runtime"))).not.toContain(
      "migration-pending.json",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("preserves external worktrees registered with a managed clone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-managed-cleanup-"));
  const engine = await Engine.create(join(dir, "data"));
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const external = join(dir, "external-worktree");
    await checked("git", ["worktree", "add", "--detach", external], repo.path);
    await expect(new StorageService(engine).removeUnused()).rejects.toThrow(
      "registered worktrees",
    );
    expect(await readFile(join(external, "source.txt"), "utf8")).toBe("base\n");
    expect(engine.db.repositories()).toHaveLength(1);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("offers legacy data migration and repairs copied Git worktree pointers without changing the old root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-migration-"));
  const old = join(dir, ".akkco-ade"),
    target = join(dir, ".akkco-vibestar");
  const engine = await Engine.create(old, () => new FixtureProvider());
  let taskId = "";
  let oldWorktree = "";
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const task = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/1"),
      "Task A",
      "",
      {},
    );
    taskId = task.id;
    await waitForTask(
      engine,
      task.id,
      (status) => status === "ready_for_review",
    );
    oldWorktree = engine.db.task(task.id).worktree_path;
    await writeFile(
      join(old, "runtime", "migration-fixture.json"),
      "preserved runtime metadata",
    );
  } finally {
    await engine.close();
  }
  try {
    const choice = await dataRootChoice(dir, "");
    expect(choice.migration).toEqual({ old_root: old, new_root: target });
    await createLayout(target);
    await writeFile(
      join(target, "runtime", "desktop.json"),
      "current desktop preferences",
    );
    await migrateDataRoot(old, target);
    expect((await dataRootChoice(dir, "")).migration).toBeNull();
    expect(
      await readFile(join(target, "runtime", "migration-fixture.json"), "utf8"),
    ).toBe("preserved runtime metadata");
    expect(
      await readFile(join(target, "runtime", "desktop.json"), "utf8"),
    ).toBe("current desktop preferences");
    expect(
      await readFile(join(old, "runtime", "migration-fixture.json"), "utf8"),
    ).toBe("preserved runtime metadata");
    const migrated = await Engine.create(target, () => new FixtureProvider());
    try {
      const task = migrated.db.task(taskId);
      expect(task.worktree_path.startsWith(target)).toBe(true);
      await migrated.git.assertTask(task);
      expect(
        await readFile(join(task.worktree_path, "source.txt"), "utf8"),
      ).toBe("A\n");
      expect(migrated.db.detail(taskId).usage).toHaveLength(4);
      expect(await readFile(join(oldWorktree, "source.txt"), "utf8")).toBe(
        "A\n",
      );
      expect(
        await checked("git", ["rev-parse", "--git-common-dir"], oldWorktree),
      ).toContain(old);
    } finally {
      await migrated.close();
    }
    await expect(migrateDataRoot(old, target)).rejects.toThrow(
      "already contains",
    );
    expect(
      await chooseDataRoot({ old_root: old, new_root: target }, "old"),
    ).toBe(old);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
