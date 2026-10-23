import { createFixtureEngine } from "./fixtures";
import { expect, it, vi } from "vitest";
import { _electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Rpc } from "../backend/rpc";
import { GitHubMonitor } from "../backend/scheduled/github";
import { RepairService } from "../backend/review/repair/service";
import { RepairWorkspaces } from "../backend/review/repair/workspace";
import { repairFixture } from "./pr-repair/fixtures";
import { RepairFixtureProvider } from "./pr-repair/provider";
import { PRFixtureProvider } from "./pr-fixtures";
import { checked } from "../backend/execution/process";
import { defaultSettings } from "../backend/domain";
import { Database } from "../backend/storage/database";

const require = createRequire(import.meta.url);
it.skipIf(process.env.VIBESTAR_REPAIR_DESKTOP_TEST !== "1")(
  "completes an Oppia-shaped manual PR analysis, isolated repair, independent review and confirmed fast-forward publication through built Electron IPC",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-pr-repair-desktop-"));
    const engine = await createFixtureEngine(
      join(dir, "fixture"),
      (stage, provider) =>
        stage === 1
          ? new PRFixtureProvider()
          : new RepairFixtureProvider(provider!, {
              readonlyProbe: provider === "antigravity",
            }),
    );
    engine.db.saveSettings({
      ...defaultSettings,
      utility_ai: {
        ...defaultSettings.utility_ai,
        provider: "codex",
        model: "next-model",
        effort: "low",
      },
      codex_implementation: {
        model: "repair-model",
        effort: "xhigh",
        timeout_secs: 60,
      },
      antigravity: { model: "repair-model", effort: "high", timeout_secs: 60 },
    });
    const fixture = await repairFixture(engine, dir);
    for (const table of ["pr_repairs", "pr_analyses", "scheduled_jobs"])
      engine.db.run(`DELETE FROM ${table}`);
    const beforeIndex = await readFile(join(fixture.source, ".git", "index"));
    const beforeStatus = await checked(
      "git",
      ["status", "--porcelain"],
      fixture.source,
    );
    const monitor = new GitHubMonitor(dir);
    vi.spyOn(monitor, "inspect").mockResolvedValue(
      fixture.session.context.snapshot!,
    );
    const workspaces = new RepairWorkspaces(
      engine.root,
      engine.git,
      (_, side) => (side === "head" ? fixture.fork : fixture.upstream),
    );
    const repairs = new RepairService(
      engine,
      async () => fixture.session.identity,
      workspaces,
      () => fixture.fork,
    );
    const rpc = new Rpc(engine, monitor, repairs);
    const emptyRoot = join(dir, "empty-core");
    const empty = await createFixtureEngine(emptyRoot);
    await empty.close();
    const isolatedHome = join(dir, "isolated-home"),
      blockedCli = join(dir, "blocked-cli"),
      screenshots = join(dir, "screenshots");
    for (const path of [isolatedHome, blockedCli, screenshots])
      await mkdir(path);
    for (const name of ["codex", "agy", "gh"])
      await writeFile(
        join(blockedCli, name),
        "#!/bin/sh\necho 'Real CLI disabled in fixture' >&2\nexit 1\n",
        { mode: 0o755 },
      );
    const app = await _electron.launch({
      executablePath: require("electron") as string,
      args: [resolve(".")],
      env: {
        ...process.env,
        HOME: isolatedHome,
        PATH: `${blockedCli}:${process.env.PATH}`,
        VIBESTAR_HOME: emptyRoot,
        VIBESTAR_USER_DATA: join(dir, "profile"),
      },
      timeout: 30000,
    });
    let forward: ((event: unknown) => void) | undefined;
    try {
      const page = await app.firstWindow();
      page.setDefaultTimeout(20000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();
      await page.exposeFunction(
        "fixtureRpc",
        async (method: string, params: unknown) => {
          if (method === "providers.detect")
            return [
              await new RepairFixtureProvider("codex").detect(),
              await new RepairFixtureProvider("antigravity").detect(),
            ];
          if (method === "editors.list")
            return {
              editors: [{ id: "code", label: "VS Code" }],
              default: "code",
            };
          if (method === "editors.open") {
            const request = params as { id: string; kind: string };
            expect(request.kind).toBe("repair");
            return { path: await repairs.openPath(request.id), editor: "code" };
          }
          return rpc.call(method, params);
        },
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
      await page
        .getByRole("button", { name: "Pull Requests", exact: true })
        .click();
      await page.getByLabel("PR URL").fill(fixture.session.identity.url);
      await page.getByRole("button", { name: "Track PR", exact: true }).click();
      expect(engine.db.all("SELECT * FROM ai_usage")).toEqual([]);
      await page
        .getByRole("button", { name: "Analyze PR", exact: true })
        .click();
      await page
        .getByRole("heading", {
          name: "Three observations require consideration, plus positive feedback.",
          exact: true,
        })
        .waitFor();
      await page
        .getByRole("tab", { name: "Full Conversation", exact: true })
        .click();
      await page
        .getByText("Apart from that, everything seems to be fine to me.", {
          exact: true,
        })
        .waitFor();
      await page.screenshot({ path: join(screenshots, "full-review.png") });
      await page
        .getByRole("button", { name: "Solve Review", exact: true })
        .click();
      expect(
        await page.getByRole("checkbox", { name: /Solve review item/ }).count(),
      ).toBe(3);
      await page
        .getByLabel("Additional repair instructions")
        .fill(
          "Move utilities, preserve original exploration and reject an empty draft assertion.",
        );
      await page.screenshot({
        path: join(screenshots, "selected-review-items.png"),
      });
      await page
        .getByRole("button", { name: "Solve selected items", exact: true })
        .click();
      await page
        .getByRole("button", {
          name: "Review repair and publication options",
          exact: true,
        })
        .click();
      await page
        .getByRole("heading", {
          name: "PR Review Repair Complete — Manual Review Required",
          exact: true,
        })
        .waitFor();
      const repair = repairs.store.list()[0];
      await expect.poll(() => repairs.isActive(repair.id)).toBe(false);
      expect(
        engine.db
          .all<{ provider: string }>(
            "SELECT provider FROM agent_runs WHERE repair_id=? ORDER BY started_at,rowid",
            repair.id,
          )
          .map((run) => run.provider),
      ).toEqual(["codex", "antigravity"]);
      expect(
        await checked(
          "git",
          ["rev-parse", "refs/heads/fix-translation-tests"],
          fixture.fork,
        ),
      ).toBe(fixture.head);
      await page.getByRole("tab", { name: "Changes", exact: true }).click();
      await page
        .getByRole("button", { name: "Upstream integration", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Open full diff review", exact: true })
        .click();
      await page
        .getByText("Latest upstream development", { exact: false })
        .first()
        .waitFor();
      await page.screenshot({
        path: join(screenshots, "upstream-integration.png"),
      });
      await page
        .getByRole("button", { name: "Review repair changes", exact: true })
        .click();
      await page.getByLabel("Return to chat").click();
      await page.getByRole("tab", { name: "Raw logs", exact: true }).click();
      await page.getByRole("button", { name: "Raw", exact: true }).click();
      await page
        .getByText(/Independent read-only review/)
        .first()
        .waitFor();
      await page.screenshot({
        path: join(screenshots, "repair-raw-output.png"),
      });
      await page.getByRole("button", { name: "Readable", exact: true }).click();
      await page.getByRole("tab", { name: "Tests", exact: true }).click();
      await page.getByRole("heading", { name: /Command executions/ }).waitFor();
      await page.screenshot({
        path: join(screenshots, "real-command-evidence.png"),
      });
      await page
        .getByRole("tab", { name: "Final review", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Approve and Prepare Push", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Confirm PR publication", exact: true })
        .waitFor();
      expect(
        await page
          .getByRole("button", { name: "Confirm Push", exact: true })
          .isDisabled(),
      ).toBe(true);
      await page.screenshot({
        path: join(screenshots, "manual-publication-before-commit.png"),
      });
      await page
        .getByRole("dialog", { name: "Confirm PR publication" })
        .getByRole("button", { name: "Commit Locally", exact: true })
        .click();
      await expect
        .poll(() =>
          page
            .getByRole("button", { name: "Confirm Push", exact: true })
            .isEnabled(),
        )
        .toBe(true);
      const approved = repairs.store.get(repair.id);
      const localHead = await checked(
        "git",
        ["rev-parse", "HEAD"],
        approved.workspace.worktree_path,
      );
      expect(
        await checked(
          "git",
          ["rev-parse", "refs/heads/fix-translation-tests"],
          fixture.fork,
        ),
      ).toBe(fixture.head);
      await page.screenshot({
        path: join(screenshots, "explicit-push-confirmation.png"),
      });
      await page
        .getByRole("button", { name: "Confirm Push", exact: true })
        .click();
      await page
        .getByRole("heading", {
          name: "Review repair pushed successfully",
          exact: true,
        })
        .waitFor();
      await page.screenshot({
        path: join(screenshots, "published-repair.png"),
      });
      expect(
        await checked(
          "git",
          ["rev-parse", "refs/heads/fix-translation-tests"],
          fixture.fork,
        ),
      ).toBe(localHead);
      expect(
        await checked("git", ["status", "--porcelain"], fixture.source),
      ).toBe(beforeStatus);
      expect(await readFile(join(fixture.source, ".git", "index"))).toEqual(
        beforeIndex,
      );
      expect(
        await checked(
          "git",
          ["rev-parse", "refs/heads/develop"],
          fixture.upstream,
        ),
      ).toBe(fixture.base);
      const usage = engine.db.all("SELECT * FROM ai_usage");
      expect(usage).toHaveLength(3);
      expect(vi.mocked(monitor.inspect)).toHaveBeenCalledTimes(1);
      expect(errors).toEqual([]);
      const emptyDb = new Database(join(emptyRoot, "state", "vibestar.sqlite"));
      try {
        expect(emptyDb.all("SELECT * FROM ai_usage")).toEqual([]);
      } finally {
        emptyDb.close();
      }
      await writeFile(
        join(screenshots, "results.json"),
        JSON.stringify(
          {
            repair: await repairs.detail(repair.id),
            localHead,
            rendererErrors: errors,
            sourceUnchanged: true,
            inferenceRuns: usage.length,
            realInference: false,
            realGithubWrites: false,
          },
          null,
          2,
        ),
      );
      process.stdout.write(`Repair Electron evidence: ${screenshots}\n`);
    } finally {
      if (forward) engine.off("event", forward);
      await app.close();
      await rpc.close();
      await engine.close();
      vi.restoreAllMocks();
      if (process.env.VIBESTAR_KEEP_EVIDENCE !== "1")
        await rm(dir, { recursive: true, force: true });
    }
  },
  120000,
);
