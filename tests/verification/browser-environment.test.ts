import { expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { sandboxInvocation } from "../../backend/execution/runtime/sandbox";
import { execute } from "../../backend/execution/runtime/process";
import { Rpc } from "../../backend/rpc";
import { createFixtureEngine, fixtureRepository, prepareFixtureTask } from "../helpers/fixtures";
import { taskVerification } from "../../backend/execution/verification/task-verification";
import { Database } from "../../backend/storage/database";

const fixture = vi.hoisted(() => ({ home: "" }));

vi.mock("node:os", async (original) => {
  const module = await original<typeof import("node:os")>();
  return { ...module, homedir: () => fixture.home || module.homedir() };
});

it("limits installed-browser mounts to explicit manual verification, keeps them read-only and rejects aliases", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-browser-boundary-"));
  fixture.home = join(dir, "home");
  const cache = join(fixture.home, ".cache", "ms-playwright");
  await mkdir(cache, { recursive: true });
  await mkdir(join(fixture.home, ".codex"));
  await writeFile(join(cache, "fixture-browser"), "installed fixture");
  await writeFile(join(fixture.home, ".codex", "fixture-auth"), "private fixture");
  const engine = await createFixtureEngine(join(dir, "data"));
  const rpc = new Rpc(engine);
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const task = await prepareFixtureTask(engine, repo, randomUUID());

    const plain = await sandboxInvocation(
      engine.root,
      engine.db,
      task,
      { program: process.execPath, args: [] },
      true,
    );

    expect(plain.args).not.toContain(cache);
    const code = `const fs=require('node:fs/promises');(async()=>{if(await fs.readFile(${JSON.stringify(join(cache, "fixture-browser"))},'utf8')!=='installed fixture')throw Error('cache unavailable');try{await fs.writeFile(${JSON.stringify(join(cache, "mutated"))},'bad');throw Error('cache writable');}catch(error){if(error.code!=='EROFS')throw error;}try{await fs.readFile(${JSON.stringify(join(fixture.home, ".codex", "fixture-auth"))});throw Error('credentials exposed');}catch(error){if(error.code!=='ENOENT')throw error;}console.log('read-only browser tools');})().catch(error=>{console.error(error);process.exitCode=1;});`;

    const selected = await sandboxInvocation(
      engine.root,
      engine.db,
      task,
      {
        program: process.execPath,
        args: ["-e", code],
        verificationEnvironment: "installed_browsers",
      },
      true,
    );

    const result = await execute({ ...selected, cwd: task.worktree_path });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("read-only browser tools");

    await expect(
      sandboxInvocation(
        engine.root,
        engine.db,
        task,
        {
          program: process.execPath,
          args: [],
          verificationEnvironment: "installed_browsers",
        },
        true,
        undefined,
        "codex",
      ),
    ).rejects.toThrow("explicit manual verification");

    await expect(
      rpc.call("task.browser.configure", {
        id: task.id,
        environment: "installed_browsers",
      }),
    ).rejects.toThrow();

    await expect(
      rpc.call("task.browser.configure", {
        id: task.id,
        environment: "installed_browsers",
        confirmed: true,
        path: fixture.home,
      }),
    ).rejects.toThrow();

    await rpc.call("task.browser.configure", {
      id: task.id,
      environment: "installed_browsers",
      confirmed: true,
    });

    expect(engine.db.task(task.id).verification_environment).toBe("installed_browsers");
    const reopened = await Database.open(join(engine.root, "state", "vibestar.sqlite"));
    try {
      expect(reopened.task(task.id).verification_environment).toBe("installed_browsers");
    } finally {
      reopened.close();
    }

    await rm(cache, { recursive: true });
    await symlink(join(dir, "data"), cache);

    await expect(
      sandboxInvocation(
        engine.root,
        engine.db,
        task,
        {
          program: process.execPath,
          args: [],
          verificationEnvironment: "installed_browsers",
        },
        true,
      ),
    ).rejects.toThrow("not a symlink");
  } finally {
    await rpc.close();
    await engine.close();
    fixture.home = "";
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

it.skipIf(process.env.VIBESTAR_BROWSER_TEST !== "1")(
  "loads actual direct-file and HTTP fixtures using installed browser tooling without changing source or passing application checks",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-browser-live-"));
    const engine = await createFixtureEngine(join(dir, "data"));
    const rpc = new Rpc(engine);
    try {
      const { repo } = await fixtureRepository(engine, dir);
      await writeFile(join(repo.path, ".git", "info", "exclude"), "node_modules/\n");

      await cp(
        await realpath("node_modules/playwright-core"),
        join(repo.path, "node_modules", "playwright-core"),
        { recursive: true },
      );

      const task = await prepareFixtureTask(engine, repo, randomUUID());
      const source = await readFile(join(repo.path, "source.txt"));
      const index = await readFile(join(repo.path, ".git", "index"));
      const isolated = await rpc.call("task.browser.inspect", { id: task.id });
      expect(isolated).toMatchObject({ environment: "isolated" });

      await rpc.call("task.browser.configure", {
        id: task.id,
        environment: "installed_browsers",
        confirmed: true,
      });

      const report = await rpc.call("task.browser.inspect", { id: task.id });

      expect(report).toMatchObject({
        environment: "installed_browsers",
        direct_file: { outcome: "available" },
        http: { outcome: "available" },
        socket: { outcome: "available" },
      });

      expect(await readFile(join(repo.path, "source.txt"))).toEqual(source);
      expect(await readFile(join(repo.path, ".git", "index"))).toEqual(index);
      expect(taskVerification(engine.db, task.id).canReview).toBe(false);
      expect(engine.db.all("SELECT * FROM agent_runs")).toEqual([]);
      expect(engine.db.task(task.id).browser_environment_report).toEqual(report);
      await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2));
      console.log("Installed browser probe evidence:", dir);
    } finally {
      await rpc.close();
      await engine.close();
      if (process.env.VIBESTAR_KEEP_EVIDENCE !== "1")
        await rm(dir, { recursive: true, force: true });
    }
  },
  60000,
);
