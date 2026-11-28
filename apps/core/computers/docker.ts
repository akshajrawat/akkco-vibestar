import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AdeError } from "../domain";
import { execute, type ProcessRequest } from "../execution/runtime/process";

export interface Daemon {
  socket: string;
  daemon_id: string;
}

export interface ContainerInspection {
  Id: string;
  Config: { Labels: Record<string, string>; User: string; Image: string };
  HostConfig: {
    NetworkMode: string;
    PortBindings: Record<string, unknown> | null;
    Privileged: boolean;
    SecurityOpt: string[] | null;
    CapDrop: string[] | null;
    CapAdd: string[] | null;
    ReadonlyRootfs: boolean;
    Mounts: { Target: string; BindOptions?: { NonRecursive?: boolean } }[];
  };
  State: { Running: boolean; StartedAt: string; Health?: { Status: string } };
  Mounts: { Type: string; Source: string; Destination: string; Name?: string; RW: boolean }[];
}

const localSocket = async (pinned?: string) => {
  const sockets = pinned
    ? [pinned]
    : ["/var/run/docker.sock", `/run/user/${process.getuid?.()}/docker.sock`];

  for (const socket of sockets) {
    if (isAbsolute(socket) && (await stat(socket).catch(() => null))?.isSocket()) {
      return socket;
    }
  }

  throw new AdeError(
    "docker_offline",
    "Start Docker Engine or enable Docker Desktop WSL integration for this distribution.",
  );
};

const offline = (error: unknown) => error instanceof AdeError && error.kind === "docker_offline";

const launchDesktop = String.raw`
$ErrorActionPreference = 'Stop'
$exe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
if (!(Test-Path -LiteralPath $exe -PathType Leaf)) {
  $cli = Get-Command docker.exe -CommandType Application -ErrorAction SilentlyContinue
  if ($cli) {
    $exe = Join-Path (Split-Path -Parent $cli.Source) '..\..\Docker Desktop.exe'
  }
}
if (!(Test-Path -LiteralPath $exe -PathType Leaf)) {
  throw 'Docker Desktop executable not found.'
}
$exe = (Resolve-Path -LiteralPath $exe).Path
Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe) -WindowStyle Hidden
`;

export class ComputerDocker {
  constructor(private readonly root: string) {}

  args = (socket: string, args: string[]) => ["--host", `unix://${socket}`, ...args];

  run = (socket: string, args: string[], options: Partial<ProcessRequest> = {}) =>
    execute({
      timeoutMs: 10000,
      ...options,
      program: "docker",
      args: this.args(socket, args),
      cwd: this.root,
    });

  async command(socket: string, args: string[], options?: Partial<ProcessRequest>) {
    const result = await this.run(socket, args, options);
    if (result.code !== 0) {
      throw new AdeError(
        "docker",
        `Docker ${args[0]} failed: ${(result.stderr || result.stdout).trim().slice(-2000)}`,
      );
    }

    return result.stdout.trim();
  }

  async daemon(saved?: Daemon, signal?: AbortSignal): Promise<Daemon> {
    if (process.platform !== "linux" || !process.getuid?.() || !process.getgid?.()) {
      throw new AdeError(
        "isolation",
        "Shared Computer requires an unprivileged Linux or WSL helper.",
      );
    }

    const socket = await localSocket(saved?.socket);

    const output = await this.command(
      socket,
      ["info", "--format", "{{json .ID}} {{json .OSType}} {{json .SecurityOptions}}"],
      { rawStdoutForIntegrity: true, signal },
    ).catch((error: unknown) => {
      if (
        error instanceof AdeError &&
        (error.kind === "timeout" ||
          (error.kind === "docker" && !/permission denied/i.test(error.message)))
      ) {
        throw new AdeError("docker_offline", error.message);
      }

      throw error;
    });

    const [id, type, ...security] = output.split(" ");

    const info = {
      ID: JSON.parse(id) as string,
      OSType: JSON.parse(type) as string,
      SecurityOptions: JSON.parse(security.join(" ")) as string[] | null,
    };

    if (!info.ID || info.OSType !== "linux") {
      throw new AdeError("docker_unavailable", "Select a local Linux Docker engine.");
    }

    if (info.SecurityOptions?.some((option) => /name=(rootless|userns)(?:,|$)/.test(option))) {
      throw new AdeError(
        "docker_unavailable",
        "Shared Computer needs Docker without UID remapping to keep files private and writable in Linux/WSL.",
      );
    }

    if (saved && saved.daemon_id !== info.ID) {
      throw new AdeError(
        "docker_unavailable",
        "Reconnect the Docker engine that owns this computer.",
      );
    }

    return { socket, daemon_id: info.ID };
  }

  async startDaemon(
    saved: Daemon | undefined,
    signal: AbortSignal,
    onProgress: (message: string) => void,
  ): Promise<Daemon> {
    try {
      return await this.daemon(saved, signal);
    } catch (error) {
      if (!offline(error)) {
        throw error;
      }
    }

    onProgress("Starting Docker…");
    const wsl = Boolean(process.env.WSL_DISTRO_NAME);

    const result = await execute({
      program: wsl ? "powershell.exe" : "systemctl",
      args: wsl
        ? ["-NoProfile", "-NonInteractive", "-Command", launchDesktop]
        : ["--no-ask-password", "--no-block", "start", "docker.service"],
      cwd: this.root,
      signal,
      timeoutMs: 15000,
      wslInterop: wsl,
    });

    if (result.code !== 0) {
      throw new AdeError(
        "docker_offline",
        `Could not start Docker. ${(result.stderr || result.stdout).trim().slice(-1000)}`,
      );
    }

    onProgress(wsl ? "Waiting for Docker in WSL…" : "Waiting for Docker Engine…");
    const timeout = AbortSignal.timeout(90000);
    const waiting = AbortSignal.any([signal, timeout]);
    try {
      while (true) {
        try {
          return await this.daemon(saved, waiting);
        } catch (error) {
          if (!offline(error)) {
            throw error;
          }
        }

        await delay(1000, undefined, { signal: waiting });
      }
    } catch (error) {
      signal.throwIfAborted();
      if (timeout.aborted) {
        throw new AdeError(
          "docker_offline",
          wsl
            ? "Docker Desktop did not become available. Check WSL integration for this distribution."
            : "Docker Engine did not become available. Check the docker.service status.",
        );
      }

      throw error;
    }
  }

  async inspect<T>(
    socket: string,
    kind: "container" | "network" | "volume" | "image",
    name: string,
  ) {
    const result = await this.run(socket, [kind, "inspect", name], { rawStdoutForIntegrity: true });
    if (result.code === 0) {
      return (JSON.parse(result.stdout) as T[])[0];
    }

    const diagnostic = result.stderr.trim();
    const reason = diagnostic.replace(/^Error(?: response from daemon)?: /, "");

    const missing = {
      container: [`No such container: ${name}`, `No such object: ${name}`],
      network: [`No such network: ${name}`, `network ${name} not found`],
      volume: [`No such volume: ${name}`, `get ${name}: no such volume`],
      image: [`No such image: ${name}`],
    };

    if (missing[kind].includes(reason)) {
      return null;
    }

    throw new AdeError("docker", `Cannot inspect computer ${kind}: ${diagnostic.slice(-2000)}`);
  }
}
