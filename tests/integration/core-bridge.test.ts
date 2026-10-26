import { it, expect } from "vitest";

import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CoreBridge } from "../../electron/bridge";

const helper = (manual = true, watch = false, instructions = true, finalReview = true) => `
const {createInterface}=require('node:readline');
const {createHash}=require('node:crypto');
const {readFile}=require('node:fs/promises');
readFile(__filename).then(bytes=>{
const build=createHash('sha256').update(bytes).digest('hex');
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{
const request=JSON.parse(line);
const result=request.method==='core.info'?{build,pipeline_approvals:true,workflow_first:1,saved_instruction_choices:${instructions},independent_final_review:${finalReview},manual_pr_analysis:${manual},manual_issue_watch:${watch},issue_watch_contract:${watch ? 1 : 0}}:{accepted:request.method};
process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');
});
lines.on('close',()=>process.exit(0));
});`;

it.skipIf(process.platform === "win32")(
  "refuses independent final-review configuration on helpers that would silently discard it",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-bridge-final-review-"));
    await writeFile(join(dir, "core.cjs"), helper(true, true, true, false));

    const bridge = new CoreBridge(dir, {
      distro: "",
      data_home: dir,
      helper_path: "",
    });

    try {
      bridge.start();

      await expect(bridge.request("task.verification.policy", {})).rejects.toThrow(
        "verification policy",
      );

      await expect(bridge.request("git.preview", {})).rejects.toThrow("Git Finalization");

      const settings = {
        antigravity_review: {
          model: "review",
          effort: "low",
          timeout_secs: 30,
        },
      };

      await expect(bridge.request("settings.save", settings)).rejects.toThrow(
        "independent final review",
      );

      await expect(bridge.request("task.create", { settings })).rejects.toThrow(
        "independent final review",
      );

      await expect(bridge.request("settings.save", {})).resolves.toEqual({
        accepted: "settings.save",
      });
    } finally {
      await bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "blocks legacy PR actions independently of issue execution capability",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-bridge-policy-"));
    await writeFile(join(dir, "core.cjs"), helper(false));

    const bridge = new CoreBridge(dir, {
      distro: "",
      data_home: dir,
      helper_path: "",
    });

    try {
      bridge.start();
      await expect(bridge.request("scheduled.analyze")).rejects.toThrow("manual-only PR analysis");
      await expect(bridge.request("github.sync")).rejects.toThrow("manual-only PR analysis");

      await expect(bridge.request("task.create")).resolves.toEqual({
        accepted: "task.create",
      });

      await expect(bridge.request("issueWatch.scan")).rejects.toThrow("manual Issue Watch");

      await expect(bridge.request("task.browser.inspect")).rejects.toThrow(
        "browser verification environments",
      );

      await expect(bridge.request("repair.commit")).rejects.toThrow("exact multiline messages");
    } finally {
      await bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "checks the WSL helper bytes before loading code that could start legacy timers",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-bridge-wsl-"));
    const bin = join(dir, "bin");
    await mkdir(bin);

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

    const bundled = helper();
    await writeFile(join(dir, "core.cjs"), bundled);
    const installed = join(dir, "installed.cjs");
    const marker = join(dir, "legacy-loaded");
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = `${bin}:${originalPath}`;
      Object.defineProperty(process, "platform", { value: "win32" });
      for (const stale of [true, false]) {
        await writeFile(
          installed,
          stale
            ? `require('node:fs/promises').writeFile(${JSON.stringify(marker)},'loaded');${bundled}`
            : bundled,
        );

        const bridge = new CoreBridge(dir, {
          distro: "Fixture",
          data_home: dir,
          helper_path: installed,
        });

        const events: { event: string; text?: string }[] = [];
        bridge.on("event", (event) => events.push(event));
        try {
          bridge.start();
          if (stale) {
            await expect(bridge.request("scheduled.analyze")).rejects.toThrow("helper");

            expect(
              events.some((event) =>
                event.text?.includes("legacy automatic PR monitoring is blocked"),
              ),
            ).toBe(true);

            await expect(readFile(marker)).rejects.toMatchObject({
              code: "ENOENT",
            });
          } else {
            await expect(bridge.request("snapshot")).resolves.toEqual({
              accepted: "snapshot",
              capabilities: {
                manual_issue_watch: false,
                issue_watch_contract: null,
              },
            });
          }
        } finally {
          await bridge.stop();
        }
      }
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
      process.env.PATH = originalPath;
      await rm(dir, { recursive: true, force: true });
    }
  },
  30000,
);

it.skipIf(process.platform === "win32")(
  "negotiates Issue Watch separately without starting any scan",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-bridge-issue-watch-"));
    await writeFile(join(dir, "core.cjs"), helper(true, true));

    const bridge = new CoreBridge(dir, {
      distro: "",
      data_home: dir,
      helper_path: "",
    });

    try {
      bridge.start();

      await expect(bridge.request("snapshot")).resolves.toMatchObject({
        capabilities: { manual_issue_watch: true, issue_watch_contract: 1 },
      });

      await expect(bridge.request("issueWatch.create")).resolves.toEqual({
        accepted: "issueWatch.create",
      });
    } finally {
      await bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "refuses legacy helpers that cannot preserve saved instruction choices",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-bridge-instructions-"));
    await writeFile(join(dir, "core.cjs"), helper(true, true, false));

    const bridge = new CoreBridge(dir, {
      distro: "",
      data_home: dir,
      helper_path: "",
    });

    try {
      bridge.start();
      for (const method of [
        "task.followup",
        "task.retry",
        "task.approve",
        "task.message.send",
        "task.configureStage",
      ])
        await expect(bridge.request(method)).rejects.toThrow("saved instruction choices");

      await expect(bridge.request("task.detail")).resolves.toEqual({
        accepted: "task.detail",
      });
    } finally {
      await bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
