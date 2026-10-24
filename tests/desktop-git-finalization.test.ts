import { expect, it } from "vitest";
import { _electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Rpc } from "../backend/rpc";
import { checked, execute } from "../backend/execution/process";
import { createFixtureEngine, FixtureProvider } from "./fixtures";
import { finalizationFixture } from "./finalization/fixtures";

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
    await writeFile(
      join(f.task.worktree_path, "deleted.txt"),
      "unrelated staged content\n",
    );
    await checked("git", ["add", "--", "deleted.txt"], f.task.worktree_path);
    await writeFile(join(f.task.worktree_path, ".env"), "FIXTURE=private\n");
    await writeFile(
      join(f.task.worktree_path, "debug.log"),
      "unrelated fixture diagnostics\n",
    );
    const taskIndex = await readFile(
      await checked(
        "git",
        ["rev-parse", "--git-path", "index"],
        f.task.worktree_path,
      ),
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
            ({ BrowserWindow }, event) =>
              BrowserWindow.getAllWindows()[0]?.webContents.send(
                "core:event",
                event,
              ),
            event,
          )
          .catch(() => {});
      };
      f.engine.on("event", forward);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page
        .locator(".task-card")
        .filter({ hasText: "Git delivery fixture" })
        .click();
      await page
        .locator(".chat-actions")
        .getByRole("button", { name: "Git Finalization", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Git Finalization",
        exact: true,
      });
      await dialog.getByText("source.txt", { exact: true }).waitFor();
      expect(
        await dialog.getByRole("checkbox", { name: /source.txt/ }).isChecked(),
      ).toBe(true);
      expect(
        await dialog.getByRole("checkbox", { name: /deleted.txt/ }).isChecked(),
      ).toBe(false);
      expect(
        await dialog.getByRole("checkbox", { name: /\.env/ }).isDisabled(),
      ).toBe(true);
      expect(
        await dialog.getByRole("checkbox", { name: /debug.log/ }).isDisabled(),
      ).toBe(true);
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
            BrowserWindow.getAllWindows()[0].setSize(
              ...(size as [number, number]),
            ),
          [width, height],
        );
        await expect
          .poll(() => page.evaluate(() => window.innerWidth))
          .toBe(width);
        expect(
          await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
        ).toBe(true);
        await page.screenshot({
          path: join(screenshots, `git-files-${width}x${height}.png`),
        });
      }
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1440, 900),
      );
      await dialog
        .getByRole("button", { name: "Prepare staged preview" })
        .click();
      await dialog
        .getByRole("button", { name: "Review selection with Antigravity" })
        .click();
      await expect
        .poll(() => f.service.store.list(f.task.id)[0]?.review?.approval, {
          timeout: 30000,
        })
        .toBe("approved");
      await expect
        .poll(() => f.engine.isActive(f.task.id), { timeout: 30000 })
        .toBe(false);
      expect(
        await readFile(
          await checked(
            "git",
            ["rev-parse", "--git-path", "index"],
            f.task.worktree_path,
          ),
        ),
      ).toEqual(taskIndex);
      await dialog
        .getByRole("button", { name: "Approve selected files" })
        .click();
      await expect
        .poll(() => f.service.store.list(f.task.id)[0]?.status, {
          timeout: 30000,
        })
        .toBe("approved");
      const message =
        "  Exact desktop contribution  \n\n# Literal message text  ";
      await dialog.getByLabel("Exact Git commit message").fill(message);
      await dialog
        .getByRole("checkbox", {
          name: "I confirm this exact message and the approved selected files.",
        })
        .check();
      await page.screenshot({
        path: join(screenshots, "git-exact-message.png"),
      });
      await dialog
        .getByRole("button", { name: "Commit and prepare push" })
        .click();
      await expect
        .poll(() => f.service.store.list(f.task.id)[0]?.status, {
          timeout: 30000,
        })
        .toBe("prepared");
      await dialog.getByText("contributor/fixture", { exact: true }).waitFor();
      await dialog
        .getByRole("checkbox", {
          name: "Publish this exact commit to the repository and branch shown above.",
        })
        .scrollIntoViewIfNeeded();
      await expect
        .poll(
          () =>
            dialog
              .getByRole("button", { name: "Keep local and close" })
              .isEnabled(),
          { timeout: 30000 },
        )
        .toBe(true);
      const record = f.service.store.list(f.task.id)[0];
      const object = await execute({
        program: "git",
        args: ["cat-file", "commit", record.head!],
        cwd: f.task.worktree_path,
      });
      expect(object.stdout.slice(object.stdout.indexOf("\n\n") + 2)).toBe(
        message,
      );
      expect(
        await dialog.getByRole("button", { name: "Confirm push" }).isDisabled(),
      ).toBe(true);
      await page.screenshot({
        path: join(screenshots, "git-destination-confirmation.png"),
      });
      await dialog
        .getByRole("checkbox", {
          name: "Publish this exact commit to the repository and branch shown above.",
        })
        .check();
      await dialog.getByRole("button", { name: "Confirm push" }).click();
      await dialog
        .getByText("Push verified against the remote branch.")
        .waitFor();
      expect(
        await checked(
          "git",
          ["rev-parse", `refs/heads/${f.task.branch_name}`],
          f.fork,
        ),
      ).toBe(record.head);
      expect(
        await checked(
          "git",
          ["show", `${record.head}:deleted.txt`],
          f.task.worktree_path,
        ),
      ).toBe("delete me");
      expect(
        await checked("git", ["show", ":deleted.txt"], f.task.worktree_path),
      ).toBe("unrelated staged content");
      await expect
        .poll(
          () =>
            dialog
              .getByRole("button", { name: "Keep local and close" })
              .isEnabled(),
          { timeout: 30000 },
        )
        .toBe(true);
      await page.screenshot({ path: join(screenshots, "git-published.png") });
      await dialog
        .getByRole("button", { name: "Keep local and close" })
        .click();
      await page
        .locator(".chat-actions")
        .getByRole("button", { name: "Git Finalization", exact: true })
        .click();
      await dialog
        .getByText("Push verified against the remote branch.")
        .waitFor();
      expect(
        await dialog.getByLabel("Saved Git operation history").inputValue(),
      ).toBe(record.id);
      expect(
        f.engine.db.all(
          "SELECT id FROM agent_runs WHERE purpose='git-finalization-review'",
        ),
      ).toHaveLength(1);
      expect(await readFile(join(f.repo.path, ".git", "index"))).toEqual(
        sourceIndex,
      );
      expect(await readFile(join(f.repo.path, "source.txt"))).toEqual(
        sourceBytes,
      );
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
      process.stdout.write(
        `Git Finalization Electron evidence: ${screenshots}\n`,
      );
    } catch (error) {
      const page = await app.firstWindow();
      await page
        .screenshot({ path: join(screenshots, "failure.png") })
        .catch(() => {});
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
