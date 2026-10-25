import { expect, it } from "vitest";
import { _electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Rpc } from "../backend/rpc";
import { defaultSettings, parseIssue } from "../backend/domain";
import {
  createFixtureEngine,
  fixtureRepository,
  FixtureProvider,
  prepareFixtureTask,
} from "./fixtures";
import { IndependentReviewProvider } from "./verification/provider";

const require = createRequire(import.meta.url);
it.skipIf(process.env.VIBESTAR_VERIFICATION_DESKTOP_TEST !== "1")(
  "verifies environmental recovery, independent review, compact navigation and backup-backed reset in built Electron",
  async () => {
    const dir = await mkdtemp(
      join(tmpdir(), "vibestar-verification-v2-desktop-"),
    );
    const evidence = join(dir, "screenshots");
    const engine = await createFixtureEngine(join(dir, "data"), (stage) => ({
      ...new IndependentReviewProvider(),
      name: [1, 5].includes(stage) ? "antigravity" : "codex",
    }));
    const rpc = new Rpc(engine);
    engine.db.saveSettings({
      ...defaultSettings,
      antigravity: { model: "next-model", effort: "low", timeout_secs: 30 },
      codex_plan: { model: "next-model", effort: "low", timeout_secs: 30 },
      codex_implementation: {
        model: "next-model",
        effort: "low",
        timeout_secs: 30,
      },
    });
    const { repo, upstream } = await fixtureRepository(engine, dir);
    const original = await readFile(join(upstream, "source.txt"));
    const emptyRoot = join(dir, "empty-core");
    const empty = await createFixtureEngine(emptyRoot);
    await empty.close();
    const home = join(dir, "isolated-home");
    const cli = join(dir, "blocked-cli");
    for (const path of [evidence, home, cli]) await mkdir(path);
    for (const name of ["codex", "agy", "gh"])
      await writeFile(
        join(cli, name),
        "#!/bin/sh\necho 'Live service disabled in fixture' >&2\nexit 1\n",
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
        async (method: string, params: unknown) =>
          method === "providers.detect"
            ? [await new FixtureProvider().detect()]
            : rpc.call(method, params),
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
      const task = engine.enqueue(
        repo,
        parseIssue("https://github.com/fixture/fixture/issues/9"),
        "Multiplication table with complete results, responsive presentation and accessible semantics",
        "",
        {},
        "partial",
      );
      await page.locator(".tree-task").first().click();
      await page
        .getByRole("button", { name: "Approve → Codex refinement" })
        .click();
      await page.getByRole("button", { name: "Approve → Implement" }).click();
      await expect
        .poll(() => engine.db.task(task.id).status)
        .toBe("verification_blocked");
      await page
        .locator(".chat-actions")
        .getByText("More options", { exact: true })
        .click();
      await page
        .locator(".chat-actions")
        .getByRole("button", { name: "Continue to independent review" })
        .waitFor();
      await page
        .locator(".chat-actions")
        .getByText("More options", { exact: true })
        .click();
      await expect
        .poll(() => page.locator('.tool-event[data-state="failed"]').count())
        .toBe(0);
      expect(
        engine.db.detail(task.id).tests.filter((test) => test.exit_code === 1),
      ).toHaveLength(2);
      if (
        !(await page
          .getByRole("tab", { name: "Workflow", exact: true })
          .count())
      )
        await page.getByLabel("Toggle secondary workspace").click();
      await page.getByRole("tab", { name: "Workflow", exact: true }).click();
      await page
        .locator(".pipeline-stages")
        .getByText("Verification incomplete", { exact: true })
        .waitFor();
      for (const [width, height] of [
        [1920, 1080],
        [1440, 900],
        [1280, 720],
        [1000, 720],
      ]) {
        await app.evaluate(
          ({ BrowserWindow }, size) =>
            BrowserWindow.getAllWindows()[0].setSize(
              ...(size as [number, number]),
            ),
          [width, height],
        );
        await expect
          .poll(() => page.evaluate(() => window.innerWidth))
          .toBe(width);
        await page.evaluate(async () => {
          await document.fonts.ready;
          document
            .getAnimations()
            .filter((animation) =>
              Number.isFinite(animation.effect?.getComputedTiming().iterations),
            )
            .forEach((animation) => animation.finish());
        });
        expect(
          await page
            .locator(".pipeline-stages")
            .evaluate((node) => node.scrollWidth <= node.clientWidth),
        ).toBe(true);
        await page.screenshot({
          path: join(evidence, `pipeline-${width}x${height}.png`),
        });
      }
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.locator(".pipeline-stage-actions > summary").first().focus();
      expect(
        await page
          .locator(".pipeline-stage-actions > summary")
          .first()
          .evaluate((node) =>
            parseFloat(getComputedStyle(node).transitionDuration),
          ),
      ).toBeLessThanOrEqual(0.001);
      await page.keyboard.press("Enter");
      await page.keyboard.press("Escape");
      if (await page.getByLabel("Collapse secondary workspace").count())
        await page.getByLabel("Collapse secondary workspace").click();
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1440, 900),
      );
      const row = page.locator(".tree-task.selected");
      expect(await row.getAttribute("aria-current")).toBe("page");
      expect(
        await row.evaluate((node) => getComputedStyle(node).boxShadow),
      ).toBe("none");
      await row.click({ button: "right" });
      await page.getByRole("menu", { name: "Task #9 actions" }).waitFor();
      await page.keyboard.press("Escape");
      const runsBeforePreparation = engine.db.detail(task.id).runs.length;
      const commandsBeforePreparation = engine.db.detail(task.id).tests.length;
      await page
        .locator(".chat-actions")
        .getByRole("button", { name: "Prepare missing checks" })
        .click();
      const preparation = page.getByRole("dialog", {
        name: "Prepare missing checks",
      });
      await preparation.getByText(/No executable command was saved/).waitFor();
      await preparation.getByText(/Waiting for prerequisites/).waitFor();
      for (const [width, height] of [
        [1920, 1080],
        [1440, 900],
        [1280, 720],
      ]) {
        await app.evaluate(
          ({ BrowserWindow }, size) =>
            BrowserWindow.getAllWindows()[0].setSize(
              ...(size as [number, number]),
            ),
          [width, height],
        );
        await expect
          .poll(() => page.evaluate(() => window.innerWidth))
          .toBe(width);
        expect(
          await preparation.evaluate(
            (node) => node.scrollWidth <= node.clientWidth,
          ),
        ).toBe(true);
        await page.screenshot({
          path: join(evidence, `prepare-checks-${width}x${height}.png`),
        });
      }
      await preparation
        .getByRole("button", { name: "Prepare runnable checks with Codex" })
        .click();
      const prepareAuthorization = page.getByRole("dialog", {
        name: "Fix with Codex",
      });
      await prepareAuthorization
        .getByRole("button", { name: "Authorize one Codex fix" })
        .waitFor();
      expect(engine.db.detail(task.id).runs.length).toBe(runsBeforePreparation);
      expect(engine.db.detail(task.id).tests.length).toBe(
        commandsBeforePreparation,
      );
      await prepareAuthorization
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await page
        .locator(".chat-actions")
        .getByText("More options", { exact: true })
        .click();
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1440, 900),
      );
      await page
        .locator(".chat-actions")
        .getByRole("button", { name: "Continue to independent review" })
        .click();
      const approval = page.getByRole("dialog", {
        name: "Review with verification gaps",
      });
      await approval
        .getByRole("button", { name: "Inspect current gaps" })
        .click();
      await approval
        .getByText("Browser rendering and accessibility", { exact: true })
        .waitFor();
      const start = approval.getByRole("button", {
        name: "Approve implementation & start independent review",
      });
      expect(await start.isDisabled()).toBe(true);
      await page.screenshot({
        path: join(evidence, "explicit-gap-approval.png"),
      });
      await approval.getByRole("checkbox").check();
      await start.click();
      await page
        .getByRole("button", { name: "Accept review", exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "View review", exact: true })
        .click();
      await page
        .locator(".secondary-content")
        .getByText("Code review: Approved", { exact: true })
        .waitFor();
      expect(engine.db.task(task.id).final_review_verdict).toBe(
        "code_approved_incomplete",
      );
      expect(engine.db.detail(task.id).runs.map((run) => run.stage)).toEqual([
        1, 2, 3, 5,
      ]);
      await page.screenshot({
        path: join(evidence, "independent-review-gaps.png"),
      });
      if (await page.getByLabel("Collapse secondary workspace").count())
        await page.getByLabel("Collapse secondary workspace").click();
      await page
        .getByRole("button", { name: "Accept review", exact: true })
        .click();
      await expect
        .poll(() => engine.db.task(task.id).status)
        .toBe("reviewed_with_gaps");
      expect(
        await page
          .locator(".chat-actions")
          .getByRole("button", { name: "Git Finalization", exact: true })
          .count(),
      ).toBe(0);
      const clean = await prepareFixtureTask(engine, repo, randomUUID());
      engine.changed();
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Storage", exact: true }).click();
      await page
        .getByRole("button", { name: "Reset Local Test Workspace…" })
        .click();
      const reset = page.getByRole("dialog", {
        name: "Reset Local Test Workspace",
        exact: true,
      });
      await reset.getByText(/1 eligible tasks · 1 protected tasks/).waitFor();
      await page.screenshot({ path: join(evidence, "reset-preview.png") });
      await reset
        .getByLabel("Type RESET LOCAL TEST WORKSPACE")
        .fill("RESET LOCAL TEST WORKSPACE");
      await reset
        .getByRole("button", { name: "Back up & reset eligible task data" })
        .click();
      await reset.getByText("1 tasks removed. 1 tasks preserved.").waitFor();
      await page.screenshot({ path: join(evidence, "reset-backed-up.png") });
      expect(engine.db.tasks().map((entry) => entry.id)).toEqual([task.id]);
      expect(
        engine.db.all("SELECT id FROM tasks WHERE id=?", clean.id),
      ).toEqual([]);
      expect(await readFile(join(upstream, "source.txt"))).toEqual(original);
      expect(errors).toEqual([]);
      await writeFile(
        join(evidence, "results.json"),
        JSON.stringify(
          {
            task: engine.db.task(task.id),
            detail: await rpc.call("task.detail", { id: task.id }),
            errors,
            subscriptions: "No real model invocations",
            github: "No remote writes",
          },
          null,
          2,
        ),
      );
      process.stdout.write(`Verification V2 Electron evidence: ${evidence}\n`);
    } catch (error) {
      await (
        await app.firstWindow()
      )
        .screenshot({ path: join(evidence, "failure.png") })
        .catch(() => {});
      process.stdout.write(`Verification V2 failure evidence: ${evidence}\n`);
      throw error;
    } finally {
      if (forward) engine.off("event", forward);
      await app.close();
      await rpc.close();
      await engine.close();
    }
  },
  120000,
);
