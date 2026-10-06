import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { DesktopSettings } from "./contracts";
export class CoreBridge extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
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
    const config = this.config;
    const env = {
      ...process.env,
      ...(config.data_home ? { VIBESTAR_HOME: config.data_home } : {}),
    };
    const launch = `const path=require('node:path');const os=require('node:os');const c=JSON.parse(process.argv[1]);if(c.data_home)process.env.VIBESTAR_HOME=c.data_home;require(c.helper_path||path.join(c.data_home||path.join(os.homedir(),'.akkco-ade'),'state','runtime','core.cjs'));`;
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
              JSON.stringify(config),
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
          if (v.error) request.reject(new Error(v.error.message));
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
  };
  private rejectAll = (message: string) => {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
    this.pending.clear();
  };
  request = <T>(method: string, params: unknown = {}): Promise<T> => {
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
      }, 1900000);
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
    const script = `const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const cp=require('node:child_process');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',async()=>{try{const v=JSON.parse(input);const root=v.home||path.join(os.homedir(),'.akkco-ade');const dir=path.join(root,'state','runtime');await fs.mkdir(dir,{recursive:true,mode:448});for(const[name,content]of Object.entries(v.files))await fs.writeFile(path.join(dir,name),Buffer.from(content,'base64'),{mode:384});const p=cp.spawn('npm',['ci','--omit=dev','--no-audit','--no-fund'],{cwd:dir,stdio:'inherit',shell:false});p.on('exit',code=>process.exit(code||0));}catch(e){console.error(String(e));process.exit(1);}});`;
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
