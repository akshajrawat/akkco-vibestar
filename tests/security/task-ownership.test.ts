import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  mkdir,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import {
  checked,
  capture,
  processIdentity,
} from "../../backend/execution/process";
import * as commands from "../../backend/workspace/git-command";
import { exists } from "../../backend/workspace/paths";
import { StorageService } from "../../backend/storage/service";
import {
  createFixtureEngine,
  fixtureRepository,
  prepareFixtureTask,
} from "../fixtures";

let dir: string;
let engine: Awaited<ReturnType<typeof createFixtureEngine>>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibestar-task-ownership-"));
  engine = await createFixtureEngine(join(dir, "data"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await engine.close();
  await rm(dir, { recursive: true, force: true });
});
const cleanup = (id: string) =>
  new StorageService(engine).cleanupTask(id, {
    worktree: true,
    logs: false,
    artifacts: false,
    history: false,
  });
const reopen = async () => {
  await engine.close();
  engine = await createFixtureEngine(join(dir, "data"));
};

it.each(["tracked", "untracked", "ignored", "hidden"])(
  "preserves %s work and history during cleanup",
  async (kind) => {
    const { repo } = await fixtureRepository(engine, dir);
    const task = await prepareFixtureTask(engine, repo, kind);
    const name =
      kind === "ignored"
        ? "ignored.txt"
        : kind === "untracked"
          ? "personal.txt"
          : "source.txt";
    await writeFile(join(task.worktree_path, name), "preserve these bytes\n");
    if (kind === "hidden")
      await checked(
        "git",
        ["update-index", "--assume-unchanged", "source.txt"],
        task.worktree_path,
      );
    await expect(cleanup(task.id)).rejects.toThrow("local changes");
    expect(await readFile(join(task.worktree_path, name), "utf8")).toBe(
      "preserve these bytes\n",
    );
    expect(engine.db.task(task.id).worktree_path).toBe(task.worktree_path);
    expect(
      await checked("git", ["rev-parse", task.branch_name], repo.path),
    ).toBe(task.base_commit_sha);
    expect(await readFile(join(repo.path, "source.txt"), "utf8")).toBe(
      "base\n",
    );
  },
);

it("reconciles creation before ownership markers using the saved intent and exact Git creation evidence", async () => {
  const { repo } = await fixtureRepository(engine, dir);
  const task = await prepareFixtureTask(engine, repo, "partial-creation");
  const gitdir = await checked(
    "git",
    ["rev-parse", "--absolute-git-dir"],
    task.worktree_path,
  );
  await rm(join(gitdir, "vibestar-task-owner"));
  await checked(
    "git",
    ["config", "--unset", `branch.${task.branch_name}.vibestarTask`],
    repo.path,
  );
  engine.db.saveTask({
    ...task,
    stage: 0,
    status: "preparing",
    branch_owned: false,
    workspace_checkpoint: { ...task.workspace_checkpoint!, state: "creating" },
  });
  await reopen();
  const saved = engine.db.task(task.id);
  expect(saved).toMatchObject({
    stage: 1,
    status: "interrupted",
    branch_owned: true,
    workspace_checkpoint: { state: "ready", operation: null },
  });
  expect(await readFile(join(gitdir, "vibestar-task-owner"), "utf8")).toBe(
    task.id,
  );
  expect(engine.db.all("SELECT * FROM ai_usage")).toEqual([]);
  expect(await readFile(join(repo.path, "source.txt"), "utf8")).toBe("base\n");
});

it.each(["registered", "unregistered"])(
  "retains a missing %s worktree checkpoint on startup and restores it only explicitly",
  async (kind) => {
    const { repo } = await fixtureRepository(engine, dir);
    const task = await prepareFixtureTask(engine, repo, `missing-${kind}`);
    if (kind === "registered")
      await rm(task.worktree_path, { recursive: true });
    else
      await checked(
        "git",
        ["worktree", "remove", "--", task.worktree_path],
        repo.path,
      );
    engine.db.saveTask({
      ...task,
      stage: 0,
      status: "preparing",
      workspace_checkpoint: {
        ...task.workspace_checkpoint!,
        state: "creating",
      },
    });
    await reopen();
    const saved = engine.db.task(task.id);
    expect(saved).toMatchObject({
      stage: 0,
      status: "interrupted",
      worktree_path: task.worktree_path,
      branch_name: task.branch_name,
    });
    expect(await exists(task.worktree_path)).toBe(false);
    expect(
      await engine.git.recoverTaskPreparation(repo, saved, engine.db.saveTask),
    ).toBe(true);
    expect(
      await checked("git", ["rev-parse", "HEAD"], task.worktree_path),
    ).toBe(task.base_commit_sha);
    expect(engine.db.all("SELECT * FROM ai_usage")).toEqual([]);
  },
);

it.each(["owner", "head"])(
  "refuses interrupted creation with a changed %s without blocking other history",
  async (kind) => {
    const { repo } = await fixtureRepository(engine, dir);
    const task = await prepareFixtureTask(engine, repo, "foreign");
    const other = await prepareFixtureTask(engine, repo, "other", 2);
    if (kind === "owner") {
      const gitdir = await checked(
        "git",
        ["rev-parse", "--absolute-git-dir"],
        task.worktree_path,
      );
      await writeFile(join(gitdir, "vibestar-task-owner"), "another-task");
    } else {
      await checked(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "Independent change",
        ],
        task.worktree_path,
      );
    }
    const head = await checked(
      "git",
      ["rev-parse", "HEAD"],
      task.worktree_path,
    );
    engine.db.saveTask({
      ...task,
      stage: 0,
      status: "preparing",
      workspace_checkpoint: {
        ...task.workspace_checkpoint!,
        state: "creating",
      },
    });
    await reopen();
    expect(engine.db.task(task.id)).toMatchObject({
      stage: 0,
      status: "interrupted",
    });
    expect(engine.db.task(task.id).error).toMatch(/ownership|owner|SHA/i);
    expect(engine.db.task(other.id).id).toBe(other.id);
    expect(
      await checked("git", ["rev-parse", "HEAD"], task.worktree_path),
    ).toBe(head);
  },
);

it("resumes cleanup after worktree removal without replaying creation or deleting history", async () => {
  const { repo } = await fixtureRepository(engine, dir);
  const task = await prepareFixtureTask(engine, repo, "cleanup-interrupted");
  const original = commands.gitExecute;
  const spy = vi
    .spyOn(commands, "gitExecute")
    .mockImplementation(async (request) => {
      if (request.args[0] === "update-ref")
        throw new Error("fixture interruption before ref deletion");
      return original(request);
    });
  await expect(cleanup(task.id)).rejects.toThrow("fixture interruption");
  spy.mockRestore();
  expect(await exists(task.worktree_path)).toBe(false);
  expect(engine.db.task(task.id).workspace_checkpoint).toMatchObject({
    state: "removing",
    cleanup_head: task.base_commit_sha,
    operation: null,
  });
  await reopen();
  expect(await exists(task.worktree_path)).toBe(false);
  await cleanup(task.id);
  expect(engine.db.task(task.id)).toMatchObject({
    worktree_path: "",
    branch_name: "",
    workspace_checkpoint: { state: "removed" },
  });
  expect(
    (
      await capture(
        "git",
        ["show-ref", "--verify", `refs/heads/${task.branch_name}`],
        repo.path,
      )
    ).code,
  ).not.toBe(0);
});

it("preserves a branch changed between cleanup verification and expected-SHA deletion", async () => {
  const { repo } = await fixtureRepository(engine, dir);
  const task = await prepareFixtureTask(engine, repo, "cleanup-race");
  const alternate = await checked(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit-tree",
      `${task.base_commit_sha}^{tree}`,
      "-p",
      task.base_commit_sha,
      "-m",
      "Concurrent branch change",
    ],
    repo.path,
  );
  const original = commands.gitExecute;
  vi.spyOn(commands, "gitExecute").mockImplementation(async (request) => {
    if (request.args[0] === "update-ref" && request.args[1] === "-d")
      await checked(
        "git",
        [
          "update-ref",
          `refs/heads/${task.branch_name}`,
          alternate,
          task.base_commit_sha,
        ],
        repo.path,
      );
    return original(request);
  });
  await expect(cleanup(task.id)).rejects.toThrow("Git cleanup stopped");
  expect(await checked("git", ["rev-parse", task.branch_name], repo.path)).toBe(
    alternate,
  );
  expect(engine.db.task(task.id).branch_name).toBe(task.branch_name);
});

it("stops a saved preparation process by start identity on core restart", async () => {
  const { repo } = await fixtureRepository(engine, dir);
  const task = await prepareFixtureTask(engine, repo, "process-interrupted");
  const child = spawn("git", ["cat-file", "--batch"], {
    cwd: repo.path,
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  try {
    engine.db.saveTask({
      ...task,
      stage: 0,
      status: "preparing",
      workspace_checkpoint: {
        ...task.workspace_checkpoint!,
        state: "creating",
        operation: {
          kind: "fetch",
          pid: child.pid!,
          identity: await processIdentity(child.pid!),
          started_at: new Date().toISOString(),
        },
      },
    });
    await reopen();
    await exited;
    expect(child.signalCode).toBe("SIGKILL");
    expect(engine.db.task(task.id).workspace_checkpoint?.operation).toBeNull();
    expect(engine.db.all("SELECT * FROM ai_usage")).toEqual([]);
  } finally {
    child.kill("SIGKILL");
  }
});

it("refuses cleanup after the worktree metadata owner changes", async () => {
  const { repo } = await fixtureRepository(engine, dir);
  const task = await prepareFixtureTask(engine, repo, "foreign-cleanup");
  const gitdir = await checked(
    "git",
    ["rev-parse", "--absolute-git-dir"],
    task.worktree_path,
  );
  await writeFile(join(gitdir, "vibestar-task-owner"), "another-task");
  await expect(cleanup(task.id)).rejects.toThrow("owner");
  expect(await readFile(join(task.worktree_path, "source.txt"), "utf8")).toBe(
    "base\n",
  );
  expect(engine.db.task(task.id).worktree_path).toBe(task.worktree_path);
});

it("never follows a symlinked ownership marker while recovering or cleaning a worktree", async () => {
  const { repo } = await fixtureRepository(engine, dir);
  const task = await prepareFixtureTask(engine, repo, "owner-alias");
  const gitdir = await checked(
    "git",
    ["rev-parse", "--absolute-git-dir"],
    task.worktree_path,
  );
  const marker = join(gitdir, "vibestar-task-owner");
  const canary = join(dir, "personal-owner-fixture");
  await writeFile(canary, "preserve fixture bytes");
  await rm(marker);
  await symlink(canary, marker);
  await expect(engine.git.recoverTaskPreparation(repo, task)).rejects.toThrow(
    "ownership marker",
  );
  await expect(cleanup(task.id)).rejects.toThrow("ownership marker");
  expect(await readFile(canary, "utf8")).toBe("preserve fixture bytes");
  expect(await exists(task.worktree_path)).toBe(true);
});

it("keeps hidden tracked edits even when a preceding filename resembles an authorization field", async () => {
  const { repo } = await fixtureRepository(engine, dir);
  const task = await prepareFixtureTask(engine, repo, "redacted-index");
  await writeFile(join(task.worktree_path, "authorization: foo"), "fixture\n");
  await checked("git", ["add", "--", "authorization: foo"], task.worktree_path);
  await checked(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "Credential-shaped fixture filename",
    ],
    task.worktree_path,
  );
  await checked(
    "git",
    ["update-index", "--assume-unchanged", "source.txt"],
    task.worktree_path,
  );
  await writeFile(join(task.worktree_path, "source.txt"), "hidden work\n");
  expect(
    await checked("git", ["status", "--porcelain"], task.worktree_path),
  ).toBe("");
  await expect(cleanup(task.id)).rejects.toThrow("hidden index entries");
  expect(await readFile(join(task.worktree_path, "source.txt"), "utf8")).toBe(
    "hidden work\n",
  );
});

it.each(["cleanup", "recovery"])(
  "preserves a missing worktree recreated immediately before %s",
  async (kind) => {
    const { repo } = await fixtureRepository(engine, dir);
    const task = await prepareFixtureTask(engine, repo, "recreated-race");
    const pointer = await readFile(join(task.worktree_path, ".git"));
    await rm(task.worktree_path, { recursive: true });
    const original = commands.gitExecute;
    let restored = false;
    vi.spyOn(commands, "gitExecute").mockImplementation(async (request) => {
      if (!restored && request.args.includes("remove")) {
        restored = true;
        await mkdir(task.worktree_path);
        await writeFile(join(task.worktree_path, ".git"), pointer);
        await writeFile(
          join(task.worktree_path, "personal.txt"),
          "preserve concurrent work\n",
        );
      }
      return original(request);
    });
    await expect(
      kind === "cleanup"
        ? cleanup(task.id)
        : engine.git.recoverTaskPreparation(repo, task, engine.db.saveTask),
    ).rejects.toThrow();
    expect(restored).toBe(true);
    expect(
      await readFile(join(task.worktree_path, "personal.txt"), "utf8"),
    ).toBe("preserve concurrent work\n");
    expect(
      await checked("git", ["rev-parse", task.branch_name], repo.path),
    ).toBe(task.base_commit_sha);
  },
);

it.each(["removing", "removed"] as const)(
  "preserves %s intent through startup and refuses preparation",
  async (state) => {
    const { repo } = await fixtureRepository(engine, dir);
    const task = await prepareFixtureTask(engine, repo, "removal-intent");
    engine.db.saveTask({
      ...task,
      stage: 0,
      status: "preparing",
      workspace_checkpoint: {
        ...task.workspace_checkpoint!,
        state,
        cleanup_head: task.base_commit_sha,
      },
    });
    await reopen();
    const saved = engine.db.task(task.id);
    expect(saved).toMatchObject({
      stage: 0,
      status: "interrupted",
      workspace_checkpoint: { state },
    });
    await expect(
      engine.git.recoverTaskPreparation(repo, saved, engine.db.saveTask),
    ).rejects.toThrow("removal was checkpointed");
    expect(await readFile(join(task.worktree_path, "source.txt"), "utf8")).toBe(
      "base\n",
    );
  },
);
