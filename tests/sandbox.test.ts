import { it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Engine } from "../backend/execution/engine";
import { parseIssue } from "../backend/domain";
import { sandboxInvocation } from "../backend/execution/sandbox";
import { execute } from "../backend/execution/process";
import { fixtureRepository, FixtureProvider, waitForTask } from "./fixtures";
it("mounts planning worktrees read-only and hides unrelated directories and ADE state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-sandbox-"));
  const engine = await Engine.create(
    join(dir, "ade"),
    () => new FixtureProvider(),
  );
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const task = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/10"),
      "Task A",
      "",
      {},
    );
    await waitForTask(
      engine,
      task.id,
      (s) => s === "ready_for_review" || s === "failed",
    );
    const t = engine.db.task(task.id);
    await writeFile(join(dir, "outside-canary"), "private");
    const invocation = await sandboxInvocation(
      engine.root,
      engine.db,
      t,
      {
        program: process.execPath,
        args: [
          "-e",
          `const fs=require('node:fs/promises');(async()=>{try{await fs.writeFile('source.txt','bad');throw new Error('write allowed')}catch(e){if(e.code!=='EROFS')throw e;}for(const p of ${JSON.stringify([join(dir, "outside-canary"), join(engine.root, "state", "vibestar.sqlite")])}){try{await fs.readFile(p);throw new Error('outside read allowed')}catch(e){if(e.code!=='ENOENT')throw e;}}await fs.readFile('/etc/resolv.conf');console.log('isolated');})().catch(e=>{console.error(e);process.exit(1)});`,
        ],
      },
      true,
    );
    const output = await execute({ ...invocation, cwd: t.worktree_path });
    expect(output.code, output.stderr).toBe(0);
    expect(output.stdout).toContain("isolated");
    expect(await readFile(join(t.worktree_path, "source.txt"), "utf8")).toBe(
      "A\n",
    );
  } finally {
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);
