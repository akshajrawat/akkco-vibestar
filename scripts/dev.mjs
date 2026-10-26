import { resolveDevHost } from "./dev-host.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import "./build.mjs";

const host = await resolveDevHost();

const vite = spawn(
  process.execPath,
  [
    fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url)),
    "--host",
    "127.0.0.1",
    "--port",
    "1420",
    "--strictPort",
  ],
  { stdio: ["inherit", "pipe", "inherit"], shell: false },
);

vite.stdout.pipe(process.stdout);

await new Promise((resolve, reject) => {
  vite.stdout.on("data", (data) => {
    if (data.toString().includes("localhost:1420") || data.toString().includes("127.0.0.1:1420"))
      resolve();
  });

  vite.on("exit", (code) => reject(new Error(`Vite exited ${code}`)));
});

let electron;
let stopping = false;
let restarting = false;
let rebuildAgain = false;
let timer;
const watchers = new AbortController();

const quitDesktop = async () => {
  if (!electron || electron.exitCode !== null || electron.signalCode !== null) return;
  if (host.close) await host.close();
  else if (electron && !electron.stdin.destroyed && !electron.stdin.writableEnded)
    electron.stdin.end("vibestar:quit\n");
};

const stop = () => {
  if (stopping) return;
  stopping = true;
  watchers.abort();
  clearTimeout(timer);
  if (electron) void quitDesktop().catch((error) => process.stderr.write(`${error}\n`));
  vite.kill();
};

const launch = async () => {
  await host.clear?.();

  electron = spawn(host.executable, [...host.args, ...process.argv.slice(2)], {
    stdio: ["pipe", "inherit", "inherit"],
    env: host.env,
    shell: false,
  });

  electron.once("error", (error) => {
    process.stderr.write(`${error}\n`);
    stop();
  });

  electron.stdin.on("error", (error) => {
    if (!stopping && !restarting) process.stderr.write(`${error}\n`);
  });

  electron.once("exit", () => {
    if (!restarting) stop();
  });
};

const rebuild = async () => {
  if (stopping) return;
  if (restarting) {
    rebuildAgain = true;
    return;
  }

  restarting = true;
  try {
    do {
      rebuildAgain = false;
      await import(`./build.mjs?reload=${Date.now()}`);
    } while (rebuildAgain && !stopping);

    if (stopping) return;
    process.stdout.write("\nExecution core / desktop changed. Restarting Electron…\n");
    const exited = once(electron, "exit");
    await quitDesktop();
    await exited;
    if (!stopping) await launch();
  } catch (error) {
    process.stderr.write(`Desktop rebuild failed: ${error}\n`);
  } finally {
    restarting = false;
    if (rebuildAgain && !stopping) void rebuild();
  }
};

await launch();
for (const directory of ["electron", "backend"]) {
  void (async () => {
    try {
      for await (const event of watch(directory, {
        recursive: true,
        signal: watchers.signal,
      })) {
        if (!event.filename?.endsWith(".ts")) continue;
        clearTimeout(timer);
        timer = setTimeout(() => void rebuild(), 300);
      }
    } catch (error) {
      if (!watchers.signal.aborted) process.stderr.write(`${error}\n`);
    }
  })();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await once(vite, "exit");
