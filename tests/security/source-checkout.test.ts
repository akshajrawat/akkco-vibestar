import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseIssue } from "../../backend/domain";
import { sandboxInvocation } from "../../backend/execution/runtime/sandbox";
import { execute } from "../../backend/execution/runtime/process";
import { gitChecked } from "../../backend/workspace/git-command";
import { createFixtureEngine, fixtureRepository } from "../helpers/fixtures";

let directory: string;
let engine: Awaited<ReturnType<typeof createFixtureEngine>>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "vibestar-source-sandbox-"));
  engine = await createFixtureEngine(join(directory, "data"));
});

afterEach(async () => {
  await engine.close();
  await rm(directory, { recursive: true, force: true });
});

const prepare = async () => {
  const { repo } = await fixtureRepository(engine, directory);

  const task = engine.enqueue(
    repo,
    parseIssue("https://github.com/fixture/fixture/issues/1"),
    "Task A",
    "",
    {},
    "partial",
    undefined,
    undefined,
    "not_started",
  );

  await engine.git.prepare(repo, task, undefined, (value) => engine.db.saveTask(value), undefined, {
    reusableOwners: [],
  });

  return { repo, task };
};

it.each([true, false])(
  "enforces source permissions and protects Git metadata and installed dependencies (read-only %s)",
  async (readOnly) => {
    const { repo, task } = await prepare();
    await writeFile(join(repo.path, ".git", "info", "exclude"), "node_modules/\n");
    await mkdir(join(repo.path, "node_modules"));
    await writeFile(join(repo.path, "node_modules", "fixture.txt"), "installed dependency\n");
    const config = await readFile(join(repo.path, ".git", "config"), "utf8");

    const invocation = await sandboxInvocation(
      engine.root,
      engine.db,
      task,
      {
        program: process.execPath,
        args: [
          "-e",
          `(async()=>{const fs=require('node:fs/promises');for(const file of ['.git/config','node_modules/fixture.txt']){let denied=false;try{await fs.writeFile(file,'unauthorized',{flag:'r+'})}catch{denied=true}if(!denied)throw Error(file+' was writable');}let denied=false;try{await fs.writeFile('source.txt','Task-owned edit\\n')}catch{denied=true}if(denied!==${readOnly})throw Error('Wrong source permission');console.log('Source permissions verified');})().catch(e=>{console.error(e.message);process.exitCode=1});`,
        ],
      },
      readOnly,
    );

    const result = await execute({ ...invocation, cwd: repo.path });
    expect(result, result.stderr).toMatchObject({ code: 0 });
    expect(await readFile(join(repo.path, ".git", "config"), "utf8")).toBe(config);

    expect(await readFile(join(repo.path, "node_modules", "fixture.txt"), "utf8")).toBe(
      "installed dependency\n",
    );

    expect(await readFile(join(repo.path, "source.txt"), "utf8")).toBe(
      readOnly ? "base\n" : "Task-owned edit\n",
    );
  },
);

it("refuses forged source owners, alternate paths and manually switched branches", async () => {
  const { repo, task } = await prepare();

  await expect(engine.git.assertTask({ ...task, id: "foreign-owner" })).rejects.toThrow(
    "ownership",
  );

  await expect(engine.git.assertTask({ ...task, worktree_path: directory })).rejects.toThrow(
    "registered checkout",
  );

  await gitChecked(["checkout", "main"], repo.path);
  await expect(engine.git.assertTask(task)).rejects.toThrow("ownership changed");

  await expect(
    sandboxInvocation(engine.root, engine.db, task, { program: process.execPath, args: [] }, false),
  ).rejects.toThrow("ownership changed");
});
