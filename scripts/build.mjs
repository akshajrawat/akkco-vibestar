import { build } from "esbuild";
import { mkdir, copyFile, readFile, writeFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
await mkdir("dist-core", { recursive: true });
await build({
  entryPoints: ["backend/main.ts"],
  outfile: "dist-core/core.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["better-sqlite3", "node-pty"],
  sourcemap: true,
});
await build({
  entryPoints: ["electron/main.ts"],
  outfile: "dist-electron/main.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["electron"],
  sourcemap: true,
});
await build({
  entryPoints: ["electron/preload.ts"],
  outfile: "dist-electron/preload.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["electron"],
});
const lock = await readFile("backend/package-lock.json");
await copyFile("backend/package.json", "dist-core/package.json");
await copyFile("backend/package-lock.json", "dist-core/package-lock.json");
if (process.platform !== "win32") {
  const digest = createHash("sha256")
    .update(lock)
    .update(process.versions.modules)
    .digest("hex");
  const prior = await readFile("dist-core/.dependencies", "utf8").catch(
    () => "",
  );
  const installed = await stat("dist-core/node_modules/better-sqlite3").then(
    () => true,
    () => false,
  );
  if (prior !== digest || !installed) {
    const { stdout, stderr } = await promisify(execFile)(
      "npm",
      ["ci", "--omit=dev", "--no-audit", "--no-fund"],
      { cwd: "dist-core", maxBuffer: 1024 * 1024 },
    );
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    await writeFile("dist-core/.dependencies", digest);
  }
}
