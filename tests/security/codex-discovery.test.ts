import { afterEach, expect, it, vi } from "vitest";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { discoverCodexModels } from "../../backend/execution/providers/codex-models";

const fixture = vi.hoisted(() => ({
  script: "",
  children: [] as ChildProcess[],
}));
vi.mock("node:child_process", async (original) => {
  const module = await original<typeof import("node:child_process")>();
  return {
    ...module,
    spawn: (program: string, _args: string[], options: SpawnOptions) => {
      expect(program).toBe("codex");
      const child = module.spawn(process.execPath, ["-e", fixture.script], options);
      fixture.children.push(child);
      return child;
    },
  };
});
afterEach(() => {
  for (const child of fixture.children.splice(0)) {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      /* Already settled. */
    }
  }
});
const protocol = (extra: string, cursor = "null") => `
${extra}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);
 if(message.id===0) console.log(JSON.stringify({id:0,result:{}}));
 if(message.id===1) console.log(JSON.stringify({id:1,result:{data:[{id:'fixture-model',model:'fixture-model',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:${cursor}}}));
 if(message.id===2) console.log(JSON.stringify({id:2,result:{rateLimits:{planType:'fixture',primary:{usedPercent:12,windowDurationMins:300,resetsAt:1900000000}}}}));
});
setInterval(()=>{},1000);`;

it("settles successful discovery only after killing the process group, without starting a model turn", async () => {
  fixture.script = protocol("process.on('SIGTERM',()=>{});");
  const result = await discoverCodexModels(tmpdir());
  expect(result.models).toMatchObject([{ id: "fixture-model", supportedEfforts: ["high"] }]);
  expect(result.subscriptionLimits?.windows[0].usedPercent).toBe(12);
  expect(fixture.children[0].signalCode).toBe("SIGKILL");
  expect(fixture.children[0].stdout?.readableEnded).toBe(true);
});

it.each([
  ["line", "process.stdout.write('x'.repeat(300*1024));"],
  ["total", "process.stderr.write('x'.repeat(3*1024*1024));"],
  ["invalid", "console.log('invalid JSON');"],
])("bounds %s protocol data and waits for process close", async (_kind, script) => {
  fixture.script = `${script}setInterval(()=>{},1000);`;
  await expect(discoverCodexModels(tmpdir())).rejects.toThrow(/limit|Invalid/);
  expect(fixture.children[0].exitCode !== null || fixture.children[0].signalCode !== null).toBe(
    true,
  );
});

it("rejects a repeated pagination cursor", async () => {
  fixture.script = protocol("", "'repeated'");
  await expect(discoverCodexModels(tmpdir())).rejects.toThrow("pagination");
  expect(fixture.children[0].signalCode).not.toBeNull();
});

it("cancels and settles descendants before returning", async () => {
  fixture.script = `const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stderr.write(String(child.pid)+'\\n');setInterval(()=>{},1000);`;
  const controller = new AbortController();
  const result = discoverCodexModels(tmpdir(), controller.signal);
  const rejected = expect(result).rejects.toThrow("cancelled");
  const [data] = await once(fixture.children[0].stderr!, "data");
  const pid = Number(String(data).trim());
  controller.abort();
  await rejected;
  expect(["SIGTERM", "SIGKILL"]).toContain(fixture.children[0].signalCode);
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  expect(!stat || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")).toBe(true);
});
