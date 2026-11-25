import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { AdeError } from "../domain";
import type { Engine } from "../execution/engine";
import { redact } from "../execution/runtime/process";
import { ComputerDocker, type ContainerInspection, type Daemon } from "./docker";
import { computerImage, desktopVersion, sharedDirectory } from "./image";
import { ComputerDesktop } from "./desktop";
import { openComputerServices } from "./services";
import type { ComputerStatus } from "./contracts";

type Binding = Daemon & { reset_pending: number; workspace_root: string };

type Action = "start" | "stop" | "restart" | "reset";

type Running = { socket: string; id: string };

export class Computers {
  private readonly docker: ComputerDocker;

  private readonly owner: string;

  private readonly name: string;

  private readonly home: string;

  private readonly network: string;

  private readonly filesRoot: string;

  readonly desktop: ComputerDesktop;

  private readonly shutdown = new AbortController();

  private operation?: Promise<ComputerStatus>;

  private clients = 0;

  private readonly turns = new Set<Promise<unknown>>();

  private revision = 0;

  private starting: ComputerStatus = {
    status: "starting",
    error: null,
    docker: null,
    has_data: false,
  };

  constructor(
    private readonly engine: Pick<
      Engine,
      "root" | "db" | "publish" | "assertAvailable" | "trackActivity"
    >,
  ) {
    this.docker = new ComputerDocker(engine.root);
    this.owner = createHash("sha256").update(engine.root).digest("hex").slice(0, 24);
    this.name = `vibestar-shared-${this.owner}`;
    this.home = `${this.name}-home`;
    this.network = `${this.name}-net`;
    this.filesRoot = join(engine.root, "shared-computer", "files");
    this.desktop = new ComputerDesktop(this.docker, this.running);
  }

  private binding = () =>
    this.engine.db.all<Binding>(
      "SELECT socket,daemon_id,workspace_root,reset_pending FROM shared_computer WHERE singleton=1",
    )[0];

  private daemon = (saved?: Binding) => {
    if (saved && saved.workspace_root !== this.engine.root) {
      throw new AdeError(
        "ownership",
        "Open the original Vibestar data root to manage this Shared Computer.",
      );
    }

    return this.docker.daemon(saved);
  };

  private owned = (labels?: Record<string, string>) =>
    labels?.["dev.vibestar.shared"] === this.owner;

  private label = () => `dev.vibestar.shared=${this.owner}`;

  private inspect = async (socket: string) => {
    const container = await this.docker.inspect<ContainerInspection>(
      socket,
      "container",
      this.name,
    );

    if (container && !this.owned(container.Config.Labels)) {
      throw new AdeError("ownership", "The Docker container name is already in use.");
    }

    return container;
  };

  private resource = async (socket: string, kind: "volume" | "network", name: string) => {
    const result = await this.docker.inspect<{ Labels: Record<string, string> }>(
      socket,
      kind,
      name,
    );

    if (result && !this.owned(result.Labels)) {
      throw new AdeError("ownership", `The Docker ${kind} name is already in use.`);
    }

    return result;
  };

  private checkedFiles = async (create = false) => {
    for (const path of [join(this.engine.root, "shared-computer"), this.filesRoot]) {
      if (create) {
        await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") {
            throw error;
          }
        });
      }

      const entry = await lstat(path);
      if (
        !entry.isDirectory() ||
        entry.uid !== process.getuid?.() ||
        entry.mode & 0o077 ||
        (await realpath(path)) !== path ||
        path.includes(",")
      ) {
        throw new AdeError(
          "isolation",
          "Shared Computer files need a private physical directory in the Vibestar data root.",
        );
      }
    }

    return this.filesRoot;
  };

  private filesIdentity = async () => {
    const entry = await lstat(await this.checkedFiles(), { bigint: true });
    return `${entry.dev}:${entry.ino}`;
  };

  private matches = (container: ContainerInspection, identity: string) => {
    const mounts = container.Mounts;

    const guestPath = (source: string) =>
      source === this.filesRoot ||
      (Boolean(process.env.WSL_DISTRO_NAME) &&
        container.Config.Labels["desktop.docker.io/wsl-distro"] === process.env.WSL_DISTRO_NAME &&
        source.startsWith(
          `/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/${process.env.WSL_DISTRO_NAME}/`,
        ) &&
        /^[a-f0-9]{64}$/.test(source.split("/").at(-1) || ""));

    return (
      container.Config.Labels["dev.vibestar.desktop"] === desktopVersion &&
      container.Config.User === `${process.getuid?.()}:${process.getgid?.()}` &&
      container.Config.Labels["dev.vibestar.files"] === identity &&
      container.HostConfig.NetworkMode === this.network &&
      !container.HostConfig.Privileged &&
      container.HostConfig.CapDrop?.includes("ALL") &&
      !container.HostConfig.CapAdd?.length &&
      container.HostConfig.SecurityOpt?.includes("no-new-privileges") &&
      container.HostConfig.ReadonlyRootfs &&
      !Object.keys(container.HostConfig.PortBindings ?? {}).length &&
      container.HostConfig.Mounts?.some(
        (mount) => mount.Target === sharedDirectory && mount.BindOptions?.NonRecursive,
      ) &&
      mounts.length === 2 &&
      mounts.some(
        (m) =>
          m.Type === "volume" && m.Name === this.home && m.Destination === "/home/viber" && m.RW,
      ) &&
      mounts.some(
        (m) =>
          m.Type === "bind" && guestPath(m.Source) && m.Destination === sharedDirectory && m.RW,
      )
    );
  };

  private publish = (status: ComputerStatus) => {
    this.engine.publish({ event: "computer.changed", data: status });
    return status;
  };

  status = async (): Promise<ComputerStatus> => {
    if (this.operation) {
      return this.starting;
    }

    const revision = this.revision;
    const saved = this.binding();

    const result: ComputerStatus = {
      status: "stopped",
      error: null,
      docker: null,
      has_data: Boolean(saved),
    };

    try {
      const { socket } = await this.daemon(saved);
      result.docker = { ready: true, detail: "Linux Docker engine connected" };
      if (saved?.reset_pending) {
        throw new AdeError(
          "reset_pending",
          "Reset is incomplete. Confirm Reset again to finish cleanup.",
        );
      }

      if (saved) {
        const current = await this.inspect(socket);
        // Let automatic startup replace the old container while reusing its files and home volume.
        if (current?.State.Running && current.Config.Labels["dev.vibestar.desktop"] !== "1") {
          if (
            !this.matches(current, await this.filesIdentity()) ||
            current.State.Health?.Status !== "healthy"
          ) {
            throw new AdeError(
              "desktop_unavailable",
              "The desktop is unavailable. Restart the shared computer.",
            );
          }

          result.status = "ready";
        }
      }
    } catch (error) {
      const detail = redact(error instanceof Error ? error.message : String(error));
      result.status = "error";
      result.error = detail;
      result.docker ??= { ready: false, detail };
    }

    return revision === this.revision ? result : this.status();
  };

  private ensure = async (socket: string) => {
    const source = await this.checkedFiles(true);
    const identity = await this.filesIdentity();
    const signal = this.shutdown.signal;
    const options = { signal };
    const image = `vibestar-shared:desktop-${desktopVersion}-${process.getuid?.()}-${process.getgid?.()}`;
    let container = await this.inspect(socket);

    if (!container || !this.matches(container, identity)) {
      if (!(await this.docker.inspect(socket, "image", image))) {
        await this.docker.command(socket, ["build", "--tag", image, "-"], {
          input: computerImage(process.getuid!(), process.getgid!()),
          signal,
          timeoutMs: 900000,
        });
      }

      if (container) {
        await this.stop(socket, container);
        await this.docker.command(socket, ["container", "rm", container.Id], options);
      }

      if (!(await this.resource(socket, "volume", this.home))) {
        await this.docker.command(
          socket,
          ["volume", "create", "--label", this.label(), this.home],
          options,
        );
      }

      if (!(await this.resource(socket, "network", this.network))) {
        await this.docker.command(
          socket,
          [
            "network",
            "create",
            "--label",
            this.label(),
            "--driver",
            "bridge",
            "--opt",
            "com.docker.network.bridge.enable_icc=false",
            this.network,
          ],
          options,
        );
      }

      await this.docker.command(
        socket,
        [
          "create",
          "--name",
          this.name,
          "--label",
          this.label(),
          "--label",
          `dev.vibestar.desktop=${desktopVersion}`,
          "--label",
          `dev.vibestar.files=${identity}`,
          "--network",
          this.network,
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--read-only",
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,size=512m",
          "--shm-size",
          "256m",
          "--mount",
          `type=volume,source=${this.home},target=/home/viber`,
          "--mount",
          `type=bind,source=${source},target=${sharedDirectory},bind-recursive=disabled`,
          "--health-cmd",
          "xdpyinfo >/dev/null && pgrep -x openbox >/dev/null",
          "--health-interval",
          "1s",
          "--health-timeout",
          "2s",
          "--health-retries",
          "10",
          image,
        ],
        options,
      );

      container = await this.inspect(socket);
    }

    if (!container || !this.matches(container, identity)) {
      throw new AdeError(
        "isolation",
        "Docker did not attach the expected Shared Computer storage.",
      );
    }

    if (!container.State.Running) {
      await this.docker.command(socket, ["start", container.Id], options);
    }

    for (let attempt = 0; attempt < 40; attempt++) {
      const state = (await this.inspect(socket))?.State;
      if (!state?.Running || state.Health?.Status === "unhealthy") {
        break;
      }

      if (state.Health?.Status === "healthy") {
        // Docker Desktop rewrites Linux bind sources. Confirm the guest sees this particular directory.
        const nonce = randomUUID();
        const probe = `.vibestar-${nonce}`;
        await writeFile(join(source, probe), nonce, { flag: "wx", mode: 0o600 });
        try {
          const observed = await this.docker.command(
            socket,
            [
              "exec",
              container.Id,
              "sh",
              "-c",
              'test -w "$1" && cat "$1/$2"',
              "verify-bind",
              sharedDirectory,
              probe,
            ],
            options,
          );

          if (observed !== nonce) {
            throw new AdeError("isolation", "Docker could not access the managed workspace files.");
          }
        } finally {
          await rm(join(source, probe), { force: true });
        }

        return;
      }

      await delay(500, undefined, { signal });
    }

    throw new AdeError("desktop_unavailable", "The Linux desktop did not become ready.");
  };

  private stop = async (socket: string, container: ContainerInspection | null) => {
    if (container?.State.Running) {
      await this.docker.command(socket, ["stop", "--time", "10", container.Id], {
        timeoutMs: 16000,
      });
    }
  };

  private reset = async (socket: string) => {
    const container = await this.inspect(socket);
    await this.stop(socket, container);
    if (container) {
      await this.docker.command(socket, ["container", "rm", container.Id]);
    }

    for (const [kind, name] of [
      ["volume", this.home],
      ["network", this.network],
    ] as const) {
      if (await this.resource(socket, kind, name)) {
        await this.docker.command(socket, [kind, "rm", name]);
      }
    }

    const files = await this.checkedFiles().catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return null;
      }

      throw error;
    });

    if (files) {
      await rm(files, { recursive: true });
    }

    this.engine.db.run("DELETE FROM shared_computer WHERE singleton=1");
  };

  control = (action: Action) => {
    this.engine.assertAvailable();
    if (this.operation || this.clients) {
      throw new AdeError(
        "busy",
        "Wait for the current Shared Computer operation or opted-in Viber turn.",
      );
    }

    const saved = this.binding();

    const release = this.engine.trackActivity(
      {
        id: "shared-computer",
        kind: "terminal",
        label: "Shared Computer is changing state",
        stoppable: false,
      },
      () => Promise.resolve(),
    );

    this.revision++;
    this.starting = { status: "starting", error: null, docker: null, has_data: Boolean(saved) };

    this.operation = this.change(action, saved).finally(() => {
      this.operation = undefined;
      this.revision++;
      release();
    });

    this.publish(this.starting);
    return this.operation;
  };

  private change = async (action: Action, saved?: Binding) => {
    const next: ComputerStatus = {
      status: "stopped",
      error: null,
      docker: null,
      has_data: Boolean(saved),
    };

    try {
      if (action !== "start") {
        await this.desktop.close().catch(() => undefined);
      }

      const daemon = await this.daemon(saved);
      next.docker = { ready: true, detail: "Linux Docker engine connected" };
      if (saved?.reset_pending && action !== "reset") {
        throw new AdeError(
          "reset_pending",
          "Reset is incomplete. Confirm Reset again to finish cleanup.",
        );
      }

      if (action === "reset") {
        if (saved) {
          this.engine.db.run("UPDATE shared_computer SET reset_pending=1 WHERE singleton=1");
          await this.reset(daemon.socket);
        }

        next.has_data = false;
      } else if (action === "stop") {
        if (saved) {
          await this.stop(daemon.socket, await this.inspect(daemon.socket));
        }
      } else {
        if (action === "restart" && saved) {
          await this.stop(daemon.socket, await this.inspect(daemon.socket));
        }

        this.engine.db.run(
          "INSERT OR IGNORE INTO shared_computer(singleton,socket,daemon_id,workspace_root) VALUES(1,?,?,?)",
          daemon.socket,
          daemon.daemon_id,
          this.engine.root,
        );

        next.has_data = true;
        await this.ensure(daemon.socket);
        next.status = "ready";
      }
    } catch (error) {
      next.status = "error";
      next.error = redact(error instanceof Error ? error.message : String(error));
      next.docker ??= { ready: false, detail: next.error };
    }

    return this.publish(next);
  };

  private running = async (): Promise<Running> => {
    this.shutdown.signal.throwIfAborted();
    const revision = this.revision;
    const saved = this.binding();
    if (this.operation || !saved || saved.reset_pending) {
      throw new AdeError("computer_stopped", "Start Shared Computer first.");
    }

    const { socket } = await this.daemon(saved);
    const target = await this.inspect(socket);

    const valid =
      target?.State.Running &&
      target.State.Health?.Status === "healthy" &&
      this.matches(target, await this.filesIdentity());

    if (!valid || revision !== this.revision || this.shutdown.signal.aborted) {
      throw new AdeError("computer_stopped", "Shared Computer is unavailable. Check its status.");
    }

    return { socket, id: target.Id };
  };

  withTurn = async <T>(
    readOnly: boolean,
    signal: AbortSignal,
    run: (mount: { files: string; socket?: string }) => Promise<T>,
  ) => {
    if (this.operation) {
      throw new AdeError("busy", "Wait for the Shared Computer operation to finish.");
    }

    this.clients++;

    const operation = (async () => {
      const running = await this.running();
      const files = await this.checkedFiles();

      const services = readOnly
        ? undefined
        : await openComputerServices(this.engine.root, this.docker, running, signal);

      try {
        return await run({ files, socket: services?.socket });
      } finally {
        await services?.close();
      }
    })();

    this.turns.add(operation);
    try {
      return await operation;
    } finally {
      this.turns.delete(operation);
      this.clients--;
    }
  };

  close = async () => {
    this.shutdown.abort();

    const closed = await Promise.allSettled([
      this.operation,
      ...this.turns,
      this.desktop.close().catch(() => undefined),
    ]);

    const failure = closed.find((result) => result.status === "rejected");
    if (failure) {
      throw failure.reason;
    }
  };
}
