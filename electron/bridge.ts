import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { DesktopSettings } from "./contracts";
export class CoreBridge extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private checking = Promise.resolve();
  private warning: string | undefined;
  private approvalsAvailable = false;
  private instructionChoicesAvailable = false;
  private workflowFirstAvailable = false;
  private finalReviewSettingsAvailable = false;
  private browserVerificationAvailable = false;
  private pipelineVerificationAvailable = false;
  private verificationPolicyAvailable = false;
  private exactCommitMessagesAvailable = false;
  private gitFinalizationAvailable = false;
  private manualPrAvailable = false;
  private repairAvailable = false;
  private issueWatchAvailable = false;
  private stopping = false;
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
    this.stopping = false;
    this.manualPrAvailable = false;
    this.repairAvailable = false;
    this.issueWatchAvailable = false;
    this.approvalsAvailable = false;
    this.instructionChoicesAvailable = false;
    this.workflowFirstAvailable = false;
    this.finalReviewSettingsAvailable = false;
    this.browserVerificationAvailable = false;
    this.pipelineVerificationAvailable = false;
    this.verificationPolicyAvailable = false;
    this.exactCommitMessagesAvailable = false;
    this.gitFinalizationAvailable = false;
    this.checking = this.launch().catch((error) => {
      this.warning = String(error);
      this.emit("event", { event: "core.error", text: this.warning });
    });
  };
  private launch = async () => {
    const bundle = await readFile(join(this.coreDir, "core.cjs"));
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
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      try {
        const v = JSON.parse(line);
        const request = this.pending.get(v.id);
        if (request) {
          clearTimeout(request.timer);
          this.pending.delete(v.id);
          if (v.error)
            request.reject(Object.assign(new Error(v.error.message), v.error));
          else request.resolve(v.result);
        } else this.emit("event", v);
      } catch {
        this.emit("event", {
          event: "core.error",
          text: "Execution core emitted malformed protocol data",
        });
      }
    });
    child.stderr.on("data", (chunk) =>
      this.emit("event", { event: "core.error", text: chunk.toString() }),
    );
    child.on("error", (e) =>
      this.rejectAll(`Cannot start execution core: ${e.message}`),
    );
    child.on("close", () => {
      this.rejectAll(
        "Execution core stopped. Configure WSL, install the helper, or restart to recover tasks.",
      );
      this.child = null;
      this.emit("event", { event: "core.closed" });
    });
    await Promise.all([
      Promise.resolve(bundle),
      this.sendRequest<{
        build: string;
        pipeline_approvals?: boolean;
        saved_instruction_choices?: boolean;
        workflow_first?: number;
        independent_final_review?: boolean;
        browser_verification_environment?: boolean;
        pipeline_verification?: number;
        verification_policy?: boolean;
        exact_commit_messages?: boolean;
        git_finalization?: number;
        manual_pr_analysis?: boolean;
        pr_repair?: boolean;
        manual_issue_watch?: boolean;
        issue_watch_contract?: number;
      }>("core.info", {}, 15000),
    ])
      .then(([bundle, info]) => {
        this.approvalsAvailable = info.pipeline_approvals === true;
        this.instructionChoicesAvailable =
          info.saved_instruction_choices === true;
        this.workflowFirstAvailable = info.workflow_first === 1;
        this.finalReviewSettingsAvailable =
          info.independent_final_review === true;
        this.browserVerificationAvailable =
          info.browser_verification_environment === true;
        this.pipelineVerificationAvailable = info.pipeline_verification === 2;
        this.verificationPolicyAvailable = info.verification_policy === true;
        this.exactCommitMessagesAvailable = info.exact_commit_messages === true;
        this.gitFinalizationAvailable = info.git_finalization === 1;
        this.manualPrAvailable = info.manual_pr_analysis === true;
        this.repairAvailable = info.pr_repair === true;
        this.issueWatchAvailable =
          info.manual_issue_watch === true && info.issue_watch_contract === 1;
        this.warning = !this.approvalsAvailable
          ? "The running core cannot enforce plan review approvals. Restart the current dev build, or update the WSL helper in Settings → Execution. Task execution is blocked until updated."
          : !this.manualPrAvailable
            ? "The helper cannot enforce manual-only PR analysis. Install / update WSL helper before using PR actions."
            : createHash("sha256").update(bundle).digest("hex") === info.build
              ? undefined
              : "The WSL helper differs from this desktop build. Settings → Execution → Install / update WSL helper, then restart. Usage and newer features may be incomplete until updated.";
      })
      .catch(() => {
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
    await this.checking;
    if (
      method === "task.verification.policy" &&
      !this.verificationPolicyAvailable
    )
      throw new Error(
        "Update the execution helper before changing verification policy.",
      );
    if (
      !this.pipelineVerificationAvailable &&
      method.startsWith("task.verification.")
    )
      throw new Error(
        "Update the execution helper before using verification recovery and review with gaps.",
      );
    if (!this.gitFinalizationAvailable && method.startsWith("git."))
      throw new Error(
        "Update the execution helper before using Git Finalization.",
      );
    if (!this.exactCommitMessagesAvailable && method === "repair.commit")
      throw new Error(
        "Update the execution helper before committing exact multiline messages.",
      );
    if (
      !this.browserVerificationAvailable &&
      method.startsWith("task.browser.")
    )
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
      throw new Error(
        "Update the execution helper before using manual Issue Watch.",
      );
    if (
      !this.repairAvailable &&
      method.startsWith("repair.") &&
      ![
        "repair.list",
        "repair.detail",
        "repair.logs",
        "repair.events",
        "repair.cancel",
      ].includes(method)
    )
      throw new Error(
        "Update the execution helper before using PR repair and publishing.",
      );
    if (
      !this.manualPrAvailable &&
      [
        "github.sync",
        "github.configure",
        "scheduled.add",
        "scheduled.run",
        "scheduled.analyze",
        "scheduled.enabled",
        "scheduled.fix",
      ].includes(method)
    )
      throw new Error(
        this.warning ||
          "Update the execution helper before using manual PR actions.",
      );
    if (
      !this.approvalsAvailable &&
      [
        "task.create",
        "task.retry",
        "task.followup",
        "task.message.retry",
        "task.approve",
        "task.acceptDraft",
      ].includes(method)
    )
      throw new Error(
        this.warning ||
          "Restart the updated core before starting task execution.",
      );
    if (
      !this.instructionChoicesAvailable &&
      [
        "task.retry",
        "task.followup",
        "task.message.retry",
        "task.message.send",
        "task.approve",
        "task.configureStage",
      ].includes(method)
    )
      throw new Error(
        "Update the execution helper before using saved instruction choices and future stage settings.",
      );
    if (
      !this.workflowFirstAvailable &&
      ["task.create", "task.chat", "task.startWorkflow"].includes(method)
    )
      throw new Error(
        "Update the execution helper before creating idle tasks or using read-only task conversations.",
      );
    try {
      const result = await this.sendRequest<T>(method, params);
      if (method === "snapshot" && result && typeof result === "object")
        return {
          ...result,
          capabilities: {
            manual_issue_watch: this.issueWatchAvailable,
            issue_watch_contract: this.issueWatchAvailable ? 1 : null,
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
      if (
        this.warning &&
        error instanceof Error &&
        error.message.includes("Unknown method")
      )
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
        new Error(
          "Execution core unavailable. Use Settings to install the WSL helper.",
        ),
      );
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Core request timed out: ${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      child.stdin.write(
        `${JSON.stringify({ id, method, params })}\n`,
        (error) => {
          if (error) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(error);
          }
        },
      );
    });
  };
  stop = async () => {
    this.stopping = true;
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
  install = async (onOutput: (text: string) => void) => {
    if (process.platform !== "win32") return;
    const data: Record<string, string> = {};
    for (const file of ["core.cjs", "package.json", "package-lock.json"])
      data[file] = (await readFile(join(this.coreDir, file))).toString(
        "base64",
      );
    const script = `const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const cp=require('node:child_process');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',async()=>{try{const v=JSON.parse(input);const root=v.home||path.join(os.homedir(),'.akkco-vibestar');const dir=path.join(root,'runtime');await fs.mkdir(dir,{recursive:true,mode:448});for(const[name,content]of Object.entries(v.files))await fs.writeFile(path.join(dir,name),Buffer.from(content,'base64'),{mode:384});const p=cp.spawn('npm',['ci','--omit=dev','--no-audit','--no-fund'],{cwd:dir,stdio:'inherit',shell:false});p.on('exit',code=>process.exit(code||0));}catch(e){console.error(String(e));process.exit(1);}});`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "wsl.exe",
        ["--distribution", this.config.distro, "--exec", "node", "-e", script],
        { stdio: "pipe", windowsHide: true },
      );
      child.stdout.on("data", (c) => onOutput(c.toString()));
      child.stderr.on("data", (c) => onOutput(c.toString()));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`WSL helper installation exited ${code}`)),
      );
      child.stdin.end(
        JSON.stringify({ files: data, home: this.config.data_home }),
      );
    });
  };
}
export const readDesktopConfig = async (
  path: string,
): Promise<DesktopSettings> => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return { distro: "", data_home: "", helper_path: "" };
  }
};
export const saveDesktopConfig = async (
  path: string,
  config: DesktopSettings,
) => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
};
