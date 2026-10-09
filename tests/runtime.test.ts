import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Engine } from "../backend/execution/engine";
import { parseIssue } from "../backend/domain";
import { fixtureRepository, FixtureProvider, waitForTask } from "./fixtures";
import { checked, execute } from "../backend/execution/process";
import { sandboxInvocation } from "../backend/execution/sandbox";
import { taskRuntime } from "../backend/workspace/runtime";
import { CoreBridge } from "../electron/bridge";

it("uses an installed source virtualenv and ignored dependencies read-only without exposing source files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-runtime-"));
  const engine = await Engine.create(
    join(dir, "data"),
    () => new FixtureProvider(),
  );
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const toolchainName = `${basename(repo.path)}_tools`;
    await mkdir(join(dirname(repo.path), toolchainName));
    await writeFile(
      join(dirname(repo.path), toolchainName, "runtime-probe.txt"),
      "project toolchain",
    );
    await writeFile(
      join(repo.path, ".git", "info", "exclude"),
      "node_modules/\nthird_party/\n.venv/\n",
    );
    await mkdir(join(repo.path, "node_modules"));
    await writeFile(
      join(repo.path, "node_modules", "runtime-probe.txt"),
      "source dependency",
    );
    await checked(
      "python3",
      ["-m", "venv", "--without-pip", join(repo.path, ".venv")],
      repo.path,
    );
    const site = await checked(
      join(repo.path, ".venv", "bin", "python3"),
      ["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
      repo.path,
    );
    await writeFile(
      join(site, "vibestar_runtime_probe.py"),
      "VALUE = 'installed in source virtualenv'\n",
    );
    const task = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/1"),
      "Task A",
      "",
      {},
    );
    await waitForTask(engine, task.id, (s) =>
      ["awaiting_approval", "failed"].includes(s),
    );
    const saved = engine.db.task(task.id);
    expect(saved.status, saved.error || "").toBe("awaiting_approval");
    expect(saved.runtime?.dependencies).toEqual([
      "node_modules",
      ".venv",
      `../${toolchainName}`,
    ]);
    expect(saved.runtime?.python).toBe(
      join(repo.path, ".venv", "bin", "python3"),
    );
    const invocation = await sandboxInvocation(
      engine.root,
      engine.db,
      saved,
      {
        program: "python3",
        args: [
          "-c",
          `import vibestar_runtime_probe, pathlib; print(vibestar_runtime_probe.VALUE); print(pathlib.Path('node_modules/runtime-probe.txt').read_text()); print(pathlib.Path(${JSON.stringify(`../${toolchainName}/runtime-probe.txt`)}).read_text()); p=pathlib.Path(${JSON.stringify(join(repo.path, "source.txt"))}); assert not p.exists(); pathlib.Path('node_modules/runtime-probe.txt').write_text('forbidden')`,
        ],
      },
      false,
    );
    const output = await execute({ ...invocation, cwd: saved.worktree_path });
    expect(output.stdout).toContain("installed in source virtualenv");
    expect(output.stdout).toContain("source dependency");
    expect(output.stdout).toContain("project toolchain");
    expect(output.stderr).toContain("Read-only file system");
    expect(
      await readFile(
        join(repo.path, "node_modules", "runtime-probe.txt"),
        "utf8",
      ),
    ).toBe("source dependency");
    expect((await engine.git.diff(saved)).files).toEqual([]);
    await writeFile(
      join(saved.worktree_path, ".python-version"),
      "../../.codex\n",
    );
    const invalid = await taskRuntime(repo.path, saved.worktree_path);
    expect(invalid.mounts.some((m) => m.source.includes(".codex"))).toBe(false);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

it("blocks task execution on a core without approval support while preserving reads and cancellation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-old-core-"));
  await writeFile(
    join(dir, "core.cjs"),
    `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const r=JSON.parse(line);console.log(JSON.stringify({id:r.id,result:r.method==='core.info'?{build:'old',protocol:2}:{tasks:[]}}));});rl.on('close',()=>process.exit(0));`,
  );
  const bridge = new CoreBridge(dir, {
    distro: "",
    data_home: "",
    helper_path: "",
  });
  bridge.start();
  try {
    expect(await bridge.request("snapshot")).toMatchObject({
      warning: expect.stringContaining("cannot enforce plan review approvals"),
    });
    await expect(bridge.request("task.create", {})).rejects.toThrow(
      "cannot enforce plan review approvals",
    );
    await expect(bridge.request("task.retry", {})).rejects.toThrow(
      "cannot enforce plan review approvals",
    );
    await expect(bridge.request("task.cancel", {})).resolves.toEqual({
      tasks: [],
    });
  } finally {
    await bridge.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
