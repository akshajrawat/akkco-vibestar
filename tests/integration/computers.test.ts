import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComputerDocker } from "../../apps/core/computers/docker";
import { ComputerActionSchema } from "../../apps/core/computers/contracts";
import { Engine } from "../../apps/core/execution/engine";

let directory: string;
let engine: Engine;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "vibestar-shared-computer-"));
  engine = await Engine.create(join(directory, "data"));
});

afterEach(async () => {
  vi.restoreAllMocks();
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
