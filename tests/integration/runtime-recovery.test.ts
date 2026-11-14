import { expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CoreBridge } from "../../electron/bridge";

/** Exercise the actual probe/installer with inert local WSL and npm executables. */
const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-runtime-recovery-"));
  const core = join(dir, "bundle");
  const data = join(dir, "data");
  const bin = join(dir, "bin");
  await Promise.all([mkdir(core), mkdir(data), mkdir(bin)]);

  await writeFile(
    join(core, "core.cjs"),
    `
    const {createInterface}=require('node:readline');
    const {createHash}=require('node:crypto');
    const fs=require('node:fs');
    const build=createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
    const lines=createInterface({input:process.stdin});
    lines.on('line',line=>{
      const request=JSON.parse(line);
      console.log(JSON.stringify({id:request.id,result:request.method==='core.info'?{build,agent_flows:1,manual_pr_analysis:true,runtime_restart:1,notification_preferences:1}:request.method==='core.prepareRestart'?{ready:true}:{accepted:request.method}}));
    });
    lines.on('close',()=>process.exit(0));
  `,
  );

  await Promise.all([
    writeFile(join(core, "package.json"), '{"name":"fixture","version":"1.0.0"}'),
    writeFile(join(core, "package-lock.json"), "{}"),
    writeFile(join(core, "LICENSE"), "fixture"),
  ]);

  await writeFile(
    join(bin, "wsl.exe"),
    `#!/usr/bin/env node
    const {spawn}=require('node:child_process');
    const args=process.argv.slice(2);
    const command=args.slice(args.indexOf('--exec')+1);
    const child=spawn(command[0],command.slice(1),{stdio:'inherit'});
    child.on('exit',code=>process.exit(code||0));
  `,
    { mode: 0o755 },
  );

  await writeFile(
    join(bin, "npm"),
    `#!/usr/bin/env node
    const fs=require('node:fs');
    const path=require('node:path');
    fs.appendFileSync(${JSON.stringify(join(dir, "installs"))}, 'install\\n');
    if(fs.existsSync(${JSON.stringify(join(dir, "fail"))})) { console.error('fixture dependency failure'); process.exit(1); }
    for(const name of ['better-sqlite3','node-pty']){
      const dir=path.join(process.cwd(),'node_modules',name);
      fs.mkdirSync(dir,{recursive:true});
      fs.writeFileSync(path.join(dir,'index.js'),name==='better-sqlite3'?'module.exports=class { close(){} }':'module.exports={}');
    }
  `,
    { mode: 0o755 },
  );

  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  Object.defineProperty(process, "platform", { value: "win32" });

  const bridge = new CoreBridge(core, {
    distro: "Fixture Ubuntu",
    data_home: data,
    helper_path: "",
  });

  return {
    bridge,
    core,
    data,
    dir,
    count: async () =>
      (await readFile(join(dir, "installs"), "utf8").catch(() => "")).split("\n").filter(Boolean)
        .length,
    close: async () => {
      await bridge.stop();
      Object.defineProperty(process, "platform", platform);
      process.env.PATH = previousPath;
      await rm(dir, { recursive: true, force: true });
    },
  };
};

it.skipIf(process.platform === "win32")(
  "installs missing, outdated and ABI-incompatible helpers once and leaves healthy helpers alone",
  async () => {
    const f = await fixture();
    const events: { event: string; data?: { phase: string } }[] = [];
    f.bridge.on("event", (event) => events.push(event));
    try {
      await f.bridge.start();
      await expect(f.bridge.request("snapshot")).resolves.toMatchObject({ accepted: "snapshot" });
      expect(await f.count()).toBe(1);

      expect(
        events
          .filter((event) => event.event === "runtime.status")
          .map((event) => event.data?.phase),
      ).toEqual(["starting", "preparing", "dependencies", "ready"]);

      await f.bridge.retry();
      expect(await f.count()).toBe(1);

      await f.bridge.stop();
      const marker = join(f.dir, "stale-loaded");

      await writeFile(
        join(f.data, "runtime", "core.cjs"),
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded');`,
      );

      await f.bridge.start();
      expect(await f.count()).toBe(2);
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });

      await f.bridge.stop();
      await writeFile(join(f.core, "package-lock.json"), '{"changed":true}');
      await f.bridge.start();
      expect(await f.count()).toBe(3);

      await f.bridge.stop();
      await writeFile(join(f.data, "runtime", ".dependencies"), "old-node-ABI");
      await f.bridge.start();
      expect(await f.count()).toBe(4);
      await expect(f.bridge.request("snapshot")).resolves.toMatchObject({ accepted: "snapshot" });
    } finally {
      await f.close();
    }
  },
  30000,
);

it.skipIf(process.platform === "win32")(
  "retries failed installation and recovers without changing the chosen configuration",
  async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.dir, "fail"), "fail");
      await f.bridge.start();

      expect(f.bridge.runtimeStatus).toMatchObject({
        event: "runtime.status",
        data: { phase: "failed", essential: true },
      });

      await expect(f.bridge.request("snapshot")).rejects.toThrow("unavailable");
      await rm(join(f.dir, "fail"));
      await f.bridge.retry();
      expect(f.bridge.runtimeStatus).toMatchObject({ data: { phase: "ready" } });
      expect(await f.count()).toBe(2);
      await f.bridge.retry();
      expect(await f.count()).toBe(2);
    } finally {
      await f.close();
    }
  },
  30000,
);

it.skipIf(process.platform === "win32")(
  "refuses an owned data directory and runtime aliases before replacing files or dependencies",
  async () => {
    const f = await fixture();
    try {
      await mkdir(join(f.data, "state"));
      await mkdir(join(f.data, "state", "core.lock.lock"));
      await f.bridge.start();
      expect(f.bridge.runtimeStatus).toMatchObject({ data: { phase: "failed" } });
      expect(await f.count()).toBe(0);
      await rm(join(f.data, "state", "core.lock.lock"), { recursive: true });
      const outside = join(f.dir, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "core.cjs"), "preserved");
      await symlink(outside, join(f.data, "runtime"));
      await expect(f.bridge.retry()).rejects.toThrow("installation");
      expect(await readFile(join(outside, "core.cjs"), "utf8")).toBe("preserved");
      expect(await f.count()).toBe(0);
    } finally {
      await f.close();
    }
  },
  30000,
);
