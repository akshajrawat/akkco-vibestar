import { expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { browserEnvironmentProbe } from "../../backend/execution/verification/browser/probe";
import { BrowserEnvironmentReportSchema } from "../../backend/execution/verification/browser/contracts";
import { verificationSummary } from "../../backend/execution/verification/verification";

const probe = async (
  options: {
    package?: boolean;
    browser?: boolean;
    dns?: boolean;
    socket?: boolean;
    launch?: boolean;
  } = {},
) => {
  let stdout = "";
  let stderr = "";
  let url = "";
  let errorHandler = (error: Error) => {
    throw error;
  };
  const server = {
    listening: false,
    once: (_event: string, callback: typeof errorHandler) => {
      errorHandler = callback;
    },
    listen: (_port: number, _host: string, callback: () => void) => {
      if (options.socket === false)
        errorHandler(new Error("listen EPERM: operation not permitted 127.0.0.1"));
      else {
        server.listening = true;
        callback();
      }
    },
    address: () => ({ port: 12345 }),
    close: (callback: () => void) => {
      server.listening = false;
      callback();
    },
  };
  const playwright = {
    chromium: {
      launch: async () => {
        if (options.launch === false)
          throw new Error("browserType.launch: Executable doesn't exist");
        return {
          close: async () => {},
          newPage: async () => ({
            route: async () => {},
            goto: async (value: string) => {
              url = value;
            },
            title: async () =>
              url.startsWith("file:") ? "Vibestar direct file probe" : "Vibestar HTTP probe",
          }),
        };
      },
    },
  };
  const modules = new Map<string, unknown>([
    [
      "node:fs/promises",
      {
        readdir: async () => [],
        access: async () => {
          if (options.browser === false) throw new Error("ENOENT");
        },
        realpath: async (path: string) => path,
        mkdtemp: async () => "/tmp/probe",
        writeFile: async () => {},
        rm: async () => {},
      },
    ],
    ["node:fs", { constants: { X_OK: 1 } }],
    ["node:path", await import("node:path")],
    ["node:os", { homedir: () => "/fixture-home", tmpdir: () => "/tmp" }],
    [
      "node:dns/promises",
      {
        Resolver: class {
          resolve4 = async () => {
            if (options.dns === false) throw new Error("getaddrinfo EAI_AGAIN registry.npmjs.org");
            return ["127.0.0.1"];
          };
          cancel = () => {};
        },
      },
    ],
    ["node:http", { createServer: () => server }],
    ["node:url", await import("node:url")],
    ["/fixture/playwright-core", playwright],
  ]);
  const require = Object.assign(
    (name: string) => {
      if (!modules.has(name)) throw new Error(`Unexpected probe capability: ${name}`);
      return modules.get(name);
    },
    {
      resolve: (name: string) => {
        if (options.package === false || name !== "playwright-core/package.json")
          throw new Error("MODULE_NOT_FOUND");
        return "/fixture/playwright-core/package.json";
      },
    },
  );
  await runInNewContext(browserEnvironmentProbe, {
    require,
    process: {
      cwd: () => "/owned/task",
      argv: ["node", "isolated"],
      stdout: {
        write: (text: string) => {
          stdout += text;
        },
      },
      stderr: {
        write: (text: string) => {
          stderr += text;
        },
      },
      exit: () => {
        throw new Error("Probe deadline");
      },
    },
    URL,
    Date,
    setTimeout,
    clearTimeout,
  });
  expect(stderr).toBe("");
  expect(server.listening).toBe(false);
  return BrowserEnvironmentReportSchema.parse(JSON.parse(stdout));
};

it("reuses available browser tooling and verifies direct-file/HTTP fixtures even when registry DNS is blocked", async () => {
  const report = await probe({ dns: false });
  expect(report).toMatchObject({
    dns: { outcome: "blocked" },
    direct_file: { outcome: "available" },
    http: { outcome: "available" },
  });
  expect(report.packages).toHaveLength(1);
  expect(report.note).toContain("does not verify the application");
});

it("keeps direct-file capability independent of denied HTTP sockets", async () => {
  expect(await probe({ socket: false })).toMatchObject({
    socket: { outcome: "blocked" },
    direct_file: { outcome: "available" },
    http: { outcome: "blocked" },
  });
});

it("reports absent packages, binaries and launch failures without any installation capability", async () => {
  expect((await probe({ package: false })).direct_file.outcome).toBe("unavailable");
  expect((await probe({ browser: false })).browsers).toEqual([]);
  expect((await probe({ launch: false })).direct_file).toMatchObject({
    outcome: "blocked",
    detail: expect.stringContaining("Executable doesn't exist"),
  });
});

it("never promotes required or optional application checks based on a successful environment probe", () => {
  const checks = [true, false].map((required) => ({
    name: "Application browser assertion",
    command: "npx playwright test",
    kind: "check",
    outcome: "blocked",
    required,
    detail: "Not executed",
    prerequisite: "Browser",
  }));
  const result = verificationSummary({ verification: checks }, [
    {
      id: "probe",
      command: JSON.stringify(["node", "-e", browserEnvironmentProbe]),
      status: "passed",
      exit_code: 0,
    },
  ]);
  expect(result).toMatchObject({ outcome: "blocked", canReview: false });
  expect(result.checks.filter((check) => check.outcome === "passed")).toEqual([]);
});
