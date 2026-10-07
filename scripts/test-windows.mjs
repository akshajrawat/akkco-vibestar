import { resolveDevHost } from "./dev-host.mjs";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const host = await resolveDevHost();
if (!host.executable.endsWith(".exe"))
  throw new Error(
    "This check requires native Windows Electron launched from WSL.",
  );
const cache = resolve(dirname(host.executable), "..", "window-check");
await cp(
  "node_modules/playwright-core",
  join(cache, "node_modules/playwright-core"),
  { recursive: true },
);
await cp("tests/windows-window.mjs", join(cache, "check.mjs"));
const home = await mkdtemp(join(tmpdir(), "vibestar-windows-"));
const winpath = async (path) =>
  (await exec("wslpath", ["-w", path])).stdout.trim();
const child = spawn(
  host.executable,
  [
    await winpath(join(cache, "check.mjs")),
    await winpath(host.executable),
    host.args[0],
    await winpath(join(home, "profile")),
    home,
  ],
  {
    stdio: "inherit",
    env: {
      ...host.env,
      ELECTRON_RUN_AS_NODE: "1",
      WSLENV: `${host.env.WSLENV}:ELECTRON_RUN_AS_NODE`,
    },
  },
);
child.on("error", (error) => {
  throw error;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
