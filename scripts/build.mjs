import { build } from "esbuild";

import { mkdir, copyFile, cp, readFile, writeFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { join } from "node:path";

await mkdir("out/core", { recursive: true });
await mkdir("out/electron", { recursive: true });

await build({
  entryPoints: ["apps/core/main.ts"],
  outfile: "out/core/core.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["better-sqlite3", "node-pty"],
  sourcemap: true,
});

await build({
  entryPoints: ["apps/electron/main.ts"],
  outfile: "out/electron/main.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["electron"],
  sourcemap: true,
});

await build({
  entryPoints: ["apps/electron/preload.ts"],
  outfile: "out/electron/preload.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["electron"],
});

const lock = await readFile("apps/core/package-lock.json");
await copyFile("LICENSE", "out/core/LICENSE");
await copyFile("apps/core/package.json", "out/core/package.json");
await copyFile("apps/core/package-lock.json", "out/core/package-lock.json");
if (process.platform !== "win32") {
  const digest = createHash("sha256").update(lock).update(process.versions.modules).digest("hex");
  const prior = await readFile("out/core/.dependencies", "utf8").catch(() => "");

  const installed = await stat("out/core/node_modules/better-sqlite3").then(
    () => true,
    () => false,
  );

  if (prior !== digest || !installed) {
    try {
      const { stdout, stderr } = await promisify(execFile)(
        "npm",
        ["ci", "--omit=dev", "--no-audit", "--no-fund"],
        { cwd: "out/core", maxBuffer: 1024 * 1024 },
      );

      process.stdout.write(stdout);
      process.stderr.write(stderr);
    } catch {
      const lockData = JSON.parse(lock.toString("utf8"));
      for (const p of Object.keys(lockData.packages || {})) {
        if (!p || !p.startsWith("node_modules/")) continue;
        await cp(p, join("out/core", p), { recursive: true });
      }
    }

    await writeFile("out/core/.dependencies", digest);
  }
}
