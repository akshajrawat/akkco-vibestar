import { it, expect, vi } from "vitest";

import { tmpdir } from "node:os";

import { execute, cleanEnvironment, redact } from "../../apps/core/execution/runtime/process";

const filesystem = vi.hoisted(() => ({ afterRealpath: vi.fn() }));

vi.mock("node:fs/promises", async (original) => {
  const module = await original<typeof import("node:fs/promises")>();
  return {
    ...module,
    realpath: async (path: string) => {
      const resolved = await module.realpath(path);
      filesystem.afterRealpath();
      return resolved;
    },
  };
});

it("passes shell metacharacters literally through argv", async () => {
  const value = 'a ; $(touch /tmp/vibestar-injection)\n "quoted"';

  const output = await execute({
    program: process.execPath,
    args: ["-e", "process.stdout.write(process.argv[1])", value],
    cwd: tmpdir(),
  });

  expect(output.stdout).toBe(value);
});

it("filters credential override environment variables", () => {
  process.env.OPENAI_API_KEY = "test-should-not-inherit";
  process.env.CODEX_API_KEY = "test-should-not-inherit";
  expect(cleanEnvironment()).not.toHaveProperty("OPENAI_API_KEY");
  expect(cleanEnvironment()).not.toHaveProperty("CODEX_API_KEY");
  delete process.env.OPENAI_API_KEY;
  delete process.env.CODEX_API_KEY;
  expect(redact("Authorization: Bearer secret\napi_key=abc cookie: xyz")).not.toContain("secret");
});

it("streams stdout and stderr independently with exit status", async () => {
  const lines: string[] = [];

  const o = await execute({
    program: process.execPath,
    args: ["-e", "console.log('out');console.error('err');process.exitCode=7"],
    cwd: tmpdir(),
    onLine: (stream, line) => lines.push(`${stream}:${line}`),
  });

  expect(o.code).toBe(7);
  expect(lines).toContain("stdout:out");
  expect(lines).toContain("stderr:err");
});

it("cancels process groups without waiting for full timeout", async () => {
  const controller = new AbortController();

  const run = execute({
    program: process.execPath,
    args: ["-e", "console.log('ready');process.stdin.resume()"],
    cwd: tmpdir(),
    signal: controller.signal,
    onLine: () => controller.abort(),
  });

  await expect(run).rejects.toThrow("cancelled");
});

it("preserves UTF-8 split across independent stdout/stderr chunks before redaction", async () => {
  const lines: string[] = [];

  const output = await execute({
    program: process.execPath,
    args: [
      "-e",
      "process.stdout.write(Buffer.from([0xf0,0x9f]));process.stderr.write(Buffer.from([0xe2]));setTimeout(()=>{process.stdout.write(Buffer.from([0x90,0x88,0x0a]));process.stderr.write(Buffer.from([0x9c,0x93,0x0a]));},50)",
    ],
    cwd: tmpdir(),
    onLine: (stream, line) => lines.push(`${stream}:${line}`),
  });

  expect(output.stdout).toBe("🐈\n");
  expect(output.stderr).toBe("✓\n");
  expect(lines).toEqual(expect.arrayContaining(["stdout:🐈", "stderr:✓"]));
});

it("enforces process timeout", async () => {
  const validateExit = vi.fn();

  await expect(
    execute({
      program: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: tmpdir(),
      timeoutMs: 50,
      inputProtocol: { start: () => {}, receive: () => {}, validateExit },
    }),
  ).rejects.toThrow("timeout");

  expect(validateExit).not.toHaveBeenCalled();
});

it.each([
  { deadline: 1000, timeout: undefined },
  { deadline: 2000, timeout: 1000 },
  { deadline: undefined, timeout: 1500 },
])(
  "charges cwd resolution only against an absolute deadline (%j)",
  async ({ deadline, timeout }) => {
    let now = 500;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const timer = vi.spyOn(globalThis, "setTimeout");
    const beforeSpawn = vi.fn();
    filesystem.afterRealpath.mockClear();

    filesystem.afterRealpath.mockImplementation(() => {
      now = 1000;
    });

    try {
      const run = execute({
        program: process.execPath,
        args: ["-e", "process.stdout.write('dispatched')"],
        cwd: tmpdir(),
        deadline,
        timeoutMs: 1500,
        beforeSpawn,
      });

      if (timeout === undefined) {
        await expect(run).rejects.toThrow("deadline expired before provider dispatch");
        expect(beforeSpawn).not.toHaveBeenCalled();
      } else {
        await expect(run).resolves.toMatchObject({ stdout: "dispatched" });
        expect(beforeSpawn).toHaveBeenCalledOnce();
        expect(timer).toHaveBeenCalledWith(expect.any(Function), timeout);
      }

      expect(filesystem.afterRealpath).toHaveBeenCalledOnce();
    } finally {
      filesystem.afterRealpath.mockReset();
      timer.mockRestore();
      clock.mockRestore();
    }
  },
);
