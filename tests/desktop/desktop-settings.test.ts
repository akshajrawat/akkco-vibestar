import { expect, it } from "vitest";
import { _electron } from "playwright-core";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { Rpc } from "../../backend/rpc";
import { builtInProfiles } from "../../backend/flows/templates";
import { createFixtureEngine, fixtureRepository } from "../helpers/fixtures";

const require = createRequire(import.meta.url);

it.skipIf(process.env.VIBESTAR_SETTINGS_DESKTOP_TEST !== "1")(
  "preserves the mounted task, drafts, persistence and keyboard focus in the Settings workspace",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-settings-desktop-"));
    const screenshots = join(dir, "screenshots");
    const home = join(dir, "home");
    const blocked = join(dir, "blocked-cli");
    await Promise.all([mkdir(screenshots), mkdir(home), mkdir(blocked)]);
    for (const name of ["gh", "agy", "codex"])
      await writeFile(
        join(blocked, name),
        "#!/bin/sh\necho 'Live CLI disabled in settings fixture' >&2\nexit 1\n",
        { mode: 0o755 },
      );

    const engine = await createFixtureEngine(join(dir, "fixture-data"));
    const rpc = new Rpc(engine);

    const fixtureCall = (method: string, input: unknown) => {
      if (method === "pr.watch.start") return null;
      if (method === "providers.detect")
        return ["codex", "antigravity", "github"].map((provider) => ({
          provider,
          installed: false,
          connected: false,
          version: "Fixture only",
          models: [],
          efforts: [],
          capabilities: [],
        }));
      return rpc.call(method, input);
    };

    const { repo } = await fixtureRepository(engine, dir);
    engine.db.saveRepository({ ...repo, name: "akkco-vibestar-test" });

    const create = (goal: string) =>
      engine.createGeneralTask({
        request_id: randomUUID(),
        goal,
        profile_id: builtInProfiles.implementer,
        repository_id: repo.id,
      });

    const idle = create(
      "Refactor folder structure and simplify workspace ownership checks while preserving task and repository navigation",
    );

    const empty = await createFixtureEngine(join(dir, "empty-core"));
    await empty.close();

    let app = await _electron.launch({
      executablePath: require("electron") as string,
      args: [resolve(".")],
      env: {
        ...process.env,
        VIBESTAR_HOME: join(dir, "empty-core"),
        VIBESTAR_USER_DATA: join(dir, "electron-profile"),
        HOME: home,
        PATH: `${blocked}:${process.env.PATH}`,
      },
    });

    let completed = false;
    try {
      const page = await app.firstWindow();
      page.setDefaultTimeout(15000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));

      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1280, 720),
      );

      await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();

      await page.exposeFunction("fixtureRpc", (method: string, input: unknown) =>
        fixtureCall(method, input),
      );

      await app.evaluate(({ ipcMain, BrowserWindow }) => {
        ipcMain.removeHandler("core:rpc");

        ipcMain.handle("core:rpc", async (_event, request) => {
          try {
            return {
              ok: true,
              result: await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
                `window.fixtureRpc(${JSON.stringify(request.method)},${JSON.stringify(request.params)})`,
              ),
            };
          } catch (error) {
            return { ok: false, error: { message: String(error) } };
          }
        });
      });

      const refresh = () => page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await refresh();
      const sidebar = page.getByRole("complementary", { name: "Workspace navigation" });
      await sidebar.getByRole("button", { name: /^Refactor folder structure/ }).click();
      await page.locator(".flow-editor").waitFor();

      await page.locator(".react-flow__node").first().click();

      await page
        .getByRole("complementary", { name: "Node inspector" })
        .getByLabel("Name", { exact: true })
        .fill("Unsaved workflow draft");

      const inspectorScroll = await page.locator(".flow-inspector").evaluate((element) => {
        element.scrollTop = 80;
        return element.scrollTop;
      });

      // Object identity detects an unmount even when local storage would restore the same view.
      await page.evaluate(() => {
        Object.assign(window, {
          settingsFixtureWorkspace:
            document.querySelector(".flow-workspace") || document.querySelector(".flow-editor"),
        });
      });

      const definitionBefore = engine.flows.definition(idle.flow_id!);
      const openSettings = sidebar.getByRole("button", { name: "Settings", exact: true });
      await openSettings.click();
      const overlay = page.getByRole("dialog", { name: "Settings", exact: true });
      const nav = overlay.getByRole("navigation", { name: "Settings sections" });
      const category = (name: string) => nav.getByRole("button", { name, exact: true }).click();
      await overlay.getByRole("heading", { name: "Task", exact: true }).waitFor();

      expect(
        await overlay
          .getByRole("searchbox", { name: "Search settings" })
          .evaluate((element) => element === document.activeElement),
      ).toBe(true);

      const panelSize = (await overlay.boundingBox())!;
      expect(panelSize.width).toBeGreaterThan(1000);
      expect(panelSize.width).toBeLessThan(1050);
      expect(panelSize.height).toBeGreaterThan(640);
      await page.screenshot({ path: join(screenshots, "settings-general-1280.png") });

      const close = overlay.getByRole("button", { name: "Close Settings" });
      const search = overlay.getByRole("searchbox", { name: "Search settings" });
      await search.focus();
      await page.keyboard.press("Shift+Tab");

      expect(
        await overlay
          .getByRole("combobox", { name: "Concurrency" })
          .evaluate((element) => element === document.activeElement),
      ).toBe(true);

      await page.keyboard.press("Tab");
      expect(await search.evaluate((element) => element === document.activeElement)).toBe(true);
      await page.keyboard.press("Control+b");
      expect(await sidebar.isVisible()).toBe(true);
      await page.keyboard.press("Control+Shift+p");
      expect(await page.locator(".command-palette").count()).toBe(0);
      // The native modal rejects programmatic focus into the still-mounted workspace.
      await openSettings.evaluate((element: HTMLButtonElement) => element.focus());

      expect(await overlay.evaluate((element) => element.contains(document.activeElement))).toBe(
        true,
      );

      await search.fill("providers");
      expect(await nav.getByRole("button").count()).toBe(1);
      await search.press("Escape");
      expect(await overlay.isVisible()).toBe(true);
      expect(await nav.getByRole("button").count()).toBe(7);
      await overlay.getByRole("combobox", { name: "Concurrency" }).click();
      await overlay.getByRole("listbox", { name: "Concurrency" }).waitFor();
      await page.screenshot({ path: join(screenshots, "settings-task-dropdown.png") });
      await page.getByRole("option", { name: "4", exact: true }).click();

      await page.waitForFunction(() => {
        const combobox = document.querySelector('[aria-label="Concurrency"]');
        return combobox?.getAttribute("data-value") === "4";
      });

      expect(engine.db.settings().concurrency).toBe(4);
      await category("Providers");
      await overlay.getByRole("heading", { name: "Providers", exact: true }).waitFor();
      await page.screenshot({ path: join(screenshots, "settings-providers.png") });
      await category("Repositories");

      await overlay
        .getByRole("heading", { name: "Connected repositories", exact: false })
        .waitFor();

      await page.screenshot({ path: join(screenshots, "settings-repository-toolbar.png") });
      await overlay.getByRole("textbox", { name: "Search repositories" }).fill("fixture-draft");
      await page.screenshot({ path: join(screenshots, "settings-repositories.png") });
      await category("Execution");
      await overlay.getByLabel("Linux data directory optional").fill("/fixture/unsaved-data");
      await page.screenshot({ path: join(screenshots, "settings-execution.png") });
      await category("Repositories");

      expect(await overlay.getByRole("textbox", { name: "Search repositories" }).inputValue()).toBe(
        "fixture-draft",
      );

      expect(await overlay.getByText("Local repository discovery", { exact: true }).count()).toBe(
        0,
      );

      await category("Storage");
      await overlay.getByRole("button", { name: "Refresh sizes" }).waitFor();
      await overlay.getByText("Measuring…", { exact: true }).waitFor({ state: "hidden" });
      await overlay.getByRole("button", { name: "Clear cache", exact: true }).click();
      const cleanup = page.getByRole("dialog", { name: "Confirm storage cleanup" });
      await cleanup.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.screenshot({ path: join(screenshots, "settings-storage.png") });
      await category("General");
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 540));
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.screenshot({ path: join(screenshots, "settings-general-800.png") });

      expect(await overlay.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );

      for (const name of ["Providers", "Repositories", "Storage"]) {
        await category(name);

        expect(
          await overlay
            .locator(".settings-category:not([hidden])")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
      }

      await category("General");

      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setMinimumSize(360, 400);
        win.setSize(390, 640);
      });

      await page.screenshot({ path: join(screenshots, "settings-general-390.png") });

      expect(await overlay.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );

      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1440, 900),
      );

      await page.evaluate(() => document.documentElement.style.setProperty("--accent", "#dca268"));
      await page.mouse.move(4, 4);
      await page.screenshot({ path: join(screenshots, "settings-general-1440-accent.png") });
      await close.click();
      await overlay.waitFor({ state: "hidden" });

      expect(await openSettings.evaluate((element) => element === document.activeElement)).toBe(
        true,
      );

      expect(
        await page.evaluate(() => {
          const saved = (window as unknown as { settingsFixtureWorkspace: Element })
            .settingsFixtureWorkspace;

          return (
            saved.isConnected &&
            saved ===
              (document.querySelector(".flow-workspace") || document.querySelector(".flow-editor"))
          );
        }),
      ).toBe(true);

      expect(
        await page
          .getByRole("complementary", { name: "Node inspector" })
          .getByLabel("Name", { exact: true })
          .inputValue(),
      ).toBe("Unsaved workflow draft");

      expect(await page.locator(".flow-inspector").evaluate((element) => element.scrollTop)).toBe(
        inspectorScroll,
      );

      expect(engine.flows.definition(idle.flow_id!)).toEqual(definitionBefore);
      expect(engine.db.all("SELECT id FROM flow_runs WHERE task_id=?", idle.id)).toHaveLength(0);
      expect(errors).toEqual([]);

      // Restart the actual desktop, then reattach the same isolated test authority.
      await app.close();

      app = await _electron.launch({
        executablePath: require("electron") as string,
        args: [resolve(".")],
        env: {
          ...process.env,
          VIBESTAR_HOME: join(dir, "empty-core"),
          VIBESTAR_USER_DATA: join(dir, "electron-profile"),
          HOME: home,
          PATH: `${blocked}:${process.env.PATH}`,
        },
      });

      const restarted = await app.firstWindow();
      await restarted.getByRole("heading", { name: "Tasks", exact: true }).waitFor();

      await restarted.exposeFunction("fixtureRpc", (method: string, input: unknown) =>
        fixtureCall(method, input),
      );

      await app.evaluate(({ ipcMain, BrowserWindow }) => {
        ipcMain.removeHandler("core:rpc");

        ipcMain.handle("core:rpc", async (_event, request) => {
          try {
            return {
              ok: true,
              result: await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
                `window.fixtureRpc(${JSON.stringify(request.method)},${JSON.stringify(request.params)})`,
              ),
            };
          } catch (error) {
            return { ok: false, error: { message: String(error) } };
          }
        });
      });

      await restarted.evaluate(() => window.dispatchEvent(new Event("focus")));

      await restarted
        .getByRole("complementary", { name: "Workspace navigation" })
        .getByRole("button", { name: "Settings", exact: true })
        .click();

      expect(
        await restarted.getByRole("combobox", { name: "Concurrency" }).getAttribute("data-value"),
      ).toBe("4");

      completed = true;
      console.log(`Settings Electron screenshots: ${screenshots}`);
    } catch (error) {
      const page = await app.firstWindow();
      await page.screenshot({ path: join(screenshots, "failure.png") }).catch(() => {});
      console.log(`Settings failure screenshot: ${screenshots}`);
      throw error;
    } finally {
      await app.close();
      await rpc.close();
      await engine.close();
      if (completed) {
        const reopened = await createFixtureEngine(join(dir, "fixture-data"));
        try {
          expect(reopened.db.settings().concurrency).toBe(4);
        } finally {
          await reopened.close();
        }
      }

      if (!process.env.VIBESTAR_KEEP_EVIDENCE) await rm(dir, { recursive: true, force: true });
    }
  },
  90000,
);
