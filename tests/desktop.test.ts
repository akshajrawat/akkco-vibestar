import { it, expect } from "vitest";
import { _electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const require = createRequire(import.meta.url);
it.skipIf(process.env.VIBESTAR_DESKTOP_TEST !== "1")(
  "opens the real Electron shell with working local IPC and Settings",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-desktop-"));
    const electron = await _electron.launch({
      executablePath: require("electron") as string,
      args: [resolve(".")],
      env: {
        ...process.env,
        VIBESTAR_HOME: process.env.VIBESTAR_DESKTOP_HOME || join(dir, "ade"),
        VIBESTAR_USER_DATA: join(dir, "profile"),
      },
      timeout: 30000,
    });
    try {
      const page = await electron.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page
        .getByRole("heading", { name: "Overview", exact: true })
        .waitFor();
      expect(
        await electron.evaluate(({ Menu, BrowserWindow }) => ({
          menu: Menu.getApplicationMenu() === null,
          preferences: (
            BrowserWindow.getAllWindows()[0]
              .webContents as Electron.WebContents & {
              getLastWebPreferences: () => Electron.WebPreferences;
            }
          ).getLastWebPreferences(),
          resizable: BrowserWindow.getAllWindows()[0].isResizable(),
        })),
      ).toMatchObject({
        menu: true,
        resizable: true,
        preferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      expect(
        await page.locator(".titlebar").evaluate((e) => ({
          height: e.getBoundingClientRect().height,
          drag: getComputedStyle(e).getPropertyValue("-webkit-app-region"),
        })),
      ).toEqual({ height: 34, drag: "drag" });
      expect(
        await page
          .getByRole("button", { name: "Maximize window" })
          .evaluate((e) =>
            getComputedStyle(e).getPropertyValue("-webkit-app-region"),
          ),
      ).toBe("no-drag");
      await page.getByRole("button", { name: "Maximize window" }).click();
      await page.getByRole("button", { name: "Restore window" }).waitFor();
      expect(
        await electron.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].isMaximized(),
        ),
      ).toBe(true);
      await page.getByRole("button", { name: "Restore window" }).click();
      await page.getByRole("button", { name: "Maximize window" }).waitFor();
      await page.getByRole("button", { name: "Minimize window" }).click();
      await page.evaluate(() => window.electronWindow.minimize());
      await electron.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].restore(),
      );
      await page
        .getByRole("button", { name: "Scheduled", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Scheduled", exact: true })
        .waitFor();
      expect(
        await page
          .getByText("Automatic implementation: OFF", { exact: true })
          .count(),
      ).toBe(1);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page
        .getByRole("heading", { name: "Settings", exact: true })
        .waitFor();
      expect(
        await page
          .getByText("Linux builds execute directly", { exact: false })
          .count(),
      ).toBe(1);
      expect(
        await page.getByText("CODEX IMPLEMENTATION", { exact: true }).count(),
      ).toBe(1);
      await page.getByRole("button", { name: "Overview", exact: true }).click();
      await mkdir("docs/screenshots", { recursive: true });
      await page.screenshot({ path: "docs/screenshots/overview.png" });
      if (process.env.VIBESTAR_DESKTOP_HOME) {
        const cards = page.locator(".task-card");
        await cards.first().click();
        await page
          .getByLabel("Task follow-up")
          .fill("Preserve this local draft");
        await page.getByLabel("Task model").waitFor();
        const navigation = page.getByRole("separator", {
          name: "Resize navigation pane",
        });
        const previousWidth = Number(
          await navigation.getAttribute("aria-valuenow"),
        );
        await navigation.focus();
        await page.keyboard.press("ArrowRight");
        expect(Number(await navigation.getAttribute("aria-valuenow"))).toBe(
          previousWidth + 16,
        );
        await page.keyboard.press("Control+Shift+P");
        await page.getByRole("dialog", { name: "Command palette" }).waitFor();
        await page.getByLabel("Search commands").fill("Task: Terminal");
        await page.keyboard.press("Enter");
        await page.getByRole("button", { name: "Start task terminal" }).click();
        await page.getByRole("button", { name: "Close shell" }).waitFor();
        const terminalId = await page.evaluate(async () => {
          const snapshot = (await window.vibestar.rpc("snapshot", {})) as {
            tasks: { id: string }[];
          };
          return snapshot.tasks[0].id;
        });
        await page
          .locator(".xterm-helper-textarea")
          .pressSequentially("printf 'VIBESTAR_'; printf 'TERM_OK\\n'");
        await page.keyboard.press("Enter");
        await expect
          .poll(async () => {
            const session = await page.evaluate(
              async (id) =>
                (await window.vibestar.rpc("terminal.status", { id })) as {
                  output: string;
                } | null,
              terminalId,
            );
            return session?.output || "";
          })
          .toContain("VIBESTAR_TERM_OK");
        await page.getByRole("button", { name: "Dock", exact: true }).click();
        await page.getByLabel("Task follow-up").waitFor();
        expect(await page.getByLabel("Task follow-up").inputValue()).toBe(
          "Preserve this local draft",
        );
        await page.screenshot({ path: "docs/screenshots/chat-terminal.png" });
        await page
          .getByRole("button", { name: "Overview", exact: true })
          .click();
        await page.locator(".task-card").first().click();
        expect(await page.getByLabel("Task follow-up").inputValue()).toBe(
          "Preserve this local draft",
        );
        await page.getByRole("button", { name: "Close shell" }).click();
        await page
          .getByRole("button", { name: "Start task terminal" })
          .waitFor();
        await page.getByLabel("Hide terminal dock").click();
        await page.getByRole("button", { name: "Plan", exact: true }).click();
        await page
          .getByText("Antigravity original plan", { exact: true })
          .waitFor();
        await page.screenshot({ path: "docs/screenshots/plans.png" });
        await page
          .getByRole("button", { name: "Changes", exact: true })
          .click();
        await page.getByText("1 files changed", { exact: true }).waitFor();
        await page.locator(".monaco-diff-editor").waitFor();
        await page.screenshot({ path: "docs/screenshots/diff.png" });
        await page.getByLabel("Diff mode").selectOption("inline");
        await expect
          .poll(() => page.locator(".monaco-diff-editor").getAttribute("class"))
          .not.toContain("side-by-side");
        await page
          .getByRole("button", { name: "Next change", exact: true })
          .click();
        await page.getByRole("button", { name: "Review", exact: true }).click();
        await page
          .getByRole("textbox", { name: "Local diff review note" })
          .fill("Desktop smoke review note");
        await page
          .getByRole("button", { name: "Save note", exact: true })
          .click();
        await page
          .getByText("Desktop smoke review note", { exact: true })
          .waitFor();
        await page.screenshot({ path: "docs/screenshots/diff-review.png" });
        page.once("dialog", (dialog) => void dialog.accept());
        await page.getByRole("button", { name: "Delete review note" }).click();
        await page
          .getByText("Desktop smoke review note", { exact: true })
          .waitFor({ state: "hidden" });
        await page.getByLabel("Filter changed files").fill("nonexistent");
        await page.getByText("No matching files", { exact: true }).waitFor();
      }
      expect(errors).toEqual([]);
      const closed = new Promise<void>((resolve) =>
        page.once("close", () => resolve()),
      );
      await page.getByRole("button", { name: "Close window" }).click();
      await closed;
    } finally {
      await electron.close();
      await rm(dir, { recursive: true });
    }
  },
  60000,
);
