import { it, expect } from "vitest";
import { _electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createFixtureEngine } from "../helpers/fixtures";

const require = createRequire(import.meta.url);

// Requires a window manager; the separate Windows harness verifies native Windows behavior.
it.skipIf(process.env.VIBESTAR_WINDOW_DESKTOP_TEST !== "1")(
  "verifies native window controls without providers or GitHub accounts",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-desktop-window-"));
    const home = join(dir, "home");
    const blocked = join(dir, "blocked-cli");
    await Promise.all([mkdir(home), mkdir(blocked)]);
    for (const program of ["gh", "agy", "codex"])
      await writeFile(join(blocked, program), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const core = await createFixtureEngine(join(dir, "data"));
    await core.close();

    const app = await _electron.launch({
      executablePath: require("electron") as string,
      args: [resolve(".")],
      env: {
        ...process.env,
        HOME: home,
        PATH: `${blocked}:${process.env.PATH}`,
        VIBESTAR_HOME: join(dir, "data"),
        VIBESTAR_USER_DATA: join(dir, "profile"),
      },
    });

    try {
      const page = await app.firstWindow();
      page.setDefaultTimeout(15000);
      await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();

      expect(
        await app.evaluate(({ Menu, BrowserWindow }) => ({
          menu: Menu.getApplicationMenu() === null,
          resizable: BrowserWindow.getAllWindows()[0].isResizable(),
          maximizable: BrowserWindow.getAllWindows()[0].isMaximizable(),
          fullscreenable: BrowserWindow.getAllWindows()[0].isFullScreenable(),
        })),
      ).toMatchObject({ menu: true, resizable: true, fullscreenable: true });

      const normal = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].getBounds(),
      );

      await page.getByLabel("Maximize window").click();
      await page.getByLabel("Restore window").waitFor();

      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow, screen }) => {
            const w = BrowserWindow.getAllWindows()[0];

            const b = w.getBounds(),
              a = screen.getDisplayMatching(b).workArea;

            return Math.abs(b.width - a.width) + Math.abs(b.height - a.height);
          }),
        )
        .toBeLessThanOrEqual(20);

      await page.getByLabel("Restore window").click();
      await page.getByLabel("Maximize window").waitFor();

      expect(
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds()),
      ).toEqual(normal);

      await page.locator("main").click({ position: { x: 350, y: 400 } });
      await page.keyboard.press("F11");
      await page.getByLabel("Exit fullscreen").waitFor();

      expect(
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()),
      ).toBe(true);

      await page.keyboard.press("Escape");
      await page.getByLabel("Maximize window").waitFor();
      await page.locator(".titlebar-name").dblclick();
      await page.getByLabel("Restore window").waitFor();
      await page.getByLabel("Restore window").click();

      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1200, 800),
      );

      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds().width),
        )
        .toBe(1200);

      await app.evaluate(
        ({ BrowserWindow }, b) => BrowserWindow.getAllWindows()[0].setBounds(b),
        normal,
      );

      if (process.platform === "linux" && process.env.DISPLAY) {
        const bounds = await app.evaluate(({ BrowserWindow }) => {
          const w = BrowserWindow.getAllWindows()[0];
          w.focus();
          return w.getBounds();
        });

        await promisify(execFile)("python3", [
          "tests/desktop/window-pointer.py",
          "drag",
          String(bounds.x + 290),
          String(bounds.y + 16),
        ]);

        const dragged = await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].getBounds(),
        );

        console.log("Native titlebar drag:", bounds, "→", dragged);
        expect(dragged.x !== bounds.x || dragged.y !== bounds.y).toBe(true);

        await app.evaluate(({ BrowserWindow }, bounds) => {
          const w = BrowserWindow.getAllWindows()[0];
          w.setBounds(bounds);
          w.focus();
        }, normal);

        await page.waitForTimeout(300);

        await promisify(execFile)("python3", [
          "tests/desktop/window-pointer.py",
          "double",
          String(normal.x + 290),
          String(normal.y + 16),
        ]);

        await page.getByLabel("Restore window").waitFor();
        await page.getByLabel("Restore window").click();
      }
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
  120000,
);
