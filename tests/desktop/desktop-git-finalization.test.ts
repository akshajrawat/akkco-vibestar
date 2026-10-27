import { expect, it } from "vitest";
import { _electron } from "playwright-core";

import { createRequire } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Rpc } from "../../backend/rpc";
import { checked, execute } from "../../backend/execution/runtime/process";
import { createFixtureEngine, FixtureProvider } from "../helpers/fixtures";
import { finalizationFixture } from "../finalization/fixtures";

const require = createRequire(import.meta.url);

it.skipIf(process.env.VIBESTAR_GIT_DESKTOP_TEST !== "1")(
  "selects, independently reviews, commits and confirms publication through built Electron with saved history",
  async () => {
    const f = await finalizationFixture();

    f.engine.db.saveTask({
      ...f.task,
      claimed_scope: "Git delivery fixture",
      status: "completed",
    });

    const sourceIndex = await readFile(join(f.repo.path, ".git", "index"));
    const sourceBytes = await readFile(join(f.repo.path, "source.txt"));
    await writeFile(join(f.task.worktree_path, "deleted.txt"), "unrelated staged content\n");
    await checked("git", ["add", "--", "deleted.txt"], f.task.worktree_path);
    await writeFile(join(f.task.worktree_path, ".env"), "FIXTURE=private\n");
    await writeFile(join(f.task.worktree_path, "debug.log"), "unrelated fixture diagnostics\n");

    const taskIndex = await readFile(
      await checked("git", ["rev-parse", "--git-path", "index"], f.task.worktree_path),
    );

    const rpc = new Rpc(f.engine, undefined, undefined, undefined, f.service);
    const emptyRoot = join(f.dir, "empty-core");
    const empty = await createFixtureEngine(emptyRoot);
    await empty.close();
    const home = join(f.dir, "isolated-home");
    const blockedCli = join(f.dir, "blocked-cli");
    const screenshots = join(f.dir, "screenshots");
    for (const path of [home, blockedCli, screenshots]) await mkdir(path);
    for (const name of ["codex", "agy", "gh"])
      await writeFile(
        join(blockedCli, name),
        "#!/bin/sh\necho 'Live service disabled in fixture' >&2\nexit 1\n",
        { mode: 0o755 },
      );

    const app = await _electron.launch({
      executablePath: require("electron") as string,
      args: [resolve(".")],
      env: {
        ...process.env,
        HOME: home,
        PATH: `${blockedCli}:${process.env.PATH}`,
        VIBESTAR_HOME: emptyRoot,
        VIBESTAR_USER_DATA: join(f.dir, "profile"),
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

      await page.exposeFunction("fixtureRpc", async (method: string, params: unknown) =>
        method === "providers.detect"
          ? await Promise.all(
              ["antigravity", "codex", "github"].map(async (provider) => ({
                ...(await new FixtureProvider().detect()),
                provider,
              })),
            )
          : rpc.call(method, params),
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

      forward = (event) => {
        void app
          .evaluate(
            ({ BrowserWindow }, event) =>
              BrowserWindow.getAllWindows()[0]?.webContents.send("core:event", event),
            event,
          )
          .catch(() => {});
      };

      f.engine.on("event", forward);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.locator(".task-card").filter({ hasText: "Git delivery fixture" }).click();

      const secondaryToggle = page.getByRole("button", {
        name: "Toggle secondary workspace",
        exact: true,
      });

      if ((await secondaryToggle.getAttribute("aria-expanded")) === "true")
        await secondaryToggle.click();
      for (const [width, height] of [
        [1280, 720],
        [1440, 900],
        [1920, 1080],
      ]) {
        await app.evaluate(
          ({ BrowserWindow }, size) =>
            BrowserWindow.getAllWindows()[0].setSize(...(size as [number, number])),
          [width, height],
        );

        await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);

        await expect
          .poll(async () => {
            const action = await page
              .locator(".chat-actions")
              .getByRole("button", { name: "Git Changes", exact: true })
              .boundingBox();

            const composer = await page.locator(".chat-input").boundingBox();
            return Math.abs(action!.x - composer!.x);
          })
          .toBeLessThan(2);

        await page.screenshot({
          animations: "disabled",
          path: join(screenshots, `git-action-collapsed-${width}x${height}.png`),
        });
      }

      await page
        .locator(".chat-actions")
        .getByRole("button", { name: "Git Changes", exact: true })
        .click();

      const dialog = page.getByRole("dialog", {
        name: /^(Git Changes|Selected changes review)$/,
      });

      await dialog.getByText("source.txt", { exact: true }).waitFor();
      expect(await dialog.getByRole("checkbox", { name: /source.txt/ }).isChecked()).toBe(true);
      expect(await dialog.getByRole("checkbox", { name: /deleted.txt/ }).isChecked()).toBe(false);
      expect(await dialog.getByRole("checkbox", { name: /\.env/ }).isDisabled()).toBe(true);
      expect(await dialog.getByRole("checkbox", { name: /debug.log/ }).isDisabled()).toBe(true);
      expect(f.engine.db.all("SELECT id FROM ai_usage")).toHaveLength(0);
      await page.emulateMedia({ reducedMotion: "reduce" });

      expect(
        await dialog.evaluate((node) =>
          getComputedStyle(node)
            .animationDuration.split(",")
            .every((value) => parseFloat(value) <= 0.001),
        ),
      ).toBe(true);

      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.evaluate(() => document.fonts.ready);
      for (const [width, height] of [
        [1920, 1080],
        [1440, 900],
        [1280, 720],
      ]) {
        await app.evaluate(
          ({ BrowserWindow }, size) =>
            BrowserWindow.getAllWindows()[0].setSize(...(size as [number, number])),
          [width, height],
        );

        await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
        expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);

        await page.screenshot({
          path: join(screenshots, `git-files-${width}x${height}.png`),
        });
      }

      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1440, 900),
      );

      expect(await dialog.getByRole("button", { name: "View diff & review" }).count()).toBe(0);
      expect(await dialog.getByRole("button", { name: "Mark task complete" }).count()).toBe(0);
      await dialog.getByLabel("Exact Git commit message").fill("Review selected subset");
      await dialog.getByRole("button", { name: "Commit", exact: true }).click();
      await dialog.getByRole("button", { name: "Open selected changes review" }).click();
      await dialog.getByRole("button", { name: "View diff & review" }).click();
      await dialog.getByRole("button", { name: "Review selection with Antigravity" }).click();

      await expect
        .poll(() => f.service.store.list(f.task.id)[0]?.review?.approval, {
          timeout: 30000,
        })
        .toBe("approved");

      await expect.poll(() => f.engine.isActive(f.task.id), { timeout: 30000 }).toBe(false);

      expect(
        await readFile(
          await checked("git", ["rev-parse", "--git-path", "index"], f.task.worktree_path),
        ),
      ).toEqual(taskIndex);

      await dialog.getByRole("button", { name: "Approve selected files" }).click();

      await expect
        .poll(() => f.service.store.list(f.task.id)[0]?.status, {
          timeout: 30000,
        })
        .toBe("approved");

      await dialog.getByRole("button", { name: "Back to Git Changes" }).click();
      const message = "  Exact desktop contribution  \n\n# Literal message text  ";
      await dialog.getByLabel("Exact Git commit message").fill(message);
      await dialog.getByRole("button", { name: "Commit", exact: true }).click();

      await dialog
        .getByRole("checkbox", { name: "I confirm these files, exact message and local commit." })
        .check();

      await page.screenshot({ path: join(screenshots, "git-exact-message.png") });
      await dialog.getByRole("button", { name: "Confirm commit", exact: true }).click();

      await expect
        .poll(() => f.service.store.list(f.task.id)[0]?.status, { timeout: 30000 })
        .toBe("committed");

      await dialog.getByRole("button", { name: "Push", exact: true }).click();

      await dialog
        .getByRole("region", { name: "Confirm Git operation" })
        .getByText("contributor/fixture", { exact: true })
        .waitFor();

      await dialog
        .getByRole("checkbox", { name: "I confirm these files, exact message and destination." })
        .scrollIntoViewIfNeeded();

      await expect
        .poll(() => dialog.getByRole("button", { name: "Keep local and close" }).isEnabled(), {
          timeout: 30000,
        })
        .toBe(true);

      const record = f.service.store.list(f.task.id)[0];

      const object = await execute({
        program: "git",
        args: ["cat-file", "commit", record.head!],
        cwd: f.task.worktree_path,
      });

      expect(object.stdout.slice(object.stdout.indexOf("\n\n") + 2)).toBe(message);
      expect(await dialog.getByRole("button", { name: "Confirm push" }).isDisabled()).toBe(true);

      await page.screenshot({
        path: join(screenshots, "git-destination-confirmation.png"),
      });

      await dialog
        .getByRole("checkbox", {
          name: "I confirm these files, exact message and destination.",
        })
        .check();

      await dialog.getByRole("button", { name: "Confirm push" }).click();
      await dialog.getByText("Push verified against the remote branch.").waitFor();

      expect(await checked("git", ["rev-parse", `refs/heads/${f.task.branch_name}`], f.fork)).toBe(
        record.head,
      );

      expect(
        await checked("git", ["show", `${record.head}:deleted.txt`], f.task.worktree_path),
      ).toBe("delete me");

      expect(await checked("git", ["show", ":deleted.txt"], f.task.worktree_path)).toBe(
        "unrelated staged content",
      );

      await expect
        .poll(() => dialog.getByRole("button", { name: "Keep local and close" }).isEnabled(), {
          timeout: 30000,
        })
        .toBe(true);

      await page.screenshot({ path: join(screenshots, "git-published.png") });
      await dialog.getByRole("button", { name: "Keep local and close" }).click();

      await page
        .locator(".chat-actions")
        .getByRole("button", { name: "Git Changes", exact: true })
        .click();

      await dialog.getByText("Push verified against the remote branch.").waitFor();
      await dialog.getByText("Saved operation log and recovery", { exact: true }).click();

      expect(
        await dialog.getByLabel("Saved Git operation history").getAttribute("data-value"),
      ).toBe(record.id);

      expect(
        f.engine.db.all("SELECT id FROM agent_runs WHERE purpose='git-finalization-review'"),
      ).toHaveLength(1);

      expect(await readFile(join(f.repo.path, ".git", "index"))).toEqual(sourceIndex);
      expect(await readFile(join(f.repo.path, "source.txt"))).toEqual(sourceBytes);
      await dialog.getByRole("button", { name: "Keep local and close" }).click();
      if ((await secondaryToggle.getAttribute("aria-expanded")) !== "true")
        await secondaryToggle.click();
      await page.getByRole("button", { name: "Expand workspace tool", exact: true }).click();
      await page.emulateMedia({ reducedMotion: "reduce" });
      const panelBounds: { x: number; width: number }[] = [];

      for (const tab of ["Checks", "Final review"]) {
        await page.getByRole("tab", { name: tab, exact: true }).click();
        const panel = page.locator(tab === "Checks" ? ".tests-panel" : ".final-review-panel");
        await panel.waitFor();

        const bounds = await panel.boundingBox();
        panelBounds.push({ x: bounds!.x, width: bounds!.width });

        const spacing = await panel.evaluate((node) => ({
          left: parseFloat(getComputedStyle(node).paddingLeft),
          top: parseFloat(getComputedStyle(node).paddingTop),
          overflow: node.scrollWidth > node.clientWidth,
        }));

        expect(spacing.left).toBeGreaterThanOrEqual(20);
        expect(spacing.top).toBeGreaterThanOrEqual(24);
        expect(spacing.overflow).toBe(false);

        await page.screenshot({
          path: join(screenshots, `aligned-${tab.replaceAll(" ", "-")}.png`),
        });
      }

      expect(Math.abs(panelBounds[0].x - panelBounds[1].x)).toBeLessThan(2);
      expect(Math.abs(panelBounds[0].width - panelBounds[1].width)).toBeLessThan(2);
      await page.getByRole("button", { name: "New task", exact: true }).click();
      const newTask = page.getByRole("dialog", { name: "New task", exact: true });
      await newTask.getByRole("combobox", { name: "Repository", exact: true }).click();
      const search = page.locator(".select-search input");
      await search.waitFor();

      expect(
        await search.evaluate((node) => ({
          outline: getComputedStyle(node).outlineStyle,
          shadow: getComputedStyle(node).boxShadow,
        })),
      ).toEqual({ outline: "none", shadow: "none" });

      await page.screenshot({ path: join(screenshots, "repository-picker.png") });
      await page.keyboard.press("Escape");
      await newTask.getByText("Agent configuration", { exact: true }).click();

      const alignment = await newTask
        .locator(".config-block")
        .first()
        .locator("label")
        .evaluateAll((labels) =>
          labels.map((label) => label.querySelector("input, button")!.getBoundingClientRect().y),
        );

      expect(Math.max(...alignment) - Math.min(...alignment)).toBeLessThan(2);
      expect(await newTask.locator(".config-block h3 img").count()).toBe(4);
      await page.screenshot({ path: join(screenshots, "agent-configuration.png") });
      await newTask.getByRole("combobox", { name: "Model", exact: true }).first().click();
      await page.locator(".select-search input").fill("next");
      await page.keyboard.press("ArrowDown");
      await page.screenshot({ path: join(screenshots, "model-picker.png") });
      await page.keyboard.press("Escape");
      await newTask.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("button", { name: "Providers", exact: true }).click();
      await page.locator(".provider-row").first().waitFor();

      const centered = await page.locator(".provider-list").evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        const parent = node.parentElement!.getBoundingClientRect();
        return Math.abs(bounds.x - parent.x - (parent.right - bounds.right));
      });

      expect(centered).toBeLessThan(2);
      expect(await page.locator(".provider-icon img").count()).toBe(3);
      await page.screenshot({ path: join(screenshots, "providers-centered.png") });
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const settingsNav = page.getByRole("navigation", { name: "Settings sections" });
      await settingsNav.getByRole("button", { name: "Agents & Models", exact: true }).click();
      await page.screenshot({ path: join(screenshots, "settings-agents.png") });
      await settingsNav.getByRole("button", { name: "Execution", exact: true }).click();
      const fields = page.locator(".settings-fields");

      const positions = await fields
        .locator("label")
        .evaluateAll((labels) =>
          labels
            .slice(0, 2)
            .map((label) => label.querySelector("input, button")!.getBoundingClientRect().y),
        );

      expect(Math.abs(positions[0] - positions[1])).toBeLessThan(2);
      await page.screenshot({ path: join(screenshots, "settings-execution.png") });
      await settingsNav.getByRole("button", { name: "Repositories", exact: true }).click();
      const advanced = page.locator(".discovery-advanced");

      expect(
        await advanced.evaluate((node) => parseFloat(getComputedStyle(node).marginTop)),
      ).toBeGreaterThanOrEqual(20);

      expect(
        await advanced.evaluate((node) => parseFloat(getComputedStyle(node).marginBottom)),
      ).toBeGreaterThanOrEqual(20);

      await page.screenshot({ path: join(screenshots, "settings-discovery.png") });
      expect(errors).toEqual([]);

      await writeFile(
        join(screenshots, "results.json"),
        JSON.stringify(
          {
            record: f.service.store.get(f.task.id, record.id),
            events: f.service.store.events(record.id),
            rendererErrors: errors,
            sourceUnchanged: true,
            fixtureReviewRuns: 1,
            realInference: false,
            realGithubWrites: false,
          },
          null,
          2,
        ),
      );

      process.stdout.write(`Git Finalization Electron evidence: ${screenshots}\n`);
    } catch (error) {
      const page = await app.firstWindow();
      await page.screenshot({ path: join(screenshots, "failure.png") }).catch(() => {});
      throw error;
    } finally {
      if (forward) f.engine.off("event", forward);
      await app.close();
      await rpc.close();
      await f.engine.close();
      if (process.env.VIBESTAR_KEEP_EVIDENCE !== "1")
        await rm(f.dir, { recursive: true, force: true });
    }
  },
  120000,
);
