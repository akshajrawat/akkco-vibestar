import { spawn } from "node:child_process";
import { realpath, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";

import { AdeError } from "../../domain";
import { StreamRedactor } from "../output/stream-redactor";
import { OutputBudget } from "../output/bounded-output";

export interface ProcessRequest {
  rawStdoutForIntegrity?: boolean;
  gitEnvironment?: boolean;
  program: string;
  args: string[];
  cwd: string;
  input?: string;
  timeoutMs?: number;
  progressLines?: boolean;
  wslInterop?: boolean;
  signal?: AbortSignal;
  onLine?: (stream: "stdout" | "stderr", line: string) => void;
  onSpawn?: (pid: number, identity: string) => void;
}

export interface ProcessOutput {
  code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
}

export const redact = (text: string) => {
  if (text.includes("\x1b") || /\\u[\da-f]{4}/i.test(text)) {
    const redactor = new StreamRedactor();
    return redactor.push(text) + redactor.finish(true);
  }

  return text.replace(
    /(\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|oauth[_-]?token|cookie|set-cookie)[\\\s"':=]+(?:bearer[\\\s]+)?)[^\s"',;}]+|\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{12,}|ya29\.[A-Za-z0-9_.-]+)/gi,
    "$1[REDACTED]",
  );
};

export const cleanEnvironment = () => {
  const env: NodeJS.ProcessEnv = {};
  for (const k of [
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "LANG",
    "LC_ALL",
    "XDG_RUNTIME_DIR",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "DBUS_SESSION_BUS_ADDRESS",
    "WSL_DISTRO_NAME",
    "TERM",
    "SSH_AUTH_SOCK",
  ])
    if (process.env[k]) env[k] = process.env[k];
  env.PATH = `${homedir()}/.local/bin:${env.PATH || "/usr/local/bin:/usr/bin:/bin"}`;
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
};

export const processIdentity = async (pid: number) => {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return "";
  }
};

export const terminateGroup = (pid: number, signal: NodeJS.Signals = "SIGINT") => {
  try {
    process.kill(-pid, signal);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
};

export const execute = async (r: ProcessRequest): Promise<ProcessOutput> => {
  if (
    !r.program ||
    r.program.startsWith("-") ||
    r.program.includes("\0") ||
    r.args.some((a) => a.includes("\0"))
  )
    throw new AdeError("invalid_input", "Invalid executable or argv");
  if (r.signal?.aborted) throw new AdeError("cancelled", "Run cancelled");
  const cwd = await realpath(r.cwd);
  return new Promise((resolve, reject) => {
    const start = Date.now();

    const child = spawn(r.program, r.args, {
      cwd,
      env: {
        ...cleanEnvironment(),
        ...(r.gitEnvironment
          ? {
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_SYSTEM: "/dev/null",
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_NO_LAZY_FETCH: "1",
              GIT_NO_REPLACE_OBJECTS: "1",
              GIT_ATTR_NOSYSTEM: "1",
            }
          : {}),
        ...(r.wslInterop && process.env.WSL_INTEROP
          ? { WSL_INTEROP: process.env.WSL_INTEROP }
          : {}),
      },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    let settled = false;
    let aborted: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let stdout = "";
    let stderr = "";
    const truncated = { stdout: false, stderr: false };
    const buffers = { stdout: "", stderr: "" };

    const decoders = {
      stdout: new StringDecoder("utf8"),
      stderr: new StringDecoder("utf8"),
    };

    const integrityDecoder = r.rawStdoutForIntegrity
      ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      : null;

    let integrityBytes = 0;
    const cap = 32 * 1024 * 1024;
    const outputBudget = new OutputBudget();

    const line = (stream: "stdout" | "stderr", value: string) => {
      if (aborted) return;
      try {
        r.onLine?.(stream, redact(value));
      } catch (e) {
        aborted = e instanceof Error ? e : new Error(String(e));
        if (child.pid) terminateGroup(child.pid, "SIGKILL");
      }
    };

    const consume = (stream: "stdout" | "stderr", chunk: Buffer) => {
      if (aborted) return;
      try {
        outputBudget.consume(chunk);
      } catch (error) {
        aborted = error as Error;
        if (child.pid) terminateGroup(child.pid, "SIGKILL");
        return;
      }

      let text: string;
      try {
        text =
          stream === "stdout" && integrityDecoder
            ? integrityDecoder.decode(chunk, { stream: true })
            : decoders[stream].write(chunk);
      } catch {
        aborted = new AdeError(
          "integrity_encoding",
          "Integrity identifiers contain unsupported non-UTF-8 bytes",
        );

        if (child.pid) terminateGroup(child.pid, "SIGKILL");
        return;
      }

      if (stream === "stdout" && integrityDecoder) integrityBytes += chunk.length;
      if (stream === "stdout") {
        truncated.stdout ||= stdout.length + text.length > cap;
        stdout += text.slice(0, Math.max(0, cap - stdout.length));
      } else {
        truncated.stderr ||= stderr.length + text.length > cap;
        stderr += text.slice(0, Math.max(0, cap - stderr.length));
      }

      if (r.rawStdoutForIntegrity && (truncated.stdout || integrityBytes > cap)) {
        aborted = new AdeError("output_limit", "Integrity output exceeded the capture limit");
        if (child.pid) terminateGroup(child.pid, "SIGKILL");
        return;
      }

      if (r.rawStdoutForIntegrity && stream === "stdout" && !r.onLine) return;
      buffers[stream] += text;
      if (buffers[stream].length > 2 * 1024 * 1024) {
        aborted = new AdeError("output_limit", "Provider emitted a line larger than 2 MiB");
        if (child.pid) terminateGroup(child.pid, "SIGKILL");
        return;
      }

      let i;
      while (
        !aborted &&
        (i = r.progressLines ? buffers[stream].search(/[\r\n]/) : buffers[stream].indexOf("\n")) >=
          0
      ) {
        line(stream, buffers[stream].slice(0, i).replace(/\r$/, ""));
        buffers[stream] = buffers[stream].slice(i + 1);
      }
    };

    const interrupt = (error: Error) => {
      if (settled || aborted) return;
      aborted = error;
      if (child.pid) {
        terminateGroup(child.pid);

        killTimer = setTimeout(() => {
          if (child.pid) terminateGroup(child.pid, "SIGKILL");
        }, 3000);

        killTimer.unref();
      }
    };

    const abort = () => interrupt(new AdeError("cancelled", "Run cancelled"));
    r.signal?.addEventListener("abort", abort, { once: true });

    const timer = setTimeout(
      () =>
        interrupt(
          new AdeError("timeout", `Run exceeded ${(r.timeoutMs ?? 120000) / 1000}s timeout`),
        ),
      r.timeoutMs ?? 120000,
    );

    timer.unref();

    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      r.signal?.removeEventListener("abort", abort);
    };

    child.on("spawn", () => {
      if (child.pid)
        void processIdentity(child.pid)
          .then((identity) => {
            if (!settled && child.pid) r.onSpawn?.(child.pid, identity);
          })
          .catch((error: unknown) =>
            interrupt(error instanceof Error ? error : new Error(String(error))),
          );
      if (r.signal?.aborted) abort();
    });

    child.on("error", (e) => {
      cleanup();
      reject(new AdeError("process_start", `Cannot start ${r.program}: ${e.message}`));
    });

    child.stdout.on("data", (c: Buffer) => consume("stdout", c));
    child.stderr.on("data", (c: Buffer) => consume("stderr", c));
    child.stdin.on("error", () => {});
    child.stdin.end(r.input);

    child.on("close", (code) => {
      for (const stream of ["stdout", "stderr"] as const) {
        let remaining = "";
        try {
          remaining =
            stream === "stdout" && integrityDecoder
              ? integrityDecoder.decode()
              : decoders[stream].end();
        } catch {
          aborted ||= new AdeError(
            "integrity_encoding",
            "Integrity identifiers contain unsupported non-UTF-8 bytes",
          );
        }

        buffers[stream] += remaining;
        if (stream === "stdout") stdout += remaining;
        else stderr += remaining;
        if (buffers[stream]) line(stream, buffers[stream]);
      }

      cleanup();
      if (child.pid) terminateGroup(child.pid, "SIGKILL");
      if (aborted) reject(aborted);
      else
        resolve({
          code: code ?? -1,
          stdout: r.rawStdoutForIntegrity ? stdout : redact(stdout),
          stderr: redact(stderr),
          duration_ms: Date.now() - start,
          ...(truncated.stdout ? { stdout_truncated: true } : {}),
          ...(truncated.stderr ? { stderr_truncated: true } : {}),
        });
    });
  });
};

export const capture = (program: string, args: string[], cwd: string, signal?: AbortSignal) =>
  execute({ program, args, cwd, signal });

export const checked = async (
  program: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
) => {
  const o = await capture(program, args, cwd, signal);
  if (o.code !== 0)
    throw new AdeError("command_failed", `${program} exited ${o.code}: ${o.stderr.slice(-6000)}`, {
      program,
      code: o.code,
    });
  return o.stdout.trim();
};
