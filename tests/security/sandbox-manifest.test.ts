import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { sandboxInvocation } from "../../backend/execution/runtime/sandbox";
import { execute } from "../../backend/execution/runtime/process";
import { createFixtureEngine, fixtureRepository, prepareFixtureTask } from "../helpers/fixtures";

const fixture = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (original) => {
  const module = await original<typeof import("node:os")>();
  return { ...module, homedir: () => fixture.home || module.homedir() };
});

it("mounts only the selected provider state and toolchain from a home outside /home, hiding host files and Unix sockets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-manifest-"));
  const external = await mkdtemp("/var/tmp/vibestar-manifest-");
  fixture.home = join(external, "home");
  const state = join(fixture.home, ".codex");
  const other = join(fixture.home, ".gemini");
  await mkdir(state, { recursive: true });
  await mkdir(other);
  await writeFile(join(state, "session-fixture"), "provider-owned fixture state");
  await writeFile(join(other, "other-fixture"), "unselected state");
  await writeFile(join(fixture.home, "personal-fixture"), "private fixture");
  const packageRoot = join(fixture.home, ".local", "share", "node_modules", "fixture-cli");
  const localBin = join(fixture.home, ".local", "bin");
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await mkdir(localBin, { recursive: true });
  await writeFile(join(packageRoot, "helper.cjs"), "module.exports='TOOLCHAIN_OK';");
  const socket = join(external, "host.socket");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const engine = await createFixtureEngine(join(dir, "data"));
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const task = await prepareFixtureTask(engine, repo, "sandbox-manifest");
    const hidden = [
      join(fixture.home, "personal-fixture"),
      join(other, "other-fixture"),
      "/etc/hostname",
      "/etc/machine-id",
      socket,
      join(engine.root, "state", "vibestar.sqlite"),
    ];
    const code = `#!/usr/bin/env node
const fs=require('node:fs/promises');const net=require('node:net');
(async()=>{
 for(const path of ${JSON.stringify(hidden)}){try{await fs.lstat(path);throw new Error('host path visible: '+path);}catch(error){if(error.code!=='ENOENT')throw error;}}
 await new Promise((resolve,reject)=>{const socket=net.connect(${JSON.stringify(socket)});socket.on('connect',()=>reject(new Error('host socket reachable')));socket.on('error',error=>error.code==='ENOENT'?resolve():reject(error));});
 for(const key of ['SSH_AUTH_SOCK','DBUS_SESSION_BUS_ADDRESS','XDG_RUNTIME_DIR','DISPLAY','WAYLAND_DISPLAY']) if(process.env[key])throw new Error('socket environment visible: '+key);
 if(await fs.readFile(${JSON.stringify(join(state, "session-fixture"))},'utf8')!=='provider-owned fixture state')throw new Error('state absent');
 await fs.writeFile(${JSON.stringify(join(state, "new-session-fixture"))},'provider update');
 await fs.readFile('/etc/resolv.conf');
 try{await fs.writeFile('source.txt','bad');throw new Error('planning write allowed');}catch(error){if(error.code!=='EROFS')throw error;}
 console.log(require('../helper.cjs'));
})().catch(error=>{console.error(error);process.exitCode=1;});
`;
    const entry = join(packageRoot, "bin", "fixture.cjs");
    await writeFile(entry, code, { mode: 0o700 });
    await symlink(entry, join(localBin, "vibestar-fixture-cli"));
    const invocation = await sandboxInvocation(
      engine.root,
      engine.db,
      task,
      { program: "vibestar-fixture-cli", args: [] },
      true,
      undefined,
      "codex",
    );
    expect(invocation.args.join(" ")).not.toContain("--ro-bind / /");
    const result = await execute({ ...invocation, cwd: task.worktree_path });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("TOOLCHAIN_OK");
    expect(await readFile(join(state, "new-session-fixture"), "utf8")).toBe("provider update");
    expect(await readFile(join(task.worktree_path, "source.txt"), "utf8")).toBe("base\n");
    const relative = join(task.worktree_path, "fixture-check.sh");
    await writeFile(relative, "#!/bin/sh\nprintf 'RELATIVE_TOOL_OK\\n'\n", {
      mode: 0o700,
    });
    await mkdir(join(task.worktree_path, "node_modules", ".bin"), {
      recursive: true,
    });
    await symlink(
      "../../fixture-check.sh",
      join(task.worktree_path, "node_modules", ".bin", "fixture-check"),
    );
    for (const program of ["./fixture-check.sh", "./node_modules/.bin/fixture-check"]) {
      const command = await sandboxInvocation(
        engine.root,
        engine.db,
        task,
        { program, args: [] },
        true,
      );
      const output = await execute({ ...command, cwd: task.worktree_path });
      expect(output.code, output.stderr).toBe(0);
      expect(output.stdout).toContain("RELATIVE_TOOL_OK");
    }
  } finally {
    await engine.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fixture.home = "";
    await Promise.all([
      rm(dir, { recursive: true, force: true }),
      rm(external, { recursive: true, force: true }),
    ]);
  }
}, 15000);
