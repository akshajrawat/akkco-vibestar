import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";

import type { DesktopSettings } from "./contracts";
import type { CoreEvent } from "../backend/domain";
import { StreamRedactor } from "../backend/execution/output/stream-redactor";

const exec = promisify(execFile);

// Never forward retired task mutations to an older helper that might still execute them.
const retiredTaskMethods = new Set([
  "task.create",
  "task.startWorkflow",
  "task.chat",
  "task.retry",
  "task.approve",
  "task.acceptDraft",
  "task.followup",
  "task.complete",
  "task.message.retry",
  "task.message.send",
  "task.configure",
  "task.configureStage",
  "task.verification.recheck",
  "task.verification.policy",
  "task.verification.run",
  "task.verification.fix",
  "task.verification.reviewPreview",
  "task.verification.continueReview",
]);

export class CoreBridge extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;

  private checking = Promise.resolve();

  private warning: string | undefined;

  private finalReviewSettingsAvailable = false;

  private browserVerificationAvailable = false;

  private manualTerminalAvailable = false;

  private pipelineProvidersAvailable = false;

  private manualPrAvailable = false;

  private prReviewControlsAvailable = false;

  private bulkPrMetadataAvailable = false;

  private quickPrWatchAvailable = false;

  private repairAvailable = false;

  private issueWatchAvailable = false;

  private issueWatchBatchesAvailable = false;

  private stopping = false;

  private starting = false;

  private startup = new AbortController();

  private runtimeRestartAvailable = false;

  private notificationPreferencesAvailable = false;

  private essentialSetup = false;

  runtimeStatus: CoreEvent | undefined;

  private status = (phase: string, text: string) => {
    this.runtimeStatus = {
      event: "runtime.status",
      text,
      data: { phase, essential: this.essentialSetup },
    };

    this.emit("event", this.runtimeStatus);
  };

  private agentFlowsAvailable = false;

  private flowContinuationsAvailable = false;

  private viberConversationsAvailable = false;

  private pending = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly coreDir: string,
    private readonly config: DesktopSettings,
  ) {
    super();
  }

  start = () => {
    if (this.starting || this.child) return this.checking;
    this.starting = true;
    this.stopping = false;
    this.startup = new AbortController();
    this.runtimeRestartAvailable = false;
    this.notificationPreferencesAvailable = false;
    this.agentFlowsAvailable = false;
    this.flowContinuationsAvailable = false;
    this.viberConversationsAvailable = false;
    this.manualPrAvailable = false;
    this.prReviewControlsAvailable = false;
    this.bulkPrMetadataAvailable = false;
    this.quickPrWatchAvailable = false;
    this.repairAvailable = false;
    this.issueWatchAvailable = false;
    this.issueWatchBatchesAvailable = false;
    this.finalReviewSettingsAvailable = false;
    this.browserVerificationAvailable = false;
    this.manualTerminalAvailable = false;
    this.pipelineProvidersAvailable = false;

    this.checking = this.launch()
      .catch((error) => {
        if (this.stopping) return;
        this.warning = String(error);
        if (process.platform === "win32") this.status("failed", this.warning);
        else this.emit("event", { event: "core.error", text: this.warning });
      })
      .finally(() => {
        this.starting = false;
      });

    return this.checking;
  };

  /** Probe bytes and native dependency compatibility before loading any helper code. */
  private prepareWsl = async (bundle: Buffer) => {
    if (!this.config.distro) throw new Error("Select a WSL distribution in Settings → Execution.");
    this.status("starting", `Starting WSL (${this.config.distro})...`);

    const script = `
      const fs = require('node:fs/promises');
      const path = require('node:path');
      const os = require('node:os');
      const crypto = require('node:crypto');
      const {createRequire} = require('node:module');
      const config = JSON.parse(process.argv[1]);
      const helper = config.helper_path || path.join(config.data_home || path.join(os.homedir(), '.akkco-vibestar'), 'runtime', 'core.cjs');
      (async () => {
        let healthy = false;
        try {
          const bytes = await fs.readFile(helper);
          healthy = crypto.createHash('sha256').update(bytes).digest('hex') === config.bundle_hash;
          if (healthy && !config.helper_path) {
            const root = path.dirname(helper);
            const lock = await fs.readFile(path.join(root, 'package-lock.json'));
            const expected = crypto.createHash('sha256').update(lock).update(process.versions.modules).digest('hex');
            healthy = crypto.createHash('sha256').update(lock).digest('hex') === config.lock_hash && await fs.readFile(path.join(root, '.dependencies'), 'utf8') === expected;
            const load = createRequire(helper);
            const db = new (load('better-sqlite3'))(':memory:');
            db.close();
            load('node-pty');
          }
        } catch (error) {
          if (!['ENOENT', 'MODULE_NOT_FOUND', 'ERR_DLOPEN_FAILED'].includes(error.code) && error.code) throw error;
          healthy = false;
        }
        process.stdout.write(JSON.stringify({healthy}));
      })().catch(error => { console.error(String(error)); process.exit(1); });
    `;

    const lockHash = this.config.helper_path
      ? undefined
      : createHash("sha256")
          .update(await readFile(join(this.coreDir, "package-lock.json")))
          .digest("hex");

    const result = await exec(
      "wsl.exe",
      [
        "--distribution",
        this.config.distro,
        "--exec",
        "node",
        "-e",
        script,
        JSON.stringify({
          ...this.config,
          bundle_hash: createHash("sha256").update(bundle).digest("hex"),
          lock_hash: lockHash,
        }),
      ],
      { windowsHide: true, timeout: 30000, signal: this.startup.signal },
    );

    if ((JSON.parse(result.stdout) as { healthy: boolean }).healthy) return;
    if (this.config.helper_path)
      throw new Error(
        "The custom WSL helper is missing or incompatible; legacy automatic PR monitoring is blocked. Update the helper at the selected path, or clear Existing helper path in Settings → Execution to use the managed runtime.",
      );
    this.essentialSetup = true;
    await this.install((text) => this.emit("event", { event: "install.output", text }));
  };

  private launch = async () => {
    const bundle = await readFile(join(this.coreDir, "core.cjs"));
    if (process.platform === "win32") await this.prepareWsl(bundle);
    if (this.stopping) return;
    const config = this.config;

    const env = {
      ...process.env,
      ...(config.data_home ? { VIBESTAR_HOME: config.data_home } : {}),
    };

    const launch = `const path=require('node:path');const os=require('node:os');const fs=require('node:fs/promises');const crypto=require('node:crypto');const c=JSON.parse(process.argv[1]);if(c.data_home)process.env.VIBESTAR_HOME=c.data_home;const helper=c.helper_path||path.join(c.data_home||path.join(os.homedir(),'.akkco-vibestar'),'runtime','core.cjs');fs.readFile(helper).then(bytes=>{if(crypto.createHash('sha256').update(bytes).digest('hex')!==c.bundle_hash)throw Error('The WSL helper differs from this desktop build. Install / update WSL helper in Settings before starting execution; legacy automatic PR monitoring is blocked.');require(helper);}).catch(error=>{process.stderr.write(String(error));process.exit(1);});`;

    this.child =
      process.platform === "win32"
        ? spawn(
            "wsl.exe",
            [
              "--distribution",
              config.distro,
              "--exec",
              "node",
              "-e",
              launch,
              JSON.stringify({
                ...config,
                bundle_hash: createHash("sha256").update(bundle).digest("hex"),
              }),
            ],
            { stdio: "pipe", windowsHide: true },
          )
        : spawn("node", [join(this.coreDir, "core.cjs")], {
            stdio: "pipe",
            env,
          });

    const child = this.child;
    let stderr = "";
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });

    lines.on("line", (line) => {
      try {
        const v = JSON.parse(line);
        const request = this.pending.get(v.id);
        if (request) {
          clearTimeout(request.timer);
          this.pending.delete(v.id);
          if (v.error) request.reject(Object.assign(new Error(v.error.message), v.error));
          else request.resolve(v.result);
        } else this.emit("event", v);
      } catch {
        this.emit("event", {
          event: "core.error",
          text: "Execution core emitted malformed protocol data",
        });
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
      if (process.platform !== "win32")
        this.emit("event", { event: "core.error", text: chunk.toString() });
    });

    child.on("error", (e) => this.rejectAll(`Cannot start execution core: ${e.message}`));

    child.stdin.on("error", (error) =>
      this.rejectAll(`Execution core input closed: ${error.message}`),
    );

    child.on("close", () => {
      this.rejectAll(
        "Execution core stopped. Configure WSL, install the helper, or restart to recover tasks.",
      );

      this.child = null;
      if (!this.stopping) {
        if (process.platform === "win32")
          this.status("failed", stderr || "Execution runtime stopped. Retry to recover.");
        else this.emit("event", { event: "core.closed" });
      }
    });

    await Promise.all([
      Promise.resolve(bundle),
      this.sendRequest<{
        build: string;
        agent_flows?: number;
        flow_continuations?: number;
        viber_conversations?: number;
        independent_final_review?: boolean;
        browser_verification_environment?: boolean;
        manual_user_terminal?: number;
        pipeline_stage_providers?: number;
        manual_pr_analysis?: boolean;
        pr_review_controls?: number;
        bulk_pr_metadata?: number;
        pr_quick_watch?: number;
        pr_repair?: boolean;
        manual_issue_watch?: boolean;
        issue_watch_contract?: number;
        issue_watch_batches?: number;
        runtime_restart?: number;
        notification_preferences?: number;
      }>("core.info", {}, 15000),
    ])
      .then(([bundle, info]) => {
        this.runtimeRestartAvailable = info.runtime_restart === 1;
        this.notificationPreferencesAvailable = info.notification_preferences === 1;
        this.agentFlowsAvailable = info.agent_flows === 1;
        this.flowContinuationsAvailable = info.flow_continuations === 1;

        this.viberConversationsAvailable =
          this.agentFlowsAvailable && info.viber_conversations === 1;

        this.finalReviewSettingsAvailable = info.independent_final_review === true;
        this.browserVerificationAvailable = info.browser_verification_environment === true;
        this.manualTerminalAvailable = info.manual_user_terminal === 1;
        this.pipelineProvidersAvailable = info.pipeline_stage_providers === 1;
        this.manualPrAvailable = info.manual_pr_analysis === true;
        this.prReviewControlsAvailable = info.pr_review_controls === 1;
        this.bulkPrMetadataAvailable = info.bulk_pr_metadata === 1;
        this.quickPrWatchAvailable = info.pr_quick_watch === 1;
        this.repairAvailable = info.pr_repair === true;

        this.issueWatchAvailable =
          info.manual_issue_watch === true && info.issue_watch_contract === 1;

        this.issueWatchBatchesAvailable = info.issue_watch_batches === 1;

        this.warning = !this.agentFlowsAvailable
          ? "The running core cannot run Viber profiles and flows. Update the WSL helper in Settings → Execution, then restart."
          : !this.manualPrAvailable
            ? "The helper cannot enforce manual-only PR analysis. Install / update WSL helper before using PR actions."
            : createHash("sha256").update(bundle).digest("hex") === info.build
              ? undefined
              : "The WSL helper differs from this desktop build. Settings → Execution → Install / update WSL helper, then restart. Usage and newer features may be incomplete until updated.";

        if (process.platform === "win32") {
          if (this.warning) throw new Error(this.warning);
          this.status("ready", "Runtime ready");
          this.essentialSetup = false;
        }
      })
      .catch((error) => {
        if (process.platform === "win32") throw error;

        this.warning =
          "The execution helper could not confirm its build. Update the WSL helper in Settings → Execution and restart to ensure telemetry and review features are current.";
      });
  };

  private rejectAll = (message: string) => {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }

    this.pending.clear();
  };

  request = async <T>(method: string, params: unknown = {}): Promise<T> => {
    if (method === "core.prepareRestart")
      throw new Error("Runtime restart is a desktop-only operation.");
    await this.checking;
    if (retiredTaskMethods.has(method))
      throw new Error("This task control is retired. Use Viber profiles and flows.");
    if (!this.viberConversationsAvailable && method.startsWith("viber."))
      throw new Error("Update the execution helper before chatting with individual Vibers.");
    if (!this.flowContinuationsAvailable && method.startsWith("flow.continuation."))
      throw new Error(
        "Update the execution helper before applying saved revisions with verified result reuse.",
      );
    if (
      !this.agentFlowsAvailable &&
      (method.startsWith("flow.") ||
        method.startsWith("profile.") ||
        ["task.createGeneral", "task.createIssue", "task.lifecycle"].includes(method))
    )
      throw new Error("Update the execution helper before using Viber profiles and flows.");
    if (
      this.issueWatchAvailable &&
      ["issueWatch.scan", "issueWatch.retry", "issueWatch.continue"].includes(method) &&
      !this.issueWatchBatchesAvailable
    )
      throw new Error("Update the execution helper to scan Issue Watch in batches of 10.");
    if (!this.pipelineProvidersAvailable && ["repair.create", "repair.start"].includes(method))
      throw new Error(
        this.warning || "Update the execution helper before using per-stage pipeline providers.",
      );
    if (
      method.startsWith("git.") ||
      [
        "repository.configureDestination",
        "repair.approve",
        "repair.approveLocal",
        "repair.commit",
        "repair.preparePublication",
        "repair.publish",
        "repair.reconcilePublication",
        "repair.keepLocal",
      ].includes(method)
    )
      throw new Error("Use the built-in terminal to run Git commands manually.");
    if (!this.manualTerminalAvailable && ["terminal.open", "repair.terminal.open"].includes(method))
      throw new Error("Update the execution helper before opening a manual user terminal.");
    if (!this.browserVerificationAvailable && method.startsWith("task.browser."))
      throw new Error(
        "Update the execution helper before selecting or inspecting browser verification environments.",
      );

    const settings =
      method === "settings.save"
        ? params
        : params && typeof params === "object" && "settings" in params
          ? params.settings
          : undefined;

    if (
      !this.pipelineProvidersAvailable &&
      settings &&
      typeof settings === "object" &&
      ["antigravity", "codex_plan", "codex_implementation", "antigravity_review"].some((key) => {
        const config = (settings as Record<string, unknown>)[key];
        return config && typeof config === "object" && "provider" in config;
      })
    )
      throw new Error("Update the execution helper before saving per-stage pipeline providers.");

    if (
      !this.finalReviewSettingsAvailable &&
      settings &&
      typeof settings === "object" &&
      "antigravity_review" in settings &&
      settings.antigravity_review !== undefined
    )
      throw new Error(
        "Update the execution helper before saving independent final review settings.",
      );
    if (!this.issueWatchAvailable && method.startsWith("issueWatch."))
      throw new Error("Update the execution helper before using manual Issue Watch.");
    if (
      !this.repairAvailable &&
      method.startsWith("repair.") &&
      !["repair.list", "repair.detail", "repair.logs", "repair.events", "repair.cancel"].includes(
        method,
      )
    )
      throw new Error("Update the execution helper before using PR repair.");
    if (
      !this.manualPrAvailable &&
      [
        "github.sync",
        "github.pullRequests.refresh",
        "github.configure",
        "scheduled.add",
        "scheduled.run",
        "scheduled.analyze",
        "scheduled.enabled",
        "scheduled.fix",
      ].includes(method)
    )
      throw new Error(
        this.warning || "Update the execution helper before using manual PR actions.",
      );
    if (
      !this.prReviewControlsAvailable &&
      ["scheduled.analyze", "scheduled.batch.start"].includes(method)
    )
      throw new Error(
        "Update the execution helper before checking PRs with the selected review model.",
      );
    if (!this.bulkPrMetadataAvailable && method === "github.pullRequests.refresh")
      throw new Error("Update the execution helper before using bulk PR metadata refresh.");
    if (!this.quickPrWatchAvailable && method === "pr.watch.start")
      throw new Error("Update the execution helper before using automatic quick PR checks.");
    if (
      method === "settings.save" &&
      !this.notificationPreferencesAvailable &&
      settings &&
      typeof settings === "object" &&
      "notification_preference" in settings
    )
      throw new Error("Update the execution helper before saving notification preferences.");

    try {
      const result = await this.sendRequest<T>(method, params);
      if (method === "snapshot" && result && typeof result === "object")
        return {
          ...result,
          capabilities: {
            ...(this.agentFlowsAvailable ? { agent_flows: 1 } : {}),
            ...(this.flowContinuationsAvailable ? { flow_continuations: 1 } : {}),
            ...(this.viberConversationsAvailable ? { viber_conversations: 1 } : {}),
            manual_issue_watch: this.issueWatchAvailable,
            issue_watch_contract: this.issueWatchAvailable ? 1 : null,
            issue_watch_batches: this.issueWatchBatchesAvailable ? 1 : null,
            ...(this.quickPrWatchAvailable ? { pr_quick_watch: true } : {}),
          },
          ...(this.warning ? { warning: this.warning } : {}),
        };
      if (
        this.warning &&
        ["snapshot", "usage.info"].includes(method) &&
        result &&
        typeof result === "object"
      )
        return { ...result, warning: this.warning };
      return result;
    } catch (error) {
      if (this.warning && error instanceof Error && error.message.includes("Unknown method"))
        throw new Error(this.warning);
      throw error;
    }
  };

  private sendRequest = <T>(
    method: string,
    params: unknown = {},
    timeoutMs = 1900000,
  ): Promise<T> => {
    const child = this.child;
    if (!child || child.exitCode !== null)
      return Promise.reject(
        new Error("Execution core unavailable. Use Settings to install the WSL helper."),
      );
    return new Promise((resolve, reject) => {
      const id = randomUUID();

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Core request timed out: ${method}`));
      }, timeoutMs);

      timer.unref();
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });

      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  };

  stop = async () => {
    this.stopping = true;
    this.startup.abort();
    await this.checking;
    const child = this.child;
    if (!child) return;

    await new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.stdin.end();

      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 5000);

      timer.unref();
      child.once("close", () => clearTimeout(timer));
    });
  };

  /** The core atomically refuses active work and closes admission before a host restart. */
  prepareRestart = async () => {
    await this.checking;
    if (!this.child) return;
    if (!this.runtimeRestartAvailable)
      throw new Error(
        "This helper cannot safely restart while checking active work. Close the app before changing its runtime.",
      );
    const result = await this.sendRequest<{ ready: boolean }>("core.prepareRestart", {}, 15000);
    if (result?.ready !== true) throw new Error("The core did not confirm a safe runtime restart.");
  };

  retry = async () => {
    await this.prepareRestart();
    await this.stop();
    await this.start();
    if ((this.runtimeStatus?.data as { phase?: string } | undefined)?.phase === "failed")
      throw new Error(this.runtimeStatus?.text || "Runtime unavailable");
  };

  repair = async () => {
    if (process.platform !== "win32") return;
    if (!this.config.distro)
      throw new Error("Select a WSL distribution in Settings → Execution first.");
    if (this.config.helper_path)
      throw new Error(
        "The selected custom helper is user-managed. Update it at the selected path or clear Existing helper path.",
      );
    await this.prepareRestart();
    await this.stop();
    this.stopping = false;
    this.startup = new AbortController();
    try {
      await this.install((text) => this.emit("event", { event: "install.output", text }));
      await this.start();
      if (
        this.runtimeStatus?.data &&
        (this.runtimeStatus.data as { phase: string }).phase === "failed"
      )
        throw new Error(this.runtimeStatus.text);
    } catch (error) {
      this.status("failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  install = async (onOutput: (text: string) => void) => {
    if (process.platform !== "win32") return;
    if (this.child) throw new Error("Stop the execution core before repairing its runtime.");
    if (this.config.helper_path)
      throw new Error(
        "The selected custom helper is user-managed. Clear Existing helper path to use the bundled runtime.",
      );
    this.essentialSetup = true;
    this.status("preparing", "Preparing Vibestar runtime...");
    const data: Record<string, string> = {};
    for (const file of ["core.cjs", "package.json", "package-lock.json", "LICENSE"])
      data[file] = (await readFile(join(this.coreDir, file))).toString("base64");

    const script = `
      const fs = require('node:fs/promises');
      const path = require('node:path');
      const os = require('node:os');
      const cp = require('node:child_process');
      const crypto = require('node:crypto');
      let input = '';
      process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', async () => {
        let ownedLock;
        let heartbeat;
        let child;
        const finish = async (code, error) => {
          clearInterval(heartbeat);
          if (error) console.error(String(error));
          if (ownedLock) await fs.rmdir(ownedLock).catch(() => {});
          process.exit(code);
        };
        try {
          const value = JSON.parse(input);
          const root = value.home || path.join(os.homedir(), '.akkco-vibestar');
          const dir = path.join(root, 'runtime');
          const state = path.join(root, 'state');
          await fs.mkdir(state, {recursive: true, mode: 448});
          await fs.writeFile(path.join(state, 'core.lock'), '', {flag: 'a', mode: 384});
          const lock = path.join(state, 'core.lock.lock');
          try { await fs.mkdir(lock); }
          catch (error) {
            if (error.code === 'EEXIST') throw Error('Another runtime owns this data directory. Close it before repairing the runtime.');
            throw error;
          }
          ownedLock = lock;
          heartbeat = setInterval(() => {
            const now = new Date();
            fs.utimes(lock, now, now).catch(error => {
              child?.kill();
              void finish(1, error);
            });
          }, 2000);
          await fs.mkdir(dir, {recursive: true, mode: 448});
          if ((await fs.lstat(dir)).isSymbolicLink()) throw Error('The runtime directory must not be a symbolic link.');
          for (const name of [...Object.keys(value.files), '.dependencies', 'node_modules']) {
            const entry = await fs.lstat(path.join(dir, name)).catch(error => {
              if (error.code !== 'ENOENT') throw error;
            });
            if (entry?.isSymbolicLink()) throw Error('Runtime files and dependencies must not be symbolic links.');
          }
          await fs.rm(path.join(dir, '.dependencies'), {force: true});
          for (const [name, content] of Object.entries(value.files))
            await fs.writeFile(path.join(dir, name), Buffer.from(content, 'base64'), {mode: 384});
          child = cp.spawn('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {cwd: dir, stdio: 'inherit', shell: false});
          child.on('error', error => void finish(1, error));
          child.on('exit', async code => {
            if (code !== 0) return finish(code || 1);
            try {
              const digest = crypto.createHash('sha256').update(await fs.readFile(path.join(dir, 'package-lock.json'))).update(process.versions.modules).digest('hex');
              await fs.writeFile(path.join(dir, '.dependencies'), digest, {mode: 384});
              await finish(0);
            } catch (error) { await finish(1, error); }
          });
          for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, () => {
            child.kill(signal);
          });
        } catch (error) { await finish(1, error); }
      });
    `;

    this.status("dependencies", "Installing dependencies...");

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "wsl.exe",
        ["--distribution", this.config.distro, "--exec", "node", "-e", script],
        { stdio: "pipe", windowsHide: true, signal: this.startup.signal },
      );

      const stdout = new StreamRedactor();
      const stderr = new StreamRedactor();
      let diagnostic = "";

      const output = (text: string) => {
        diagnostic = (diagnostic + text).slice(-2000);
        if (text) onOutput(text);
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => output(stdout.push(chunk)));
      child.stderr.on("data", (chunk: string) => output(stderr.push(chunk)));
      child.on("error", reject);
      child.stdin.on("error", reject);

      child.on("close", (code) => {
        output(stdout.finish(true));
        output(stderr.finish(true));
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `WSL helper installation exited ${code}${diagnostic ? `: ${diagnostic.trim()}` : ""}`,
            ),
          );
      });

      child.stdin.end(JSON.stringify({ files: data, home: this.config.data_home }));
    });
  };
}

export const readDesktopConfig = async (path: string): Promise<DesktopSettings> => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return { distro: "", data_home: "", helper_path: "" };
  }
};

export const saveDesktopConfig = async (path: string, config: DesktopSettings) => {
  await mkdir(join(path, ".."), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(config), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};
