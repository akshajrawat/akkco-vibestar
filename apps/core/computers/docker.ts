import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { AdeError } from "../domain";
import { execute, type ProcessRequest } from "../execution/runtime/process";

export interface Daemon {
  socket: string;
  daemon_id: string;
}

export interface ContainerInspection {
  Id: string;
  Config: { Labels: Record<string, string>; User: string };
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
    "docker_unavailable",
    "Start Docker Engine or enable Docker Desktop WSL integration for this distribution.",
  );
};

export class ComputerDocker {
  constructor(private readonly root: string) {}

  args = (socket: string, args: string[]) => ["--host", `unix://${socket}`, ...args];

  private run = (socket: string, args: string[], options: Partial<ProcessRequest> = {}) =>
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

  async daemon(saved?: Daemon): Promise<Daemon> {
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
      { rawStdoutForIntegrity: true },
    );

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
