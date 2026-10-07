import { it, expect, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../backend/execution/engine";
import { Rpc } from "../backend/rpc";
import { parseIssue } from "../backend/domain";
import * as processes from "../backend/execution/process";
import { fixtureRepository, FixtureProvider, waitForTask } from "./fixtures";
import BetterSqlite3 from "better-sqlite3";
import { migrations } from "../backend/storage/migrations";
import { Database } from "../backend/storage/database";

vi.mock("../backend/workspace/issue", () => ({
  fetchIssue: vi.fn(async () => ({ title: "Fixture issue", body: "Task A" })),
}));

it("migrates the repository uniqueness constraint without losing historical tasks or foreign-key enforcement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-registry-migration-"));
  const path = join(dir, "legacy.sqlite");
  const legacy = new BetterSqlite3(path);
  for (const migration of migrations.filter((m) => m.version < 12)) {
    legacy.exec(migration.sql);
    legacy
      .prepare("INSERT OR IGNORE INTO schema_migrations VALUES(?,?)")
      .run(migration.version, "legacy");
  }
  const repository = {
    id: "old",
    owner: "oppia",
    name: "oppia",
    path: "/old/checkout",
  };
  legacy
    .prepare("INSERT INTO repositories VALUES(?,?,?,?)")
    .run("old", "oppia", "oppia", JSON.stringify(repository));
  legacy
    .prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?)")
    .run(
      "history",
      "old",
      "completed",
      5,
      JSON.stringify({ id: "history", repo_id: "old", status: "completed" }),
      "legacy",
      "partial",
    );
  legacy.close();
  const db = new Database(path);
  try {
    expect(db.repository("old")).toMatchObject({
      connected: true,
      path: "/old/checkout",
    });
    expect(db.task("history").repo_id).toBe("old");
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    db.run(
      "INSERT INTO repositories VALUES(?,?,?,?)",
      "new",
      "oppia",
      "oppia",
      JSON.stringify({ ...repository, id: "new", path: "/new/checkout" }),
    );
    expect(db.repositories()).toHaveLength(2);
    expect(() =>
      db.run(
        "INSERT INTO repositories VALUES(?,?,?,?)",
        "duplicate",
        "Oppia",
        "Oppia",
        JSON.stringify(repository),
      ),
    ).toThrow();
    expect(() =>
      db.run("INSERT INTO issues VALUES(?,?,?)", "missing", 1, "{}"),
    ).toThrow();
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

const checkout = async (dir: string, name = "oppia") => {
  const path = join(dir, name);
  await mkdir(path);
  await processes.checked("git", ["init", "-b", "develop"], path);
  await processes.checked("git", ["config", "user.name", "Test"], path);
  await processes.checked(
    "git",
    ["config", "user.email", "test@example.invalid"],
    path,
  );
  await writeFile(join(path, "source.txt"), "base\n");
  await processes.checked("git", ["add", "."], path);
  await processes.checked("git", ["commit", "-m", "base"], path);
  await processes.checked(
    "git",
    ["remote", "add", "origin", "https://github.com/akshajrawat/oppia.git"],
    path,
  );
  await processes.checked(
    "git",
    ["remote", "add", "upstream", "https://github.com/oppia/oppia.git"],
    path,
  );
  await processes.checked(
    "git",
    ["remote", "add", "reviewer", "git@github.com:reviewer/oppia.git"],
    path,
  );
  for (const remote of ["origin", "upstream"]) {
    await processes.checked(
      "git",
      ["update-ref", `refs/remotes/${remote}/develop`, "HEAD"],
      path,
    );
    await processes.checked(
      "git",
      [
        "symbolic-ref",
        `refs/remotes/${remote}/HEAD`,
        `refs/remotes/${remote}/develop`,
      ],
      path,
    );
  }
  await processes.checked("git", ["switch", "-c", "my-personal-branch"], path);
  return path;
};
const connect = async (rpc: Rpc, path: string) => {
  const verified = (await rpc.call("repository.verifyLocal", {
    environment: "wsl",
    path,
  })) as Awaited<ReturnType<Engine["verifyLocalRepository"]>>;
  const repository = (await rpc.call("repository.connectLocal", {
    verification_id: verified.verification_id,
    upstream_remote: "upstream",
    origin_remote: "origin",
    base_branch: "develop",
  })) as ReturnType<Engine["db"]["repository"]>;
  return { verified, repository };
};

it("verifies all remotes without scanning, explicitly connects and persists independent checkout IDs across restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-connected-"));
  let engine = await Engine.create(join(dir, "data"));
  let rpc = new Rpc(engine);
  try {
    const path = await checkout(dir);
    await writeFile(join(path, "source.txt"), "my dirty file\n");
    const scan = vi.spyOn(engine.repositoryIndex, "scan");
    const clone = vi.spyOn(engine.git, "clone");
    const { verified, repository } = await connect(rpc, path);
    expect(verified).toMatchObject({
      path,
      dirty: true,
      branch: "my-personal-branch",
      base_branch: "develop",
      upstream_remote: "upstream",
      origin_remote: "origin",
    });
    expect(verified.remotes.map((r) => r.identity)).toEqual(
      expect.arrayContaining([
        "oppia/oppia",
        "akshajrawat/oppia",
        "reviewer/oppia",
      ]),
    );
    expect(repository).toMatchObject({
      owner: "oppia",
      name: "oppia",
      path,
      source: "imported",
      connected: true,
      base_branch: "develop",
    });
    expect(scan).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
    const other = await connect(rpc, await checkout(dir, "other-oppia"));
    expect(other.repository.id).not.toBe(repository.id);
    expect(engine.db.repositories()).toHaveLength(2);
    await rpc.close();
    await engine.close();
    engine = await Engine.create(join(dir, "data"));
    rpc = new Rpc(engine);
    expect(engine.db.repository(repository.id)).toMatchObject({
      connected: true,
      path,
    });
    await rpc.call("repository.disconnect", {
      id: repository.id,
      confirmed: true,
    });
    expect(engine.db.repository(repository.id).connected).toBe(false);
    expect((await stat(path)).isDirectory()).toBe(true);
    expect(await readFile(join(path, "source.txt"), "utf8")).toBe(
      "my dirty file\n",
    );
    expect((await connect(rpc, path)).repository.id).toBe(repository.id);
  } finally {
    await rpc.close();
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("requires the selected ID, blocks mismatches, never creates a clone, and runs two isolated tasks in the imported Git repository", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-selected-"));
  const workspaces: { stage: number; cwd: string }[] = [];
  const engine = await Engine.create(join(dir, "data"), () => {
    const provider = new FixtureProvider();
    const invocation = provider.invocation;
    provider.invocation = (request) => {
      workspaces.push({ stage: request.stage, cwd: request.cwd });
      return invocation(request);
    };
    return provider;
  });
  const rpc = new Rpc(engine);
  try {
    const path = await checkout(dir);
    const { repository } = await connect(rpc, path);
    const second = await connect(rpc, await checkout(dir, "second"));
    await writeFile(join(path, "source.txt"), "source stays dirty\n");
    const originalConfig = await readFile(join(path, ".git", "config"), "utf8");
    const clone = vi.spyOn(engine.git, "clone");
    const use = vi.spyOn(rpc.github, "useLocally");
    const issue_url = "https://github.com/oppia/oppia/issues/26831";
    await expect(
      rpc.call("task.create", { issue_url, scope_mode: "whole_issue" }),
    ).rejects.toThrow();
    await expect(
      rpc.call("task.create", {
        repository_id: repository.id,
        issue_url: "https://github.com/facebook/react/issues/1",
        scope_mode: "whole_issue",
      }),
    ).rejects.toThrow("Repository mismatch");
    expect(engine.db.tasks()).toHaveLength(0);
    expect(engine.taskRepository(repository.id, parseIssue(issue_url)).id).toBe(
      repository.id,
    );
    const preview = await rpc.call("task.preview", {
      repository_id: second.repository.id,
      issue_url,
    });
    expect(preview).toMatchObject({ repository: { id: second.repository.id } });
    // Redirect only the fixture's fetch transport; stored GitHub remotes and connection identity stay real.
    const capture = processes.capture;
    vi.spyOn(processes, "capture").mockImplementation(
      (program, args, cwd, signal) =>
        capture(
          program,
          args[0] === "-c" && args.includes("fetch")
            ? args.map((a) => (a === repository.upstream_url ? path : a))
            : args,
          cwd,
          signal,
        ),
    );
    const a = (await rpc.call("task.create", {
      repository_id: repository.id,
      issue_url,
      scope_mode: "partial",
      claimed_scope: "Task A",
    })) as ReturnType<Engine["db"]["task"]>;
    const b = (await rpc.call("task.create", {
      repository_id: repository.id,
      issue_url,
      scope_mode: "partial",
      claimed_scope: "Task B",
    })) as ReturnType<Engine["db"]["task"]>;
    await Promise.all(
      [a, b].map((task) =>
        waitForTask(engine, task.id, (status) =>
          ["ready_for_review", "failed"].includes(status),
        ),
      ),
    );
    for (const task of [a, b]) {
      const current = engine.db.task(task.id);
      expect(current.status, current.error || "").toBe("ready_for_review");
      expect(current.repo_id).toBe(repository.id);
      expect(current.worktree_path).toContain(`/worktrees/${repository.id}/`);
      expect(current.worktree_path).not.toBe(path);
      expect(
        await processes.checked(
          "git",
          ["rev-parse", "--git-common-dir"],
          current.worktree_path,
        ),
      ).toBe(join(path, ".git"));
      expect(
        await processes.checked(
          "git",
          ["branch", "--list", current.branch_name],
          path,
        ),
      ).toContain(current.branch_name);
      const runs = engine.db.detail(task.id).runs;
      expect(runs.map((r) => r.stage)).toEqual([1, 2, 3]);
      expect(
        workspaces
          .filter((r) => r.cwd === current.worktree_path)
          .map((r) => r.stage),
      ).toEqual([1, 2, 3]);
      expect(current.branch_name).toMatch(/^akkco\//);
    }
    expect(engine.db.task(a.id).worktree_path).not.toBe(
      engine.db.task(b.id).worktree_path,
    );
    expect(await readFile(join(path, "source.txt"), "utf8")).toBe(
      "source stays dirty\n",
    );
    expect(await readFile(join(path, ".git", "config"), "utf8")).toBe(
      originalConfig,
    );
    expect(
      await processes.checked("git", ["branch", "--show-current"], path),
    ).toBe("my-personal-branch");
    expect(clone).not.toHaveBeenCalled();
    expect(use).not.toHaveBeenCalled();
    const terminal = engine.acquireTerminal(a.id);
    await expect(engine.disconnectRepository(repository.id)).rejects.toThrow(
      "active tasks and terminals",
    );
    terminal();
    await engine.disconnectRepository(repository.id);
    expect(engine.db.tasks()).toHaveLength(2);
    expect((await stat(engine.db.task(a.id).worktree_path)).isDirectory()).toBe(
      true,
    );
    await expect(
      rpc.call("task.create", {
        repository_id: repository.id,
        issue_url,
        scope_mode: "whole_issue",
      }),
    ).rejects.toThrow("Reconnect");
  } finally {
    vi.restoreAllMocks();
    await rpc.close();
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 40000);

it("rejects invalid/non-Git paths, unsafe Windows paths and stale verification; uses wslpath rather than guessing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-verify-path-"));
  const engine = await Engine.create(join(dir, "data"));
  const rpc = new Rpc(engine);
  try {
    const path = await checkout(dir);
    for (const invalid of [
      "/",
      "/mnt/c",
      "relative/path",
      "~/missing-checkout",
    ])
      await expect(
        rpc.call("repository.verifyLocal", {
          environment: "wsl",
          path: invalid,
        }),
      ).rejects.toThrow();
    await expect(
      rpc.call("repository.verifyLocal", { environment: "wsl", path: dir }),
    ).rejects.toThrow();
    for (const invalid of [
      "C:\\",
      "D:relative",
      "/mnt/c/projects/repo",
      "D:\\repo\n",
    ])
      await expect(
        rpc.call("repository.verifyLocal", {
          environment: "windows",
          path: invalid,
        }),
      ).rejects.toThrow();
    const checked = processes.checked;
    const conversion = vi
      .spyOn(processes, "checked")
      .mockImplementation((program, args, cwd, signal) =>
        program === "wslpath"
          ? Promise.resolve(path)
          : checked(program, args, cwd, signal),
      );
    const verified = await engine.verifyLocalRepository({
      environment: "windows",
      path: "D:\\Projects\\oppia",
    });
    expect(conversion).toHaveBeenCalledWith(
      "wslpath",
      ["-u", "D:\\Projects\\oppia"],
      engine.root,
    );
    expect(verified).toMatchObject({
      path,
      windows_path: "D:\\Projects\\oppia",
      environment: "windows",
    });
    await processes.checked(
      "git",
      ["remote", "set-url", "upstream", "https://github.com/other/oppia.git"],
      path,
    );
    await expect(
      engine.connectLocalRepository({
        verification_id: verified.verification_id,
        upstream_remote: "upstream",
        origin_remote: "origin",
        base_branch: "develop",
      }),
    ).rejects.toThrow("changed");
    expect(engine.db.repositories()).toHaveLength(0);
  } finally {
    vi.restoreAllMocks();
    await rpc.close();
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("requires an explicit upstream for ambiguous remotes and an explicit base when remote HEAD is unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-ambiguous-local-"));
  const engine = await Engine.create(join(dir, "data"));
  const rpc = new Rpc(engine);
  try {
    const path = await checkout(dir);
    await processes.checked(
      "git",
      ["remote", "rename", "upstream", "project"],
      path,
    );
    await processes.checked(
      "git",
      ["symbolic-ref", "--delete", "refs/remotes/project/HEAD"],
      path,
    );
    const verified = await engine.verifyLocalRepository({
      environment: "wsl",
      path,
    });
    expect(verified.upstream_remote).toBeNull();
    expect(verified.base_branch).toBeNull();
    expect(engine.db.repositories()).toHaveLength(0);
    await expect(
      engine.connectLocalRepository({
        verification_id: verified.verification_id,
        upstream_remote: "missing",
        origin_remote: "origin",
        base_branch: "develop",
      }),
    ).rejects.toThrow("verified GitHub remotes");
    await expect(
      engine.connectLocalRepository({
        verification_id: verified.verification_id,
        upstream_remote: "project",
        origin_remote: "origin",
        base_branch: "nonexistent",
      }),
    ).rejects.toThrow("base branch found");
    const repo = await engine.connectLocalRepository({
      verification_id: verified.verification_id,
      upstream_remote: "project",
      origin_remote: "origin",
      base_branch: "develop",
    });
    expect(repo).toMatchObject({
      owner: "oppia",
      name: "oppia",
      upstream_remote: "project",
    });
    await expect(
      engine.connectLocalRepository({
        verification_id: verified.verification_id,
        upstream_remote: "project",
        origin_remote: "origin",
        base_branch: "develop",
      }),
    ).rejects.toThrow("expired");
  } finally {
    await rpc.close();
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("keeps an explicitly selected legacy managed repository authoritative when its clone is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-legacy-selected-"));
  const engine = await Engine.create(
    join(dir, "data"),
    () => new FixtureProvider(),
  );
  const rpc = new Rpc(engine);
  try {
    const { repo } = await fixtureRepository(engine, dir);
    await rm(repo.path, { recursive: true, force: true });
    const scan = vi.spyOn(engine.repositoryIndex, "scan");
    const matches = vi.spyOn(engine.repositoryIndex, "matches");
    const clone = vi
      .spyOn(engine.git, "clone")
      .mockRejectedValue(new Error("Selected clone could not be restored"));
    const task = (await rpc.call("task.create", {
      repository_id: repo.id,
      issue_url: "https://github.com/fixture/fixture/issues/1",
      scope_mode: "whole_issue",
    })) as ReturnType<Engine["db"]["task"]>;
    await waitForTask(engine, task.id, (status) => status === "failed");
    expect(engine.db.repository(repo.id)).toMatchObject({
      path: repo.path,
      selection: "explicit",
    });
    expect(engine.db.task(task.id).repo_id).toBe(repo.id);
    expect(scan).not.toHaveBeenCalled();
    expect(matches).not.toHaveBeenCalled();
    expect(clone).toHaveBeenCalledWith(
      repo.upstream_url,
      repo.path,
      expect.any(AbortSignal),
    );
  } finally {
    vi.restoreAllMocks();
    await rpc.close();
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});
