import electronPath from "electron";
import { spawn } from "node:child_process";
import { once } from "node:events";
import "./build.mjs";
const vite = spawn(
  process.execPath,
  [process.env.npm_execpath, "run", "dev:ui"],
  { stdio: ["inherit", "pipe", "inherit"], shell: false },
);
vite.stdout.pipe(process.stdout);
await new Promise((resolve, reject) => {
  vite.stdout.on("data", (data) => {
    if (
      data.toString().includes("localhost:1420") ||
      data.toString().includes("127.0.0.1:1420")
    )
      resolve();
  });
  vite.on("exit", (code) => reject(new Error(`Vite exited ${code}`)));
});
const electron = spawn(electronPath, ["."], {
  stdio: "inherit",
  env: { ...process.env, VIBESTAR_DEV_URL: "http://127.0.0.1:1420" },
  shell: false,
});
const stop = () => {
  electron.kill();
  vite.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await once(electron, "exit");
vite.kill();
