import { migrations } from "../../backend/storage/migrations";
import { expect, it, vi } from "vitest";
import { _electron } from "playwright-core";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CoreBridge } from "../../electron/bridge";
import type { Snapshot } from "../../src/lib/types";

it.skipIf(process.env.VIBESTAR_PACKAGED_TEST !== "1" || process.platform !== "linux")(
  "starts the packaged Linux desktop and both bundled helpers with empty isolated roots",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-packaged-watch-"));
    const home = join(dir, "home");
    const bin = join(dir, "blocked-cli");
    await mkdir(home);
    await mkdir(bin);
    for (const name of ["codex", "agy", "gh"])
      await writeFile(
        join(bin, name),
        "#!/bin/sh\necho 'Live account access disabled in package smoke' >&2\nexit 1\n",
        { mode: 0o755 },
      );
    vi.stubEnv("HOME", home);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    const reports: unknown[] = [];
    try {
      const packageRoot = process.env.VIBESTAR_PACKAGE_DIR || "release";
      const linuxCore = resolve(packageRoot, "linux-unpacked/resources/core");
      const windowsCore = resolve(packageRoot, "win-unpacked/resources/core");
      expect(
        createHash("sha256")
          .update(await readFile(join(linuxCore, "core.cjs")))
          .digest("hex"),
      ).toBe(
        createHash("sha256")
          .update(await readFile(join(windowsCore, "core.cjs")))
          .digest("hex"),
      );
      for (const [name, core] of [
        ["linux", linuxCore],
        ["windows-wsl-helper", windowsCore],
      ]) {
        expect(await readFile(join(core, "LICENSE"), "utf8")).toBe(
          await readFile("LICENSE", "utf8"),
        );
        const bridge = new CoreBridge(core, {
          distro: "",
          data_home: join(dir, name),
          helper_path: "",
        });
        try {
          bridge.start();
          const info = (await bridge.request("core.info")) as Record<string, unknown>;
          expect(info).toMatchObject({
            protocol: 3,
            pipeline_approvals: true,
            manual_pr_analysis: true,
            pr_repair: true,
            manual_issue_watch: true,
            issue_watch_contract: 1,
          });
          const snapshot = (await bridge.request("snapshot")) as Snapshot;
          expect(snapshot.tasks).toEqual([]);
          expect(snapshot.repairs).toEqual([]);
          expect(await bridge.request("issueWatch.list", {})).toEqual([]);
          const usage = (await bridge.request("usage.info")) as {
            runs: { count: number };
            schema: { version: number };
          };
          expect(usage.runs.count).toBe(0);
          expect(usage.schema.version).toBe(migrations.at(-1)!.version);
          reports.push({ name, info, usage, tasks: 0, repairs: 0, watches: 0 });
        } finally {
          await bridge.stop();
        }
      }
      const app = await _electron.launch({
        executablePath: resolve(packageRoot, "linux-unpacked/akkco-vibestar"),
        args: [],
        env: {
          ...process.env,
          VIBESTAR_HOME: join(dir, "desktop-data"),
          VIBESTAR_USER_DATA: join(dir, "profile"),
        },
        timeout: 30000,
      });
      try {
        const page = await app.firstWindow();
        page.setDefaultTimeout(15000);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();
        await page.getByRole("button", { name: "Issue Watch", exact: true }).click();
        await page.getByRole("button", { name: "New watch", exact: true }).click();
        await page.getByRole("dialog", { name: "New Issue Watch", exact: true }).waitFor();
        await page.screenshot({ path: join(dir, "packaged-watch-editor.png") });
        const usage = await page.evaluate(() =>
          window.vibestar.rpc<{ runs: { count: number } }>("usage.info"),
        );
        expect(usage.runs.count).toBe(0);
        expect(errors).toEqual([]);
        reports.push({ name: "linux-desktop", usage, rendererErrors: errors });
      } finally {
        await app.close();
      }
      await writeFile(
        join(dir, "results.json"),
        JSON.stringify(
          {
            reports,
            realInference: false,
            realGitHubWrites: false,
            nativeWindows: false,
          },
          null,
          2,
        ),
      );
      process.stdout.write(`Packaged Issue Watch evidence: ${dir}\n`);
    } finally {
      vi.unstubAllEnvs();
      if (process.env.VIBESTAR_KEEP_EVIDENCE !== "1")
        await rm(dir, { recursive: true, force: true });
    }
  },
  90000,
);
