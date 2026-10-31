import { it, expect } from "vitest";

import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CoreBridge } from "../../electron/bridge";

const helper = (
  manual = true,
  watch = false,
  instructions = true,
  finalReview = true,
  pipelineProviders = true,
) => `
const {createInterface}=require('node:readline');
const {createHash}=require('node:crypto');
const {readFile}=require('node:fs/promises');
readFile(__filename).then(bytes=>{
const build=createHash('sha256').update(bytes).digest('hex');
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{
const request=JSON.parse(line);
const result=request.method==='core.info'?{build,pipeline_approvals:true,workflow_first:1,saved_instruction_choices:${instructions},independent_final_review:${finalReview},pipeline_stage_providers:${pipelineProviders ? 1 : 0},manual_pr_analysis:${manual},pr_review_controls:1,manual_issue_watch:${watch},issue_watch_contract:${watch ? 1 : 0}}:{accepted:request.method};
process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');
});
lines.on('close',()=>process.exit(0));
});`;

it.skipIf(process.platform === "win32")(
  "negotiates quick PR watch independently and retains cancellation for old helpers",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-bridge-quick-pr-"));
    let bridge = new CoreBridge(dir, { distro: "", data_home: dir, helper_path: "" });
    try {
      await writeFile(join(dir, "core.cjs"), helper());
      bridge.start();

      await expect(bridge.request("pr.watch.start", {})).rejects.toThrow(
        "automatic quick PR checks",
      );

      await expect(bridge.request("pr.watch.cancel", {})).resolves.toEqual({
        accepted: "pr.watch.cancel",
      });

      await bridge.stop();

      await writeFile(
        join(dir, "core.cjs"),
        helper().replace("pr_review_controls:1,", "pr_review_controls:1,pr_quick_watch:1,"),
      );

      bridge = new CoreBridge(dir, { distro: "", data_home: dir, helper_path: "" });
      bridge.start();

      await expect(bridge.request("snapshot")).resolves.toMatchObject({
        capabilities: { pr_quick_watch: true },
      });

      await expect(bridge.request("pr.watch.start", {})).resolves.toEqual({
        accepted: "pr.watch.start",
      });
    } finally {
      await bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "requires bulk metadata support before dispatching a PR-only refresh",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-bridge-pr-metadata-"));
    await writeFile(join(dir, "core.cjs"), helper());
    let bridge = new CoreBridge(dir, { distro: "", data_home: dir, helper_path: "" });
    try {
      bridge.start();

      await expect(bridge.request("github.pullRequests.refresh", {})).rejects.toThrow(
        "bulk PR metadata",
      );

      await bridge.stop();

      await writeFile(
        join(dir, "core.cjs"),
        helper().replace("pr_review_controls:1,", "pr_review_controls:1,bulk_pr_metadata:1,"),
      );

      bridge = new CoreBridge(dir, { distro: "", data_home: dir, helper_path: "" });
      bridge.start();

      await expect(bridge.request("github.pullRequests.refresh", {})).resolves.toEqual({
        accepted: "github.pullRequests.refresh",
      });
    } finally {
      await bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "refuses helpers that cannot honor the chosen PR review model",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-bridge-pr-review-"));
    await writeFile(join(dir, "core.cjs"), helper().replace("pr_review_controls:1,", ""));
    const bridge = new CoreBridge(dir, { distro: "", data_home: dir, helper_path: "" });
    try {
      bridge.start();
      for (const method of ["scheduled.analyze", "scheduled.batch.start"])
        await expect(bridge.request(method, {})).rejects.toThrow("selected review model");

      await expect(bridge.request("scheduled.detail", {})).resolves.toEqual({
        accepted: "scheduled.detail",
      });
    } finally {
      await bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "refuses helpers that would ignore selected pipeline providers",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-bridge-providers-"));
    await writeFile(join(dir, "core.cjs"), helper(true, true, true, true, false));
    const bridge = new CoreBridge(dir, { distro: "", data_home: dir, helper_path: "" });
    try {
      bridge.start();

      await expect(bridge.request("task.startWorkflow", {})).rejects.toThrow(
        "per-stage pipeline providers",
      );

      await expect(
        bridge.request("settings.save", {
          codex_plan: { provider: "antigravity", model: "", effort: "high", timeout_secs: 30 },
        }),
      ).rejects.toThrow("per-stage pipeline providers");

      await expect(bridge.request("task.detail", {})).resolves.toEqual({ accepted: "task.detail" });
    } finally {
      await bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

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

      await expect(bridge.request("git.preview", {})).rejects.toThrow("built-in terminal");

      await expect(bridge.request("repository.configureDestination", {})).rejects.toThrow(
        "built-in terminal",
      );

      for (const method of ["terminal.open", "repair.terminal.open"])
        await expect(bridge.request(method, {})).rejects.toThrow("manual user terminal");

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

      await expect(bridge.request("repair.commit")).rejects.toThrow("built-in terminal");
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
                issue_watch_batches: null,
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

      await expect(bridge.request("issueWatch.scan", { order: "newest" })).rejects.toThrow(
        "batches of 10",
      );

      for (const method of ["issueWatch.retry", "issueWatch.continue"])
        await expect(bridge.request(method, {})).rejects.toThrow("batches of 10");
    } finally {
      await bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "forwards batched scans only after the helper confirms batch support",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-bridge-batches-"));

    await writeFile(
      join(dir, "core.cjs"),
      helper(true, true).replace(
        "issue_watch_contract:1",
        "issue_watch_contract:1,issue_watch_batches:1",
      ),
    );

    const bridge = new CoreBridge(dir, { distro: "", data_home: dir, helper_path: "" });
    try {
      bridge.start();

      await expect(bridge.request("snapshot")).resolves.toMatchObject({
        capabilities: { issue_watch_batches: 1 },
      });

      await expect(bridge.request("issueWatch.scan", { order: "oldest" })).resolves.toEqual({
        accepted: "issueWatch.scan",
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

it.skipIf(process.platform === "win32")(
  "requires workspace-chat capability for editing while retaining read-only chat",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-bridge-workspace-chat-"));
    let bridge = new CoreBridge(dir, { distro: "", data_home: dir, helper_path: "" });
    try {
      await writeFile(join(dir, "core.cjs"), helper());
      bridge.start();

      await expect(
        bridge.request("task.chat", { configuration: { access: "workspace" } }),
      ).rejects.toThrow("workspace edits in chat");

      await expect(bridge.request("task.chat", { configuration: {} })).resolves.toEqual({
        accepted: "task.chat",
      });

      await bridge.stop();

      await writeFile(
        join(dir, "core.cjs"),
        helper().replace("workflow_first:1,", "workflow_first:1,workspace_chat:1,"),
      );

      bridge = new CoreBridge(dir, { distro: "", data_home: dir, helper_path: "" });
      bridge.start();

      await expect(
        bridge.request("task.chat", { configuration: { access: "workspace" } }),
      ).resolves.toEqual({ accepted: "task.chat" });
    } finally {
      await bridge.stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
