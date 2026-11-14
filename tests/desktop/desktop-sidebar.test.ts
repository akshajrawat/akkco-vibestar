import { expect, it } from "vitest";
import { _electron } from "playwright-core";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { Rpc } from "../../backend/rpc";
import { builtInProfiles } from "../../backend/flows/templates";
import { resolveNodeInputs } from "../../backend/flows/context";
import { createFixtureEngine, fixtureRepository } from "../helpers/fixtures";

const require = createRequire(import.meta.url);

it.skipIf(process.env.VIBESTAR_SIDEBAR_DESKTOP_TEST !== "1")(
  "renders flat task navigation, dynamic Working height, keyboard controls and configured colors in built Electron",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-sidebar-desktop-"));
    const screenshots = join(dir, "screenshots");
    const home = join(dir, "home");
    const blocked = join(dir, "blocked-cli");
    await Promise.all([mkdir(screenshots), mkdir(home), mkdir(blocked)]);
    for (const name of ["gh", "agy", "codex"])
      await writeFile(
        join(blocked, name),
        "#!/bin/sh\necho 'Live CLI disabled in sidebar fixture' >&2\nexit 1\n",
        { mode: 0o755 },
      );

    const engine = await createFixtureEngine(join(dir, "fixture-data"));
    const rpc = new Rpc(engine);
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

    const app = await _electron.launch({
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
        method === "pr.watch.start" ? null : rpc.call(method, input),
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

      await sidebar.getByRole("button", { name: "Tasks, 1" }).waitFor();
      expect(await sidebar.getByText("Tasks", { exact: true }).count()).toBe(0);

      expect(
        await sidebar.locator(".sidebar-header").getByRole("button", { name: "Tasks, 1" }).count(),
      ).toBe(1);

      const searchHeader = (await sidebar.locator(".sidebar-header").boundingBox())!;

      expect((await sidebar.locator(".tree-task").first().boundingBox())!.y).toBe(
        searchHeader.y + searchHeader.height + 4,
      );

      expect((await sidebar.boundingBox())!.y).toBe(0);
      expect((await sidebar.boundingBox())!.height).toBe(720);

      expect((await page.locator(".titlebar").boundingBox())!.x).toBeGreaterThanOrEqual(
        (await sidebar.boundingBox())!.width,
      );

      expect(await page.locator(".titlebar-name, .sidebar-toggle").count()).toBe(0);
      expect(await sidebar.locator(".sidebar-brand").innerText()).toBe("Vibestar");

      expect(
        await sidebar
          .locator(".sidebar-brand img")
          .evaluate((element) => (element as HTMLImageElement).naturalWidth),
      ).toBeGreaterThan(0);

      const initialWidth = (await sidebar.boundingBox())!.width;
      const expandedMain = (await page.locator("main").boundingBox())!;
      await sidebar.getByRole("button", { name: "Collapse sidebar" }).click();
      expect(await sidebar.count()).toBe(0);
      expect(await page.getByRole("separator", { name: "Resize navigation pane" }).count()).toBe(0);
      const reopen = page.getByRole("button", { name: "Expand sidebar" });
      await reopen.waitFor();

      await expect
        .poll(() => reopen.evaluate((element) => element === document.activeElement))
        .toBe(true);

      expect((await page.locator("main").boundingBox())!.width).toBe(
        expandedMain.width + initialWidth + 3,
      );

      expect((await page.locator("main").boundingBox())!.x).toBe(0);
      await page.screenshot({ path: join(screenshots, "sidebar-window-collapsed.png") });
      await reopen.press("Enter");
      await sidebar.waitFor();
      expect((await sidebar.boundingBox())!.width).toBe(initialWidth);

      await expect
        .poll(() =>
          sidebar
            .getByRole("button", { name: "Collapse sidebar" })
            .evaluate((element) => element === document.activeElement),
        )
        .toBe(true);

      expect(await page.getByRole("button", { name: "Expand sidebar" }).count()).toBe(0);

      const windowBounds = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].getBounds(),
      );

      await page.getByRole("button", { name: "Maximize window", exact: true }).click();
      await page.getByRole("button", { name: "Restore window", exact: true }).click();

      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds()),
        )
        .toEqual(windowBounds);

      if (await page.evaluate(() => window.electronWindow.manualDragging)) {
        const drag = (await page.locator(".titlebar-drag-region").boundingBox())!;
        await page.mouse.move(drag.x + 50, drag.y + drag.height / 2);
        await page.mouse.down();
        await page.mouse.move(drag.x + 90, drag.y + drag.height / 2 + 20, { steps: 4 });
        await page.mouse.up();

        await expect
          .poll(() =>
            app.evaluate(({ BrowserWindow }, bounds) => {
              const current = BrowserWindow.getAllWindows()[0].getBounds();
              return current.x !== bounds.x || current.y !== bounds.y;
            }, windowBounds),
          )
          .toBe(true);

        await app.evaluate(
          ({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds),
          windowBounds,
        );
      }

      await page.getByRole("button", { name: "Open command palette" }).click();
      await page.getByRole("dialog", { name: "Command palette" }).waitFor();
      await page.keyboard.press("Escape");
      const search = sidebar.getByRole("searchbox", { name: "Search tasks" });
      expect(await sidebar.getByText("VIBESTAR", { exact: true }).count()).toBe(0);
      await search.fill("no matching task");
      await sidebar.getByText("No tasks match your search.", { exact: true }).waitFor();
      expect(await sidebar.locator(".tree-task").count()).toBe(0);
      await sidebar.screenshot({ path: join(screenshots, "sidebar-search-empty.png") });
      await search.press("Escape");
      expect(await search.inputValue()).toBe("");
      expect(await search.evaluate((element) => element === document.activeElement)).toBe(true);
      await search.press("Tab");

      expect(
        await sidebar
          .getByRole("button", { name: "New task", exact: true })
          .evaluate((element) => element === document.activeElement),
      ).toBe(true);

      await page.keyboard.press("Enter");
      const creation = page.getByRole("dialog", { name: "New Viber task", exact: true });
      await creation.waitFor();
      await creation.getByRole("button", { name: "Close", exact: true }).click();
      expect(engine.db.tasks()).toHaveLength(1);
      expect(await sidebar.locator(".sidebar-working-section").count()).toBe(0);

      const singleRow = sidebar.getByRole("button", {
        name: /Refactor folder structure.*Not started/,
      });

      const singleLayout = await singleRow.locator(".sidebar-task-title").evaluate((element) => ({
        height: element.clientHeight,
        lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
        fullHeight: element.scrollHeight,
        width: element.clientWidth,
        fullWidth: element.scrollWidth,
      }));

      expect(singleLayout.height).toBe(singleLayout.lineHeight);
      expect(singleLayout.fullHeight).toBe(singleLayout.height);
      expect(singleLayout.fullWidth).toBeGreaterThan(singleLayout.width);
      expect(await singleRow.getAttribute("title")).toBe(idle.goal!);
      expect(await singleRow.locator(".sidebar-task-status").count()).toBe(0);
      expect(await singleRow.locator(".sidebar-task-footer").count()).toBe(0);
      expect(await singleRow.locator(".sidebar-task-branch").count()).toBe(0);
      expect(await singleRow.innerText()).not.toContain("Not started");
      await page.mouse.move(600, 400);
      await sidebar.screenshot({ path: join(screenshots, "sidebar-one-task.png") });
      await singleRow.click();
      await page.locator(".flow-editor").waitFor();
      await sidebar.screenshot({ path: join(screenshots, "sidebar-one-task-selected.png") });
      await page.getByRole("button", { name: "Back to tasks", exact: true }).click();

      const normalBackground = await singleRow.evaluate(
        (element) => getComputedStyle(element.parentElement!).backgroundColor,
      );

      await singleRow.hover();

      await expect
        .poll(() => singleRow.evaluate((element) => element.matches(":hover")))
        .toBe(true);

      await expect
        .poll(() =>
          singleRow.evaluate((element) => getComputedStyle(element.parentElement!).backgroundColor),
        )
        .not.toBe(normalBackground);

      await sidebar.screenshot({ path: join(screenshots, "sidebar-one-task-hover.png") });
      await page.mouse.move(600, 400);

      await expect
        .poll(() => singleRow.evaluate((element) => element.matches(":hover")))
        .toBe(false);

      const completed = create("Migrate Playwright acceptance tests");
      await rpc.call("task.lifecycle", { task_id: completed.id, action: "finish" });
      const paused = create("Fix learner dashboard tests");
      engine.db.saveTask({ ...paused, branch_name: "work/learner-dashboard-tests" });
      const failed = create("Improve Viber keyboard UX");
      const active = create("Viber workflow orchestration");
      const queued = create("Inspect repository conventions");
      const archived = create("Archived contribution");
      engine.db.saveTask({ ...archived, archived: true });

      const capture = (task: ReturnType<typeof create>) =>
        engine.flowRuns.createRun({
          flow_id: task.flow_id!,
          task_id: task.id,
          revision: 1,
          request_id: randomUUID(),
          goal: task.goal!,
        });

      const pausedRun = capture(paused);
      engine.flowRuns.setRunStatus(pausedRun.id, "queued", "paused");
      const failedRun = capture(failed);
      engine.flowRuns.setRunStatus(failedRun.id, "queued", "failed", "Fixture failure");
      const activeRun = capture(active);
      engine.flowRuns.setRunStatus(activeRun.id, "queued", "running");
      const activeNode = engine.flowRuns.definition(activeRun.id).nodes[0];

      const attempt = engine.flowRuns.beginAttempt(
        activeRun.id,
        activeNode.id,
        resolveNodeInputs(engine.db, engine.flowRuns, activeRun.id, activeNode.id),
        "fixture-workspace",
      );

      const queuedRun = capture(queued);

      await refresh();
      await sidebar.getByRole("button", { name: "Working, 2" }).waitFor();

      await sidebar
        .getByRole("button", { name: /Viber workflow orchestration.*Implementer/ })
        .waitFor();

      expect(await sidebar.locator(".execution-indicator, .sidebar-task-status").count()).toBe(0);
      expect(await sidebar.getByRole("navigation").getByRole("button").count()).toBe(5);

      expect(
        await sidebar.getByRole("button", { name: /Migrate Playwright.*Completed/ }).count(),
      ).toBe(1);

      expect(await sidebar.locator(".tree-task-menu").count()).toBe(6);

      await search.fill("RUNNING");
      await sidebar.getByRole("button", { name: "Working, 1" }).waitFor();
      expect(await sidebar.getByRole("button", { name: "Tasks, 0" }).count()).toBe(1);
      expect(await sidebar.locator(".tree-task").count()).toBe(1);
      await sidebar.screenshot({ path: join(screenshots, "sidebar-search-running.png") });
      await search.fill("AKKCO-VIBESTAR-TEST");
      await sidebar.getByRole("button", { name: "Tasks, 4" }).waitFor();
      expect(await sidebar.getByRole("button", { name: "Working, 2" }).count()).toBe(1);
      await search.fill("KEYBOARD UX");
      await sidebar.getByRole("button", { name: "Tasks, 1" }).waitFor();
      expect(await sidebar.locator(".sidebar-working-section").count()).toBe(0);
      await search.press("Escape");
      await sidebar.getByRole("button", { name: "Working, 2" }).waitFor();

      const rowLayout = await sidebar
        .getByRole("button", { name: /^Improve Viber keyboard UX/ })
        .evaluate((element) => {
          const title = element.querySelector<HTMLElement>(".sidebar-task-title")!;
          const metadata = element.querySelector<HTMLElement>(".sidebar-task-metadata")!;
          const next = element.parentElement?.nextElementSibling;
          return {
            titleLeft: title.getBoundingClientRect().left,
            titleTop: title.getBoundingClientRect().top,
            titleBottom: title.getBoundingClientRect().bottom,
            metadataLeft: metadata.getBoundingClientRect().left,
            metadataTop: metadata.getBoundingClientRect().top,
            metadataBottom: metadata.getBoundingClientRect().bottom,
            layers: element.children.length,
            titleSize: Number.parseFloat(getComputedStyle(title).fontSize),
            metadataSize: Number.parseFloat(getComputedStyle(metadata).fontSize),
            rowHeight: element.getBoundingClientRect().height,
            rowGap: next!.getBoundingClientRect().top - element.getBoundingClientRect().bottom,
            selectionMarker: getComputedStyle(element.parentElement!, "::before").content,
            separator: getComputedStyle(element.parentElement!, "::after").content,
          };
        });

      expect(rowLayout.metadataLeft).toBe(rowLayout.titleLeft);
      expect(rowLayout.metadataBottom).toBeLessThanOrEqual(rowLayout.titleTop);
      expect(rowLayout.layers).toBe(2);
      expect(rowLayout.titleSize).toBeGreaterThan(rowLayout.metadataSize);
      expect(rowLayout.rowHeight).toBeLessThanOrEqual(50);
      expect(rowLayout.rowGap).toBeLessThanOrEqual(2);
      expect(rowLayout.selectionMarker).toBe("none");
      expect(rowLayout.separator).toBe("none");

      const ageLayout = await sidebar
        .getByRole("button", { name: /Viber workflow orchestration.*Implementer/ })
        .evaluate((element) => {
          const metadata = element.querySelector<HTMLElement>(".sidebar-task-metadata")!;
          const age = element.querySelector<HTMLElement>(".sidebar-task-age")!;
          return {
            metadataRight: metadata.getBoundingClientRect().right,
            ageRight: age.getBoundingClientRect().right,
          };
        });

      expect(ageLayout.ageRight).toBe(ageLayout.metadataRight);

      const branchRow = sidebar.getByRole("button", {
        name: /^Fix learner dashboard tests/,
      });

      const branch = branchRow.locator(".sidebar-task-branch");
      expect(await branch.innerText()).toBe("work/learner-dashboard-tests");

      expect((await branch.boundingBox())!.y).toBeGreaterThan(
        (await branchRow.locator(".sidebar-task-title").boundingBox())!.y,
      );

      expect((await branch.boundingBox())!.x).toBe(
        (await branchRow.locator(".sidebar-task-title").boundingBox())!.x,
      );

      expect(await sidebar.locator(".sidebar-task-footer").count()).toBe(0);

      const working = sidebar.locator(".sidebar-working-section");
      const expandedHeight = (await working.boundingBox())!.height;
      const dock = sidebar.locator(".sidebar-tools");
      const dockY = (await dock.boundingBox())!.y;
      await sidebar.screenshot({ path: join(screenshots, "sidebar-expanded.png") });
      await page.screenshot({ path: join(screenshots, "sidebar-window-1280.png") });
      await sidebar.getByRole("button", { name: "Working, 2" }).click();
      expect((await working.boundingBox())!.height).toBe(32);
      expect(expandedHeight).toBeGreaterThan(32);
      expect(expandedHeight).toBeLessThanOrEqual(152);
      expect((await dock.boundingBox())!.y).toBe(dockY);
      await sidebar.screenshot({ path: join(screenshots, "sidebar-working-collapsed.png") });
      await sidebar.getByRole("button", { name: "Tasks, 4" }).click();
      await sidebar.screenshot({ path: join(screenshots, "sidebar-both-collapsed.png") });
      await sidebar.getByRole("button", { name: "Working, 2" }).click();
      await sidebar.screenshot({ path: join(screenshots, "sidebar-tasks-collapsed.png") });
      await sidebar.getByRole("button", { name: "Tasks, 4" }).click();

      const idleRow = sidebar.getByRole("button", {
        name: /Refactor folder structure.*Not started/,
      });

      await idleRow.click();
      await page.locator(".flow-editor").waitFor();
      expect(await idleRow.getAttribute("aria-current")).toBe("page");

      expect(
        await idleRow.evaluate(
          (element) => getComputedStyle(element.parentElement!, "::before").content,
        ),
      ).toBe("none");

      expect(await idleRow.getAttribute("title")).toContain("Refactor folder structure");
      await page.mouse.move(600, 400);
      await sidebar.screenshot({ path: join(screenshots, "sidebar-selected.png") });
      await idleRow.focus();
      await page.keyboard.press("Shift+F10");
      const menu = page.getByRole("menu");
      await menu.waitFor();
      await page.keyboard.press("End");

      expect(
        await page
          .getByRole("menuitem", { name: "Manage task…" })
          .evaluate((element) => element === document.activeElement),
      ).toBe(true);

      await page.keyboard.press("Escape");
      expect(await idleRow.evaluate((element) => element === document.activeElement)).toBe(true);
      await idleRow.click({ button: "right" });
      await menu.getByRole("menuitem", { name: "Copy task branch" }).waitFor();
      await page.keyboard.press("Escape");
      await sidebar.getByRole("button", { name: "Show archived tasks" }).click();
      await sidebar.getByRole("button", { name: /Archived contribution.*Archived/ }).waitFor();
      await sidebar.getByRole("button", { name: "Hide archived tasks" }).click();

      const resize = page.getByRole("separator", { name: "Resize navigation pane" });
      await resize.focus();
      for (let index = 0; index < 5; index++) await page.keyboard.press("ArrowLeft");
      expect(await resize.getAttribute("aria-valuenow")).toBe("180");

      expect(
        await sidebar.locator(".sidebar-task-title").evaluateAll((elements) =>
          elements.every((element) => {
            const style = getComputedStyle(element);
            return (
              style.whiteSpace === "nowrap" &&
              element.clientHeight === Number.parseFloat(style.lineHeight)
            );
          }),
        ),
      ).toBe(true);

      await sidebar.screenshot({ path: join(screenshots, "sidebar-180.png") });
      await search.fill("keyboard");
      await sidebar.getByRole("button", { name: "Tasks, 1" }).waitFor();

      expect(await sidebar.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );

      await sidebar.screenshot({ path: join(screenshots, "sidebar-search-180.png") });
      await search.press("Escape");
      expect(await idleRow.getAttribute("aria-current")).toBe("page");
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 540));

      expect(await sidebar.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );

      await sidebar.screenshot({ path: join(screenshots, "sidebar-800x540.png") });

      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1280, 720),
      );

      const handle = (await resize.boundingBox())!;
      await page.mouse.move(handle.x + 1, handle.y + 60);
      await page.mouse.down();
      await page.mouse.move(handle.x + 101, handle.y + 60);
      await page.mouse.up();
      expect(Number(await resize.getAttribute("aria-valuenow"))).toBeGreaterThan(250);

      await resize.focus();
      for (let index = 0; index < 7; index++) await page.keyboard.press("ArrowRight");
      expect(await resize.getAttribute("aria-valuenow")).toBe("380");
      await sidebar.screenshot({ path: join(screenshots, "sidebar-380.png") });
      await page.screenshot({ path: join(screenshots, "sidebar-window-380.png") });
      await sidebar.getByRole("button", { name: "Collapse sidebar" }).click();
      await page.screenshot({ path: join(screenshots, "sidebar-workspace-collapsed.png") });
      await page.getByRole("button", { name: "Expand sidebar" }).click();
      expect(await resize.getAttribute("aria-valuenow")).toBe("380");

      const titleOverflow = await sidebar
        .getByRole("button", { name: /Refactor folder structure.*Not started/ })
        .evaluate((element) => {
          const title = element.querySelector<HTMLElement>(".sidebar-task-title")!;
          return {
            whiteSpace: getComputedStyle(title).whiteSpace,
            overflow: getComputedStyle(title).overflow,
            textOverflow: getComputedStyle(title).textOverflow,
            height: title.clientHeight,
            lineHeight: Number.parseFloat(getComputedStyle(title).lineHeight),
            width: title.clientWidth,
            fullWidth: title.scrollWidth,
            tooltip: element.getAttribute("title"),
          };
        });

      expect(titleOverflow.whiteSpace).toBe("nowrap");
      expect(titleOverflow.overflow).toBe("hidden");
      expect(titleOverflow.textOverflow).toBe("ellipsis");
      expect(titleOverflow.height).toBe(titleOverflow.lineHeight);
      expect(titleOverflow.fullWidth).toBeGreaterThan(titleOverflow.width);
      expect(titleOverflow.tooltip).toBe(idle.goal);

      await page.emulateMedia({ reducedMotion: "reduce" });

      await dock.getByRole("button", { name: "Settings" }).hover();

      expect(
        await dock
          .getByRole("button", { name: "Settings" })
          .evaluate((element) => getComputedStyle(element).transform),
      ).toBe("none");

      const selectedBackground = await idleRow.evaluate(
        (element) => getComputedStyle(element.parentElement!).backgroundColor,
      );

      await page.evaluate(() => {
        document.documentElement.style.setProperty("--accent", "#e89854");
      });

      expect(
        await idleRow.evaluate(
          (element) => getComputedStyle(element.parentElement!).backgroundColor,
        ),
      ).toBe(selectedBackground);

      expect(
        await idleRow.evaluate(
          (element) => getComputedStyle(element.parentElement!, "::before").content,
        ),
      ).toBe("none");

      await page.evaluate(() => {
        document.documentElement.style.setProperty("--background-sidebar", "#202223");
        document.documentElement.style.setProperty("--foreground", "#f5f0e9");
      });

      await dock.getByRole("button", { name: "Settings" }).click();

      expect(await sidebar.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
        "rgb(32, 34, 35)",
      );

      expect(
        await dock
          .getByRole("button", { name: "Settings" })
          .evaluate((element) => getComputedStyle(element).color),
      ).toBe("rgb(232, 152, 84)");

      await page
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("button", { name: "Repositories", exact: true })
        .click();

      await page.getByRole("textbox", { name: "Search repositories", exact: true }).waitFor();

      await page
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("button", { name: "Providers", exact: true })
        .click();

      await page.getByRole("heading", { name: "Providers", exact: true }).waitFor();
      await page.getByRole("button", { name: "Close Settings", exact: true }).click();
      await sidebar.screenshot({ path: join(screenshots, "sidebar-custom-theme.png") });

      await page.evaluate(() => {
        for (const token of ["--accent", "--background-sidebar", "--foreground"])
          document.documentElement.style.removeProperty(token);
      });

      for (let index = 0; index < 35; index++)
        create(`Saved development task ${index + 1} with a long descriptive title`);
      await refresh();
      await sidebar.getByRole("button", { name: "Tasks, 39" }).waitFor();

      expect(
        await sidebar
          .locator(".sidebar-task-section .sidebar-task-list")
          .evaluate((element) => element.scrollHeight > element.clientHeight),
      ).toBe(true);

      expect((await dock.boundingBox())!.y).toBe(dockY);

      const taskList = sidebar.locator(".sidebar-task-section .sidebar-task-list");

      expect(await taskList.evaluate((element) => getComputedStyle(element).scrollbarWidth)).toBe(
        "none",
      );

      expect(
        await taskList.evaluate(
          (element) => getComputedStyle(element, "::-webkit-scrollbar").display,
        ),
      ).toBe("none");

      await taskList.evaluate((element) => {
        element.scrollTop = 0;
      });

      await taskList.hover();
      await page.mouse.wheel(0, 360);
      await expect.poll(() => taskList.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await taskList.locator(".tree-task").first().focus();
      expect(await taskList.evaluate((element) => element.scrollTop)).toBe(0);
      for (let index = 0; index < 26; index++) await page.keyboard.press("Tab");
      expect(await taskList.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      expect((await dock.boundingBox())!.y).toBe(dockY);

      await sidebar
        .getByRole("button", { name: /^Saved development task 1 / })
        .scrollIntoViewIfNeeded();

      expect(await sidebar.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );

      await sidebar.screenshot({ path: join(screenshots, "sidebar-long-list.png") });

      const extra = Array.from({ length: 8 }, (_, index) =>
        capture(create(`Queued background work ${index + 1}`)),
      );

      await refresh();
      await sidebar.getByRole("button", { name: "Working, 10" }).waitFor();

      expect(
        await working
          .locator(".sidebar-task-list")
          .evaluate((element) => element.scrollHeight > element.clientHeight),
      ).toBe(true);

      expect((await dock.boundingBox())!.y).toBe(dockY);
      const savedScroll = await taskList.evaluate((element) => element.scrollTop);
      const workingList = working.locator(".sidebar-task-list");
      await workingList.hover();
      await page.mouse.wheel(0, 400);

      await expect
        .poll(() => workingList.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);

      expect(await taskList.evaluate((element) => element.scrollTop)).toBe(savedScroll);
      await sidebar.screenshot({ path: join(screenshots, "sidebar-many-working.png") });
      for (const run of extra) engine.flowRuns.setRunStatus(run.id, "queued", "cancelled");
      engine.flowRuns.finishAttempt(attempt.id, "cancelled", null, "missing");
      engine.flowRuns.setRunStatus(activeRun.id, "running", "paused");
      engine.flowRuns.setRunStatus(queuedRun.id, "queued", "cancelled");
      await refresh();
      await expect.poll(() => working.count()).toBe(0);
      expect(await sidebar.getByRole("button", { name: "Tasks, 49" }).count()).toBe(1);
      expect(await sidebar.locator(".execution-indicator").count()).toBe(0);
      await sidebar.screenshot({ path: join(screenshots, "sidebar-no-working.png") });
      await sidebar.getByRole("button", { name: "Tasks, 49" }).click();
      await page.keyboard.press("Control+b");
      expect(await sidebar.count()).toBe(0);
      await page.keyboard.press("Control+b");

      expect(
        await sidebar.getByRole("button", { name: "Tasks, 49" }).getAttribute("aria-expanded"),
      ).toBe("false");

      expect(errors).toEqual([]);
      console.log(`Sidebar Electron screenshots: ${screenshots}`);
    } catch (error) {
      const page = await app.firstWindow();
      await page.screenshot({ path: join(screenshots, "failure.png") }).catch(() => {});
      console.log(`Sidebar failure screenshot: ${screenshots}`);
      throw error;
    } finally {
      await app.close();
      await rpc.close();
      await engine.close();
      if (!process.env.VIBESTAR_KEEP_EVIDENCE) await rm(dir, { recursive: true, force: true });
    }
  },
  90000,
);
