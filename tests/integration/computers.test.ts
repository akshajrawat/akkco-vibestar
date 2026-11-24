import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { Database } from "../../apps/core/storage/database";
import {
  testProfileIds as builtInProfiles,
  createTestProfiles as initializeProfiles,
} from "../helpers/viber-fixtures";
import { Computers } from "../../apps/core/computers/service";
import { computerFiles } from "../../apps/core/computers/files";
import { ComputerActionSchema, ComputerFileSchema } from "../../apps/core/computers/contracts";
import type { Engine } from "../../apps/core/execution/engine";
import type { ProcessRequest } from "../../apps/core/execution/runtime/process";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), pty: vi.fn(), socket: true }));

vi.mock("../../apps/core/execution/runtime/process", async (original) => ({
  ...(await original<object>()),
  execute: mocks.execute,
}));

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    lstat: (path: import("node:fs").PathLike, ...rest: [import("node:fs").StatOptions?]) => {
      if (typeof path === "string" && path.endsWith("docker.sock")) {
        if (mocks.socket) {
          return Promise.resolve({ isSocket: () => true } as unknown as import("node:fs").Stats);
        }

        const error = new Error(`ENOENT: no such file or directory, lstat '${path}'`);
        Object.assign(error, { code: "ENOENT", path });
        return Promise.reject(error);
      }

      return fs.lstat(path, ...rest);
    },
  };
});

vi.mock("node-pty", () => ({ spawn: mocks.pty }));

let root: string;
let db: Database;
let computers: Computers;
let host: ConstructorParameters<typeof Computers>[0];
let requests: ProcessRequest[];
let resources: Map<string, { Labels: Record<string, string> }>;
let containers: Map<
  string,
  { Id: string; Config: { Labels: Record<string, string> }; State: { Running: boolean } }
>;
let onData: (value: string) => void;
let onExit: () => void;

const profile_id = builtInProfiles.implementer;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vibestar-computers-"));
  db = await Database.open(join(root, "state.sqlite"));
  initializeProfiles(db);
  requests = [];
  containers = new Map();
  resources = new Map();
  mocks.socket = true;

  host = {
    root,
    db,
    git: { assertOwnedTask: vi.fn() } as unknown as Engine["git"],
    assertAvailable: vi.fn(),
    publish: vi.fn(),
    trackActivity: vi.fn(() => vi.fn()),
  };

  computers = new Computers(host);

  mocks.pty.mockImplementation(() => ({
    onData: (callback: typeof onData) => {
      onData = callback;
    },
    onExit: (callback: typeof onExit) => {
      onExit = callback;
    },
    kill: vi.fn(() => onExit()),
    write: vi.fn(),
    resize: vi.fn(),
  }));

  mocks.execute.mockImplementation(async (request: ProcessRequest) => {
    requests.push(request);
    const args = request.args.slice(2);

    const output = (stdout = "", code = 0, stderr = "") => ({
      code,
      stdout,
      stderr,
      duration_ms: 1,
    });

    const labels = () =>
      Object.fromEntries(
        args.flatMap((arg, index) =>
          arg === "--label" ? [args[index + 1].split(/=(.*)/s).slice(0, 2)] : [],
        ),
      );

    if (args[0] === "info") {
      return output("linux");
    }

    if (args[0] === "build") {
      return output();
    }

    if (args[0] === "container") {
      const container = containers.get(args.at(-1)!);
      return container
        ? output(JSON.stringify([container]))
        : output("", 1, "Error: No such container");
    }

    if (["volume", "network"].includes(args[0])) {
      const key = args.at(-1)!;
      if (args[1] === "create") {
        resources.set(key, { Labels: labels() });
        return output(key);
      }

      if (args[1] === "rm") {
        resources.delete(key);
        return output();
      }

      const resource = resources.get(key);
      return resource ? output(JSON.stringify([resource])) : output("", 1, `No such ${args[0]}`);
    }

    if (args[0] === "create") {
      const name = args[args.indexOf("--name") + 1];
      containers.set(name, { Id: name, Config: { Labels: labels() }, State: { Running: false } });
      return output(name);
    }

    if (args[0] === "start" || args[0] === "stop") {
      containers.get(args.at(-1)!)!.State.Running = args[0] === "start";
      return output();
    }

    if (args[0] === "rm") {
      containers.delete(args.at(-1)!);
      return output();
    }

    if (args[0] === "ps") {
      return output([...containers.keys()].join("\n"));
    }

    throw new Error(`Unexpected Docker request: ${args.join(" ")}`);
  });
});

afterEach(async () => {
  await computers.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});

it("isolates persistent home volumes across Vibers, restarts safely and resets destructively only with confirmation", async () => {
  expect(await computers.status({ profile_id })).toMatchObject({ status: "stopped" });
  await computers.control({ profile_id }, "start");
  const created = requests.find((r) => r.args.slice(2)[0] === "create")!;

  expect(created.args).toEqual(
    expect.arrayContaining(["--cap-drop", "ALL", "--security-opt", "no-new-privileges=true"]),
  );

  expect(created.args.slice(2).join(" ")).not.toMatch(
    /docker\.sock|\.codex|\.ssh|--privileged|--publish/,
  );

  expect(created.args[created.args.indexOf("--user") + 1]).not.toMatch(/^0:/);
  const home = [...resources.keys()].find((key) => key.endsWith("-home"))!;
  expect(await computers.status({ profile_id })).toMatchObject({ status: "ready" });
  await computers.control({ profile_id: builtInProfiles.reviewer }, "start");

  const sibling = [...resources.keys()].find(
    (key) => key.includes(builtInProfiles.reviewer) && key.endsWith("-home"),
  )!;

  expect(home).not.toBe(sibling);
  await computers.close();
  computers = new Computers(host);
  await computers.recover();
  expect(await computers.status({ profile_id })).toMatchObject({ status: "stopped" });
  await computers.control({ profile_id }, "restart", true);
  expect(resources.has(home)).toBe(true);
  await expect(computers.control({ profile_id }, "reset")).rejects.toThrow("Confirm");
  await computers.control({ profile_id }, "reset", true);
  expect(resources.has(home)).toBe(false);
  expect(resources.has(sibling)).toBe(true);
  await computers.remove({ profile_id: builtInProfiles.reviewer });
  expect(resources.has(sibling)).toBe(false);
});

it("fails closed for missing Docker, foreign ownership and conflicting foreground access", async () => {
  mocks.socket = false;
  await expect(computers.control({ profile_id }, "start")).rejects.toThrow("Docker is unavailable");
  expect(await computers.status({ profile_id })).toMatchObject({ status: "error" });
  mocks.socket = true;
  await computers.control({ profile_id }, "start");
  const release = computers.acquire({ profile_id }, "agent", () => {});
  expect(() => computers.acquire({ profile_id }, "terminal", () => {})).toThrow("in use");

  await expect(computers.control({ profile_id }, "reset", true)).rejects.toThrow(
    "Stop the Viber turn",
  );

  await expect(computers.remove({ profile_id })).rejects.toThrow("Stop the Viber");
  release();
  const container = [...containers.values()][0];
  container.Config.Labels["dev.vibestar.profile"] = builtInProfiles.reviewer;
  await expect(computers.control({ profile_id }, "restart", true)).rejects.toThrow("not owned");
  containers.clear();
});

it("streams a private interactive terminal, checks terminal ownership, and stops descendants on close", async () => {
  await expect(computers.openTerminal({ profile_id }, undefined, "codex")).rejects.toThrow(
    "Confirm",
  );

  const terminal = await computers.openTerminal({ profile_id });
  onData("hello\r\n");
  onData("api_key=sk-fakecredential123456789\r\n");
  onData("\r\n");
  expect(computers.terminalStatus({ profile_id })?.output).toContain("hello");
  expect(computers.terminalStatus({ profile_id })?.output).not.toContain("sk-fakecredential");

  expect(() =>
    computers.terminalInput({ profile_id: builtInProfiles.reviewer }, terminal.id, "id\n"),
  ).toThrow("does not belong");

  computers.terminalInput({ profile_id }, terminal.id, "echo hello\n");
  computers.terminalResize({ profile_id }, terminal.id, 80, 24);
  expect(mocks.pty.mock.results[0].value.write).toHaveBeenCalledWith("echo hello\n");
  await computers.closeTerminal({ profile_id });
  expect(computers.terminalStatus({ profile_id })).toBeNull();
  expect([...containers.values()][0].State.Running).toBe(false);

  expect(() => computers.terminalInput({ profile_id }, terminal.id, "id")).toThrow(
    "does not belong",
  );
});

it("rejects unauthorized sessions and invalid IPC payloads and bounds file previews without following links", async () => {
  await expect(computers.control({ profile_id: randomUUID() }, "start")).rejects.toThrow(
    "active Viber",
  );

  await expect(
    computers.control({ profile_id, session_id: randomUUID() }, "start"),
  ).rejects.toThrow("not found");

  expect(() =>
    ComputerActionSchema.parse({ profile_id, action: "reset", confirmed: false }),
  ).toThrow();

  expect(() =>
    ComputerActionSchema.parse({ profile_id, action: "start", mounts: ["/"] }),
  ).toThrow();

  expect(() =>
    ComputerFileSchema.parse({ profile_id, session_id: randomUUID(), path: "a", root: "/" }),
  ).toThrow();

  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "nested"), { recursive: true });
  await writeFile(join(workspace, "nested", "source.txt"), "saved code");
  await writeFile(join(root, "private.txt"), "host secret");
  await symlink(join(root, "private.txt"), join(workspace, "escape"));

  expect((await computerFiles(workspace, "")).entries).toEqual([
    { name: "nested", directory: true },
  ]);

  expect(await computerFiles(workspace, "nested/source.txt")).toMatchObject({ text: "saved code" });
  await expect(computerFiles(workspace, "escape")).rejects.toThrow();
  await expect(computerFiles(workspace, "../private.txt")).rejects.toThrow("Select");
  await expect(computerFiles(workspace, ".git/config")).rejects.toThrow("Select");
  await writeFile(join(workspace, "large.txt"), Buffer.alloc(1048577));
  await expect(computerFiles(workspace, "large.txt")).rejects.toThrow("1 MiB");
});
