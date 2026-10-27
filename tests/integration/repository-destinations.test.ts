import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { checked } from "../../backend/execution/runtime/process";
import type { GitHubRepository } from "../../backend/github/contracts";
import { Rpc } from "../../backend/rpc";
import { createFixtureEngine, fixtureRepository, prepareFixtureTask } from "../helpers/fixtures";

const metadata = (full_name: string, fork = false): GitHubRepository => ({
  id: fork ? 2 : 1,
  full_name,
  owner: { login: full_name.split("/")[0], type: "User" },
  name: "fixture",
  description: null,
  default_branch: "main",
  private: false,
  fork,
  permissions: { push: true },
  clone_url: `https://github.com/${full_name}.git`,
  updated_at: "2026-10-26T00:00:00Z",
  ...(fork
    ? {
        parent: {
          id: 1,
          full_name: "fixture/fixture",
          clone_url: "https://github.com/fixture/fixture.git",
          default_branch: "main",
        },
      }
    : {}),
});

const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-destination-"));
  const engine = await createFixtureEngine(join(dir, "data"));
  const { repo } = await fixtureRepository(engine, dir);
  const task = await prepareFixtureTask(engine, repo, randomUUID());
  repo.upstream_url = "https://github.com/fixture/fixture.git";
  await checked("git", ["remote", "set-url", "upstream", repo.upstream_url], repo.path);
  engine.db.saveRepository(repo);
  const rpc = new Rpc(engine);
  const source = metadata("fixture/fixture");
  const fork = metadata("contributor/fixture", true);

  const lookup = vi
    .spyOn(rpc.github.client, "repository")
    .mockImplementation(async (name) => (name === source.full_name ? source : fork));

  const configure = (repository: string, extras = {}) =>
    rpc.call("repository.configureDestination", {
      id: repo.id,
      repository,
      confirmed: true,
      ...extras,
    });

  const close = async () => {
    await rpc.close();
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  };

  return { engine, repo, task, rpc, source, fork, lookup, configure, close };
};

it("connects only freshly verified writable source and fork destinations without publishing", async () => {
  const f = await fixture();
  try {
    await expect(f.configure("fixture/fixture", { confirmed: false })).rejects.toThrow();
    await expect(f.configure("fixture/fixture", { command: "hostile" })).rejects.toThrow();
    await expect(f.configure("https://example.com/fixture/fixture")).rejects.toThrow();
    expect(f.lookup).not.toHaveBeenCalled();
    expect(f.engine.db.repository(f.repo.id).origin_url).toBeNull();

    for (const destination of ["fixture/fixture", "contributor/fixture"]) {
      const result = await f.configure(destination);
      const url = `https://github.com/${destination}.git`;
      expect(result).toMatchObject({ origin_url: url, origin_remote: "origin" });
      expect(await checked("git", ["remote", "get-url", "origin"], f.repo.path)).toBe(url);
      expect(f.engine.db.repository(f.repo.id).origin_url).toBe(url);
    }

    expect(f.lookup.mock.calls.map(([name]) => name)).toEqual([
      "fixture/fixture",
      "fixture/fixture",
      "contributor/fixture",
    ]);

    expect(f.engine.db.task(f.task.id).status).toBe("cancelled");
    expect(f.engine.db.all("SELECT * FROM agent_runs")).toEqual([]);
  } finally {
    await f.close();
  }
}, 30000);

it("rejects missing permissions, unrelated identities and imported checkout mutations", async () => {
  const f = await fixture();
  try {
    f.fork.permissions = { push: false };
    await expect(f.configure("contributor/fixture")).rejects.toThrow("cannot push");
    f.fork.permissions = { push: true };
    f.fork.parent!.id = 99;
    await expect(f.configure("contributor/fixture")).rejects.toThrow("verified contribution fork");
    f.fork.parent!.id = 1;
    f.fork.full_name = "unrelated/fixture";
    await expect(f.configure("contributor/fixture")).rejects.toThrow("identity does not match");
    f.engine.db.saveRepository({ ...f.repo, source: "imported" });
    await expect(f.configure("fixture/fixture")).rejects.toThrow("does not rewrite user-owned");
    expect(f.engine.db.repository(f.repo.id).origin_url).toBeNull();
    expect(await checked("git", ["remote"], f.repo.path)).toBe("upstream");
  } finally {
    await f.close();
  }
}, 30000);

it("preserves terminal and task maintenance exclusion while configuring repository remotes", async () => {
  const f = await fixture();
  let release = () => {};

  try {
    release = f.engine.acquireTaskWorkspace(f.task.id, "Fixture terminal");
    await expect(f.configure("fixture/fixture")).rejects.toThrow("active tasks");
    expect(f.engine.db.repository(f.repo.id).origin_url).toBeNull();
    release();
    release = () => {};

    await f.configure("fixture/fixture");
    release = f.engine.acquireTaskWorkspace(f.task.id, "Lease released after configuration");
  } finally {
    release();
    await f.close();
  }
}, 30000);
