import { createFixtureEngine } from "./fixtures";
import { it, expect, vi } from "vitest";
import { _electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Rpc } from "../backend/rpc";
import { GitHubMonitor } from "../backend/scheduled/github";
import { PRFixtureProvider, prSnapshot } from "./pr-fixtures";
import type { Snapshot } from "../src/lib/types";
import type { PRAnalysisSession } from "../backend/review/pr/contracts";
const require = createRequire(import.meta.url);

it.skipIf(process.env.VIBESTAR_PR_DESKTOP_TEST !== "1")(
  "exercises manual tracking, explicit analysis, complete report/history and no startup inference through Electron IPC",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-pr-desktop-"));
    const engine = await createFixtureEngine(
      join(dir, "fixture"),
      () => new PRFixtureProvider(),
    );
    const monitor = new GitHubMonitor(dir);
    vi.spyOn(monitor, "inspect").mockResolvedValue(structuredClone(prSnapshot));
    const rpc = new Rpc(engine, monitor);
    const emptyRoot = join(dir, "empty-core");
    const empty = await createFixtureEngine(emptyRoot);
    await empty.close();
    const home = join(dir, "isolated-home");
    const cli = join(dir, "blocked-cli");
    await mkdir(home);
    await mkdir(cli);
    for (const name of ["codex", "agy", "gh"])
      await writeFile(
        join(cli, name),
        "#!/bin/sh\necho 'Real provider/GitHub CLI disabled in fixture' >&2\nexit 1\n",
        { mode: 0o755 },
      );
    const app = await _electron.launch({
      executablePath: require("electron") as string,
      args: [resolve(".")],
      env: {
        ...process.env,
        HOME: home,
        PATH: `${cli}:${process.env.PATH}`,
        VIBESTAR_HOME: emptyRoot,
        VIBESTAR_USER_DATA: join(dir, "profile"),
      },
      timeout: 30000,
    });
    let forward: ((event: unknown) => void) | undefined;
    try {
      const page = await app.firstWindow();
      page.setDefaultTimeout(15000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();
      await page.exposeFunction(
        "fixtureRpc",
        (method: string, params: unknown) => rpc.call(method, params),
      );
      await app.evaluate(({ ipcMain, BrowserWindow }) => {
        ipcMain.removeHandler("core:rpc");
        ipcMain.handle("core:rpc", async (_event, request) => {
          try {
            return {
              ok: true,
              result:
                await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
                  `window.fixtureRpc(${JSON.stringify(request.method)},${JSON.stringify(request.params)})`,
                ),
            };
          } catch (error) {
            return { ok: false, error: { message: String(error) } };
          }
        });
      });
      forward = (event) => {
        void app
          .evaluate(
            ({ BrowserWindow }, payload) =>
              BrowserWindow.getAllWindows()[0]?.webContents.send(
                "core:event",
                payload,
              ),
            event,
          )
          .catch(() => {});
      };
      engine.on("event", forward);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.getByRole("button", { name: "PR watch", exact: true }).click();
      await page
        .getByRole("heading", { name: "Pull requests", exact: true })
        .waitFor();
      expect(engine.db.all("SELECT * FROM ai_usage")).toEqual([]);
      expect(engine.db.all("SELECT * FROM scheduled_jobs")).toEqual([]);
      await page
        .getByLabel("PR URL")
        .fill("https://github.com/upstream/project/pull/1");
      await page.getByRole("button", { name: "Track PR", exact: true }).click();
      await page
        .getByRole("button", { name: "Analyze PR", exact: true })
        .waitFor();
      expect(engine.db.all("SELECT * FROM ai_usage")).toEqual([]);
      expect(vi.mocked(monitor.inspect)).not.toHaveBeenCalled();
      await page
        .getByRole("button", { name: "Analyze PR", exact: true })
        .click();
      await page
        .getByRole("heading", {
          name: "Three observations require consideration, plus positive feedback.",
          exact: true,
        })
        .waitFor();
      const snapshot = await page.evaluate(() =>
        window.vibestar.rpc<Snapshot>("snapshot"),
      );
      expect(snapshot.scheduled?.[0].enabled).toBe(false);
      expect(engine.db.all("SELECT * FROM scheduled_agent_runs")).toHaveLength(
        1,
      );
      await page
        .getByRole("tab", { name: "Full Conversation", exact: true })
        .click();
      await page
        .getByText("Apart from that, everything seems to be fine to me.", {
          exact: true,
        })
        .waitFor();
      await page
        .getByRole("tab", { name: "Review Actions", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Positive feedback / information" })
        .waitFor();
      expect(
        await page
          .getByRole("button", { name: "Solve Review", exact: true })
          .isDisabled(),
      ).toBe(false);
      await page
        .getByRole("tab", { name: "Analysis History", exact: true })
        .click();
      await page.getByText(/input 50/).waitFor();
      await page
        .getByRole("button", { name: "Raw stdout", exact: true })
        .click();
      await page
        .getByText("Saved redacted provider output", { exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "Analyze Again", exact: true })
        .last()
        .click();
      const jobId = snapshot.scheduled![0].id;
      await expect
        .poll(async () => {
          const detail = await page.evaluate(
            (id) =>
              window.vibestar.rpc<{ analyses: PRAnalysisSession[] }>(
                "scheduled.detail",
                { id },
              ),
            jobId,
          );
          return detail.analyses[0].method;
        })
        .toBe("reused");
      expect(engine.db.all("SELECT * FROM scheduled_agent_runs")).toHaveLength(
        1,
      );
      await page.screenshot({ path: join(dir, "manual-pr-report.png") });
      expect(errors).toEqual([]);
    } finally {
      if (forward) engine.off("event", forward);
      await app.close();
      await rpc.close();
      await engine.close();
      vi.restoreAllMocks();
      await rm(dir, { recursive: true, force: true });
    }
  },
  60000,
);
