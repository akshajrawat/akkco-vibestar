import { createHash } from "node:crypto";
import { request } from "node:http";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComputerDocker, type ContainerInspection } from "../../apps/core/computers/docker";
import { ComputerActionSchema } from "../../apps/core/computers/contracts";
import {
  computerImage,
  desktopImageTag,
  desktopVersion,
  sharedDirectory,
} from "../../apps/core/computers/image";
import { desktopSeccomp } from "../../apps/core/computers/seccomp";
import { AdeError } from "../../apps/core/domain";
import { Engine } from "../../apps/core/execution/engine";

let directory: string;
let engine: Engine;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "vibestar-shared-computer-"));
  engine = await Engine.create(join(directory, "data"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  try {
    await engine.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const bind = (host = engine) =>
  host.db.run(
    "INSERT INTO shared_computer(singleton,socket,daemon_id,workspace_root) VALUES(1,?,?,?)",
    "/test.sock",
    "test-daemon",
    host.root,
  );

const daemon = { socket: "/test.sock", daemon_id: "test-daemon" };

it.each([
  ["Ubuntu", "powershell.exe", "Start-Process -FilePath $exe -WorkingDirectory"],
  [undefined, "systemctl", "--no-ask-password --no-block start docker.service"],
])(
  "starts the installed Docker engine when the local socket is offline (%s)",
  async (wsl, program, args) => {
    vi.stubEnv("WSL_DISTRO_NAME", wsl);
    vi.stubEnv("PATH", `${directory}:${process.env.PATH}`);

    await writeFile(join(directory, program), '#!/bin/sh\nprintf "%s" "$*" > docker-started\n', {
      mode: 0o700,
    });

    const probe = vi
      .spyOn(ComputerDocker.prototype, "daemon")
      .mockRejectedValueOnce(new AdeError("docker_offline", "engine is offline"))
      .mockImplementation(async () => {
        const launch = await readFile(join(directory, "docker-started"), "utf8");
        expect(launch).toContain(args);
        expect(launch).not.toMatch(/settings(?:-store)?\.json|openUIOnStartupDisabled/);
        return daemon;
      });

    const starting = vi.fn();

    await expect(
      new ComputerDocker(directory).startDaemon(daemon, new AbortController().signal, starting),
    ).resolves.toEqual(daemon);

    expect(starting.mock.calls).toEqual([
      ["Starting Docker…"],
      [wsl ? "Waiting for Docker in WSL…" : "Waiting for Docker Engine…"],
    ]);

    expect(probe.mock.calls.map(([saved]) => saved)).toEqual([daemon, daemon]);
  },
);

it("checks daemon ownership before any automatic launch", async () => {
  const unavailable = new AdeError(
    "docker_unavailable",
    "Reconnect the Docker engine that owns this computer.",
  );

  vi.spyOn(ComputerDocker.prototype, "daemon").mockRejectedValue(unavailable);

  const starting = vi.fn();

  await expect(
    new ComputerDocker(directory).startDaemon(daemon, new AbortController().signal, starting),
  ).rejects.toBe(unavailable);

  expect(starting).not.toHaveBeenCalled();
});

it("requires an explicit confirmation and rejects caller-supplied profiles, mounts and daemons", () => {
  expect(() => ComputerActionSchema.parse({ action: "reset" })).toThrow();
  expect(() => ComputerActionSchema.parse({ action: "start", profile_id: "old" })).toThrow();
  expect(() => ComputerActionSchema.parse({ action: "start", socket: "/elsewhere" })).toThrow();

  expect(ComputerActionSchema.parse({ action: "reset", confirmed: true })).toEqual({
    action: "reset",
    confirmed: true,
  });
});

it("adds the shared table when reopening an existing schema-0 data root", async () => {
  engine.db.run("DROP TABLE shared_computer");
  await engine.close();
  engine = await Engine.create(join(directory, "data"));
  expect(engine.db.all("SELECT singleton FROM shared_computer")).toEqual([]);
  expect(engine.db.all("PRAGMA user_version")).toEqual([{ user_version: 0 }]);
});

it("allows automatic startup to replace a running desktop from the previous image", async () => {
  bind();
  vi.spyOn(ComputerDocker.prototype, "daemon").mockResolvedValue(daemon);

  vi.spyOn(ComputerDocker.prototype, "inspect").mockResolvedValue({
    Config: {
      Labels: {
        "dev.vibestar.shared": createHash("sha256").update(engine.root).digest("hex").slice(0, 24),
        "dev.vibestar.desktop": "1",
      },
    },
    State: { Running: true },
  });

  await expect(engine.computers.status()).resolves.toMatchObject({
    status: "stopped",
    has_data: true,
  });
});

it("serializes lifecycle operations per workspace while status stays readable", async () => {
  let proceed!: () => void;

  const wait = new Promise<void>((resolve) => {
    proceed = resolve;
  });

  vi.spyOn(ComputerDocker.prototype, "daemon").mockImplementation(async () => {
    await wait;
    return daemon;
  });

  const other = await Engine.create(join(directory, "other"));
  try {
    const first = engine.computers.control("stop");
    expect(await engine.computers.status()).toMatchObject({ status: "starting" });
    expect(() => engine.computers.control("reset")).toThrow("current Shared Computer operation");
    const second = other.computers.control("stop");
    proceed();
    await expect(first).resolves.toMatchObject({ status: "stopped" });
    await expect(second).resolves.toMatchObject({ status: "stopped" });
  } finally {
    proceed();
    await other.close();
  }
});

it("keeps incomplete reset retryable and refuses to start with partial cleanup", async () => {
  bind();
  vi.spyOn(ComputerDocker.prototype, "daemon").mockResolvedValue(daemon);

  vi.spyOn(ComputerDocker.prototype, "inspect")
    .mockRejectedValueOnce(new Error("daemon restarting"))
    .mockResolvedValue(null);

  const command = vi.spyOn(ComputerDocker.prototype, "command");

  expect(await engine.computers.control("reset")).toMatchObject({
    status: "error",
    error: "daemon restarting",
  });

  expect(engine.db.all("SELECT reset_pending FROM shared_computer")).toEqual([
    { reset_pending: 1 },
  ]);

  expect(await engine.computers.control("start")).toMatchObject({
    status: "error",
    error: expect.stringContaining("Reset is incomplete"),
  });

  expect(await engine.computers.control("reset")).toMatchObject({
    status: "stopped",
    has_data: false,
  });

  expect(engine.db.all("SELECT reset_pending FROM shared_computer")).toEqual([]);
  expect(command).not.toHaveBeenCalled();
});

it("never resets resources from a copied workspace or unexpectedly changed Docker daemon", async () => {
  bind();

  const lookup = vi
    .spyOn(ComputerDocker.prototype, "daemon")
    .mockRejectedValue(new Error("owning daemon is unavailable"));

  const inspect = vi.spyOn(ComputerDocker.prototype, "inspect");

  expect(await engine.computers.control("reset")).toMatchObject({
    status: "error",
    error: "owning daemon is unavailable",
  });

  expect(lookup).toHaveBeenCalledWith(expect.objectContaining(daemon));
  engine.db.run("UPDATE shared_computer SET workspace_root=?", join(directory, "original"));

  expect(await engine.computers.control("reset")).toMatchObject({
    status: "error",
    error: expect.stringContaining("original Vibestar data root"),
  });

  expect(inspect).not.toHaveBeenCalled();
});

it("retries Reset after container removal and keeps the checkpoint until the volume and network are gone", async () => {
  bind();
  vi.spyOn(ComputerDocker.prototype, "daemon").mockResolvedValue(daemon);

  const labels = {
    "dev.vibestar.shared": createHash("sha256").update(engine.root).digest("hex").slice(0, 24),
  };

  let container = true;
  let volumeFailure = true;

  const inspected = vi
    .spyOn(ComputerDocker.prototype, "inspect")
    .mockImplementation(async (_socket, kind) => {
      if (kind === "container") {
        return container
          ? { Id: "container-id", Config: { Labels: labels }, State: { Running: false } }
          : null;
      }

      return { Labels: labels };
    });

  const command = vi
    .spyOn(ComputerDocker.prototype, "command")
    .mockImplementation(async (_socket, args) => {
      if (args[0] === "container") {
        container = false;
      }

      if (args[0] === "volume" && volumeFailure) {
        throw new Error("volume is busy");
      }

      expect(engine.db.all("SELECT reset_pending FROM shared_computer")).toEqual([
        { reset_pending: 1 },
      ]);

      return "";
    });

  expect(await engine.computers.control("reset")).toMatchObject({
    status: "error",
    error: "volume is busy",
    reset_pending: true,
  });

  expect(await engine.computers.status()).toMatchObject({ status: "error", reset_pending: true });
  expect(container).toBe(false);

  expect(command.mock.calls.map(([, args]) => args.slice(0, 2))).toEqual([
    ["container", "rm"],
    ["volume", "rm"],
  ]);

  volumeFailure = false;
  command.mockClear();

  expect(await engine.computers.control("reset")).toMatchObject({
    status: "stopped",
    has_data: false,
  });

  expect(inspected.mock.calls.filter(([, kind]) => kind === "container")).toHaveLength(2);

  expect(command.mock.calls.map(([, args]) => args.slice(0, 2))).toEqual([
    ["volume", "rm"],
    ["network", "rm"],
  ]);

  expect(engine.db.all("SELECT reset_pending FROM shared_computer")).toEqual([]);
});

it("requires a successful guest write probe for the current boot and shared directory", async () => {
  bind();
  const root = join(engine.root, "shared-computer");
  const source = join(root, "files");
  await mkdir(root, { mode: 0o700 });
  await mkdir(source, { mode: 0o700 });
  const info = await lstat(source, { bigint: true });
  const owner = createHash("sha256").update(engine.root).digest("hex").slice(0, 24);
  const name = `vibestar-shared-${owner}`;

  const container: ContainerInspection = {
    Id: "desktop-id",
    State: { Running: true, StartedAt: "first-boot", Health: { Status: "healthy" } },
    Config: {
      Labels: {
        "dev.vibestar.shared": owner,
        "dev.vibestar.desktop": desktopVersion,
        "dev.vibestar.files": `${info.dev}:${info.ino}`,
      },
      User: `${process.getuid?.()}:${process.getgid?.()}`,
      Image: desktopImageTag(process.getuid!(), process.getgid!()),
    },
    HostConfig: {
      NetworkMode: `${name}-net`,
      PortBindings: {},
      Privileged: false,
      SecurityOpt: ["no-new-privileges", `seccomp=${desktopSeccomp}`],
      CapDrop: ["ALL"],
      CapAdd: null,
      ReadonlyRootfs: true,
      Mounts: [{ Target: sharedDirectory, BindOptions: { NonRecursive: true } }],
    },
    Mounts: [
      {
        Type: "volume",
        Name: `${name}-home`,
        Source: "/docker/home",
        Destination: "/home/viber",
        RW: true,
      },
      { Type: "bind", Source: source, Destination: sharedDirectory, RW: true },
    ],
  };

  vi.spyOn(ComputerDocker.prototype, "daemon").mockResolvedValue(daemon);

  vi.spyOn(ComputerDocker.prototype, "inspect").mockImplementation(async () =>
    structuredClone(container),
  );

  const probe = vi.spyOn(ComputerDocker.prototype, "command");
  let writable = false;
  let stopDuringCleanup = false;

  const unusedImage = `sha256:${"a".repeat(64)}`;

  probe.mockImplementation(async (_socket, args) => {
    if (args[0] === "image") {
      if (args[1] === "ls") {
        expect(args).toContain("dangling=true");

        expect(args).toContain(
          `label=dev.vibestar.desktop-image=${process.getuid!()}-${process.getgid!()}`,
        );

        return `${unusedImage}\nunrelated:latest`;
      }

      expect(args).toEqual(["image", "rm", unusedImage]);
      if (stopDuringCleanup) {
        container.State.Running = false;
      }

      return "";
    }

    expect(args).toEqual(
      expect.arrayContaining(["exec", "desktop-id", "verify-bind", sharedDirectory]),
    );

    if (!writable) {
      throw new Error("guest cannot write");
    }

    return args.at(-1)!.replace(".vibestar-", "");
  });

  const turn = vi.fn(async () => "response");
  const withTurn = () => engine.computers.withTurn(true, new AbortController().signal, turn);
  expect((await engine.computers.status()).status).not.toBe("ready");
  await expect(withTurn()).rejects.toThrow("unavailable");

  expect(await engine.computers.control("start")).toMatchObject({
    status: "error",
    error: "guest cannot write",
  });

  expect(await engine.computers.status()).toMatchObject({
    status: "error",
    error: "guest cannot write",
  });

  await expect(withTurn()).rejects.toThrow("unavailable");
  expect(turn).not.toHaveBeenCalled();

  writable = true;
  stopDuringCleanup = true;
  expect(await engine.computers.control("start")).toMatchObject({ status: "error" });
  stopDuringCleanup = false;
  container.State.Running = true;
  expect(await engine.computers.control("start")).toMatchObject({ status: "ready" });
  expect((await engine.computers.status()).status).toBe("ready");
  await expect(withTurn()).resolves.toBe("response");

  container.State.Health = { Status: "unhealthy" };
  const originalProbe = probe.getMockImplementation()!;

  probe.mockImplementation(async (socket, args) => {
    if (args[0] === "stop") {
      container.State.Running = false;
      return "";
    }

    if (args[0] === "start") {
      container.State = { Running: true, StartedAt: "recovered", Health: { Status: "healthy" } };
      return "";
    }

    return originalProbe(socket, args);
  });

  const previousCalls = probe.mock.calls.length;
  expect((await engine.computers.status()).status).toBe("error");
  expect(await engine.computers.control("start")).toMatchObject({ status: "ready" });

  expect(probe.mock.calls.slice(previousCalls).map(([, [command]]) => command)).toEqual([
    "stop",
    "start",
    "image",
    "image",
    "exec",
  ]);

  await engine.computers.withTurn(false, new AbortController().signal, async ({ socket }) => {
    container.State.StartedAt = "second-boot";

    const status = await new Promise<number | undefined>((resolve, reject) => {
      const client = request(
        { socketPath: socket, method: "POST", path: "/exec", headers: { host: "computer" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );

      client.once("error", reject);
      client.end("printf stale");
    });

    expect(status).toBe(503);
  });

  await expect(withTurn()).rejects.toThrow("unavailable");
  expect((await engine.computers.status()).status).not.toBe("ready");
  expect(await engine.computers.control("start")).toMatchObject({ status: "ready" });

  await rename(source, join(root, "previous-files"));
  await mkdir(source, { mode: 0o700 });
  expect((await engine.computers.status()).status).not.toBe("ready");
  await expect(withTurn()).rejects.toThrow("unavailable");
  expect(turn).toHaveBeenCalledOnce();
});

it("retries an unconfirmed mouse release before transferring control of the same boot", async () => {
  const target = { ...daemon, id: "desktop", startedAt: "boot" };
  const docker = new ComputerDocker(engine.root);

  const inspect = vi
    .spyOn(docker, "inspect")
    .mockResolvedValue({ State: { Running: true, StartedAt: "boot" } });

  const command = vi
    .spyOn(docker, "command")
    .mockResolvedValueOnce("")
    .mockRejectedValueOnce(new Error("exec connection lost"))
    .mockRejectedValueOnce(new Error("still disconnected"))
    .mockResolvedValue("");

  const desktop = new (await import("../../apps/core/computers/desktop")).ComputerDesktop(
    docker,
    async () => target,
  );

  await desktop.acquire("first");
  await desktop.input("first", { type: "pointer", phase: "down", x: 10, y: 20, button: 3 });
  await expect(desktop.close("first")).rejects.toThrow("release the mouse");
  await expect(desktop.acquire("second")).rejects.toThrow("release the mouse");
  await expect(desktop.acquire("second")).resolves.toBeUndefined();

  expect(command.mock.calls.slice(1).map(([, args]) => args)).toEqual(
    Array.from({ length: 3 }, () => ["exec", target.id, "xdotool", "mouseup", "3"]),
  );

  expect(inspect).toHaveBeenCalledTimes(3);
  await desktop.close();
});

it("ships a sandboxed Chromium launcher and guest workspace launchers", () => {
  const image = computerImage(1000, 1000);
  expect(image).toContain("chromium --disable-dev-shm-usage");
  expect(image).toContain("--remote-debugging-address=127.0.0.1");
  expect(image).not.toContain("--no-sandbox");
  expect(image).toContain('label="Chromium"');
  expect(image).toContain(`cd ${sharedDirectory} &amp;&amp; exec xterm`);
  expect(image).toContain(`thunar ${sharedDirectory}`);
});
