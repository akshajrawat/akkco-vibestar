import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { AdeError } from "../domain";
import type { Engine } from "../execution/engine";
import { redact } from "../execution/runtime/process";
import { ComputerDocker, type ContainerInspection, type Daemon } from "./docker";
import {
  computerImage,
  desktopImageLabel,
  desktopImageTag,
  desktopVersion,
  sharedDirectory,
} from "./image";
import { ComputerDesktop } from "./desktop";
import { desktopSeccomp } from "./seccomp";
import { openComputerServices } from "./services";
import type { ComputerStatus } from "./contracts";

type Binding = Daemon & { reset_pending: number; workspace_root: string };

type Action = "start" | "stop" | "restart" | "reset";

type Running = { socket: string; id: string; startedAt: string; filesIdentity: string };

export class Computers {
  private readonly docker: ComputerDocker;

  private readonly owner: string;

  private readonly name: string;

  private readonly home: string;

  private readonly network: string;

  private readonly filesRoot: string;

  private readonly image = desktopImageTag(process.getuid!(), process.getgid!());

  readonly desktop: ComputerDesktop;

  private readonly shutdown = new AbortController();

  private operation?: Promise<ComputerStatus>;

  private clients = 0;

  private readonly turns = new Set<Promise<unknown>>();

  private revision = 0;

  private startError?: string;

  private verified?: { id: string; startedAt: string; identity: string };

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

  private daemon = (saved?: Binding, start = false) => {
    if (saved && saved.workspace_root !== this.engine.root) {
      throw new AdeError(
        "ownership",
        "Open the original Vibestar data root to manage this Shared Computer.",
      );
    }

    return start
      ? this.docker.startDaemon(saved, this.shutdown.signal, this.reportStartup)
      : this.docker.daemon(saved);
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
      container.Config.Image === this.image &&
      container.Config.User === `${process.getuid?.()}:${process.getgid?.()}` &&
      container.Config.Labels["dev.vibestar.files"] === identity &&
      container.HostConfig.NetworkMode === this.network &&
      !container.HostConfig.Privileged &&
      container.HostConfig.CapDrop?.includes("ALL") &&
      !container.HostConfig.CapAdd?.length &&
      container.HostConfig.SecurityOpt?.length === 2 &&
      container.HostConfig.SecurityOpt.includes("no-new-privileges") &&
      container.HostConfig.SecurityOpt.includes(`seccomp=${desktopSeccomp}`) &&
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

  private isReady = async (container: ContainerInspection | null, revision: number) => {
    const verified = this.verified;

    const identity = container?.State.Running
      ? await this.filesIdentity().catch(() => undefined)
      : undefined;

    const valid =
      identity !== undefined &&
      container?.State.Health?.Status === "healthy" &&
      this.matches(container, identity) &&
      verified?.id === container.Id &&
      verified.startedAt === container.State.StartedAt &&
      verified.identity === identity;

    if (!valid && revision === this.revision && this.verified === verified) {
      this.verified = undefined;
    }

    return valid ? identity : undefined;
  };

  private publish = (status: ComputerStatus) => {
    this.engine.publish({ event: "computer.changed", data: status });
    return status;
  };

  private reportStartup = (progress: string) => {
    this.starting = this.publish({ ...this.starting, progress });
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

    if (saved?.reset_pending) {
      result.reset_pending = true;
    }

    try {
      if (saved?.reset_pending) {
        throw new AdeError(
          "reset_pending",
          "Reset is incomplete. Confirm Reset again to finish cleanup.",
        );
      }

      const { socket } = await this.daemon(saved);
      result.docker = { ready: true, detail: "Linux Docker engine connected" };
      if (this.startError) {
        throw new AdeError("desktop_unavailable", this.startError);
      }

      if (saved) {
        const current = await this.inspect(socket);
        // Startup upgrades older images and revalidates a desktop after the helper restarts.
        if (
          current?.State.Running &&
          current.Config.Labels["dev.vibestar.desktop"] === desktopVersion
        ) {
          const wasVerified = Boolean(this.verified);
          if (await this.isReady(current, revision)) {
            result.status = "ready";
          } else if (wasVerified || current.State.Health?.Status !== "healthy") {
            throw new AdeError(
              "desktop_unavailable",
              "The desktop is unavailable. Restart Shared Computer.",
            );
          }
        } else {
          await this.isReady(null, revision);
        }
      }
    } catch (error) {
      const detail = redact(error instanceof Error ? error.message : String(error));
      if (revision === this.revision) {
        this.verified = undefined;
      }

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
    let container = await this.inspect(socket);
    const needsReplacement = !container || !this.matches(container, identity);
    const legacy = Boolean(container && container.Config.Image !== this.image);

    if (needsReplacement) {
      const image = await this.docker.inspect<{
        Config: { Labels: Record<string, string> | null };
      }>(socket, "image", this.image);

      if (image?.Config.Labels?.["dev.vibestar.desktop"] !== desktopVersion) {
        this.reportStartup("Building the Shared Computer image. This can take a few minutes.");

        await this.docker.command(socket, ["build", "--tag", this.image, "-"], {
          input: computerImage(process.getuid!(), process.getgid!()),
          signal,
          timeoutMs: 900000,
        });
      }
    }

    this.reportStartup("Starting the Shared Computer desktop…");
    if (needsReplacement) {
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

      const profileDir = await mkdtemp(join(tmpdir(), "vibestar-seccomp-"));
      const profilePath = join(profileDir, "profile.json");
      try {
        await writeFile(profilePath, desktopSeccomp, { mode: 0o600 });

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
            "--security-opt",
            `seccomp=${profilePath}`,
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
            "test -f /tmp/vibestar-desktop-ready && xdpyinfo >/dev/null && pgrep -x openbox >/dev/null",
            "--health-interval",
            "1s",
            "--health-timeout",
            "2s",
            "--health-retries",
            "10",
            this.image,
          ],
          options,
        );
      } finally {
        await rm(profileDir, { recursive: true, force: true });
      }

      container = await this.inspect(socket);
    }

    if (!container || !this.matches(container, identity)) {
      throw new AdeError(
        "isolation",
        "Docker did not attach the expected Shared Computer storage.",
      );
    }

    const unhealthy = container.State.Running && container.State.Health?.Status === "unhealthy";
    if (unhealthy) {
      await this.stop(socket, container);
    }

    if (!container.State.Running || unhealthy) {
      await this.docker
        .command(socket, ["start", container.Id], options)
        .catch((error: unknown) => {
          throw new AdeError(
            "desktop_unavailable",
            `Docker could not start Shared Computer with Chromium's sandbox. Check that this Linux or WSL engine permits unprivileged user namespaces. ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }

    for (let attempt = 0; attempt < 40; attempt++) {
      const current = await this.inspect(socket);
      const state = current?.State;
      if (current?.Id !== container.Id || !state?.Running || state.Health?.Status === "unhealthy") {
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
              'set -eC; cat "$1/$2"; : > "$1/$2.write"; rm "$1/$2.write"',
              "verify-bind",
              sharedDirectory,
              probe,
            ],
            options,
          );

          const after = await this.inspect(socket);
          if (
            observed !== nonce ||
            (await this.filesIdentity()) !== identity ||
            after?.Id !== container.Id ||
            !after.State.Running ||
            after.State.StartedAt !== state.StartedAt ||
            after.State.Health?.Status !== "healthy" ||
            !this.matches(after, identity)
          ) {
            throw new AdeError("isolation", "Docker could not access the managed workspace files.");
          }
        } finally {
          await rm(join(source, probe), { force: true });
        }

        this.verified = { id: container.Id, startedAt: state.StartedAt, identity };
        await this.removeUnusedImages(socket, legacy);
        return;
      }

      await delay(500, undefined, { signal });
    }

    throw new AdeError(
      "desktop_unavailable",
      "The Linux desktop could not get Chromium ready. Retry Shared Computer from the sidebar.",
    );
  };

  private removeUnusedImages = async (socket: string, migrateLegacy: boolean) => {
    const ids = `${process.getuid!()}-${process.getgid!()}`;
    const legacy = new RegExp(`^desktop-[0-9]+-${ids}$`);
    const options = { signal: this.shutdown.signal };

    const results = await Promise.allSettled([
      migrateLegacy
        ? this.docker.command(
            socket,
            ["image", "ls", "--format", "{{.Tag}}", "vibestar-shared"],
            options,
          )
        : "",
      this.docker.command(
        socket,
        [
          "image",
          "ls",
          "--no-trunc",
          "--quiet",
          "--filter",
          "dangling=true",
          "--filter",
          `label=${desktopImageLabel}=${ids}`,
        ],
        options,
      ),
    ]);

    const [tags, dangling] = results.map((result) =>
      result.status === "fulfilled" ? result.value.split("\n") : [],
    );

    const unused = [
      ...tags.filter((tag) => legacy.test(tag)).map((tag) => `vibestar-shared:${tag}`),
      ...dangling.filter((id) => /^sha256:[0-9a-f]{64}$/.test(id)),
    ];

    // Non-forced removal lets Docker preserve images referenced by other containers.
    for (const image of unused) {
      await this.docker.command(socket, ["image", "rm", image], options).catch(() => undefined);
    }
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
    this.verified = undefined;
    this.startError = undefined;
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
      await this.desktop.close().catch(() => undefined);

      if (saved?.reset_pending && action !== "reset") {
        throw new AdeError(
          "reset_pending",
          "Reset is incomplete. Confirm Reset again to finish cleanup.",
        );
      }

      const daemon = await this.daemon(saved, action === "start" || action === "restart");
      next.docker = { ready: true, detail: "Linux Docker engine connected" };

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
      if (this.binding()?.reset_pending) {
        next.reset_pending = true;
      }

      next.status = "error";
      next.error = redact(error instanceof Error ? error.message : String(error));
      if (
        (action === "start" || action === "restart") &&
        next.docker?.ready &&
        !next.reset_pending
      ) {
        this.startError = next.error;
      }

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

    const identity = await this.isReady(target, revision);
    if (!target || !identity || revision !== this.revision || this.shutdown.signal.aborted) {
      throw new AdeError("computer_stopped", "Shared Computer is unavailable. Check its status.");
    }

    return {
      socket,
      id: target.Id,
      startedAt: target.State.StartedAt,
      filesIdentity: identity,
    };
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

      const services = readOnly
        ? undefined
        : await openComputerServices(this.engine.root, this.docker, running, signal);

      try {
        if ((await this.filesIdentity()) !== running.filesIdentity) {
          this.verified = undefined;
          throw new AdeError(
            "computer_stopped",
            "Shared Computer files changed. Restart Shared Computer.",
          );
        }

        return await run({ files: this.filesRoot, socket: services?.socket });
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
