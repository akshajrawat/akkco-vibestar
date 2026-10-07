import { it, expect } from "vitest";
import { _electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Engine } from "../backend/execution/engine";
import { parseIssue } from "../backend/domain";
import { fixtureRepository, FixtureProvider, waitForTask } from "./fixtures";
const require = createRequire(import.meta.url);
it.skipIf(process.env.VIBESTAR_DESKTOP_TEST !== "1")(
  "verifies real desktop windows, GitHub discovery, issue preview and isolated task conversation/diff/dock workflows",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-desktop-"));
    const engine = await Engine.create(
      join(dir, "ade"),
      () => new FixtureProvider(),
    );
    const { repo } = await fixtureRepository(engine, dir);
    const a = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/1"),
      "Task A",
      "",
      { title: "Desktop integration task A", body: "Edit source.txt" },
    );
    const b = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/2"),
      "Task B",
      "",
      { title: "Desktop integration task B", body: "Edit source.txt" },
    );
    await Promise.all(
      [a, b].map((t) =>
        waitForTask(
          engine,
          t.id,
          (s) => s === "ready_for_review" || s === "failed",
        ),
      ),
    );
    await engine.close();
    const app = await _electron.launch({
      executablePath: require("electron") as string,
      args: [resolve(".")],
      env: {
        ...process.env,
        VIBESTAR_HOME: join(dir, "ade"),
        VIBESTAR_USER_DATA: join(dir, "profile"),
      },
      timeout: 30000,
    });
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();
      page.setDefaultTimeout(15000);
      expect(
        await page.getByRole("button", { name: "Diffs", exact: true }).count(),
      ).toBe(0);
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
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].getBounds(),
        ),
      ).toEqual(normal);
      await page.locator("main").click({ position: { x: 350, y: 400 } });
      await page.keyboard.press("F11");
      await page.getByLabel("Exit fullscreen").waitFor();
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].isFullScreen(),
        ),
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
          app.evaluate(
            ({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()[0].getBounds().width,
          ),
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
          "tests/window-pointer.py",
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
          "tests/window-pointer.py",
          "double",
          String(normal.x + 290),
          String(normal.y + 16),
        ]);
        await page.getByLabel("Restore window").waitFor();
        await page.getByLabel("Restore window").click();
      }
      await page
        .getByRole("button", { name: "Scheduled", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Pull requests", exact: true })
        .waitFor();
      const github = await page.evaluate(async () => {
        await window.vibestar.rpc("github.sync");
        return window.vibestar.rpc<import("../src/lib/types").Snapshot>(
          "snapshot",
        );
      });
      if (github.github?.status?.connected) {
        expect(github.github.error).toBeNull();
        expect(github.github.repositories.length).toBeGreaterThan(0);
        expect(github.scheduled?.length).toBe(
          github.github.pull_requests.filter((p) => p.state === "OPEN").length,
        );
        console.log(
          "Live GitHub:",
          github.github.status.username,
          github.github.repositories.length,
          "repositories",
          github.scheduled?.length,
          "PR watches",
        );
        const job = github.scheduled?.[0];
        if (job) {
          await expect
            .poll(
              () =>
                page.evaluate(async (id) => {
                  const s =
                    await window.vibestar.rpc<
                      import("../src/lib/types").Snapshot
                    >("snapshot");
                  return s.scheduled?.find((j) => j.id === id)?.status;
                }, job.id),
              { timeout: 30000 },
            )
            .toBe("idle");
          await expect
            .poll(
              () =>
                page.evaluate(async () => {
                  const snapshot =
                    await window.vibestar.rpc<
                      import("../src/lib/types").Snapshot
                    >("snapshot");
                  return snapshot.scheduled?.every(
                    (w) => w.last_snapshot && !w.error,
                  );
                }),
              { timeout: 45000 },
            )
            .toBe(true);
          await page.evaluate(
            (id) =>
              window.vibestar.rpc("scheduled.enabled", { id, enabled: false }),
            job.id,
          );
          const paused = await page.evaluate(() =>
            window.vibestar.rpc<import("../src/lib/types").Snapshot>(
              "snapshot",
            ),
          );
          expect(paused.scheduled?.find((j) => j.id === job.id)?.enabled).toBe(
            false,
          );
          await page.evaluate(
            (id) =>
              window.vibestar.rpc("scheduled.enabled", { id, enabled: true }),
            job.id,
          );
          const resumed = await page.evaluate(() =>
            window.vibestar.rpc<import("../src/lib/types").Snapshot>(
              "snapshot",
            ),
          );
          expect(resumed.scheduled?.find((j) => j.id === job.id)?.enabled).toBe(
            true,
          );
        }
        await page
          .getByRole("button", { name: "New task", exact: true })
          .click();
        await page
          .getByLabel("Issue URL")
          .fill("https://github.com/oppia/oppia/issues/26831");
        await page.getByLabel("Entire issue").waitFor({ timeout: 30000 });
        await page.getByLabel("Specific part / claimed subtask").check();
        await page
          .getByLabel("Claimed scope")
          .fill("check-improvements-tab.spec.ts");
        const resolved = await page.evaluate(() =>
          window.vibestar.rpc<{
            resolved: { origin_url: string; base_branch: string };
          }>("task.preview", {
            issue_url: "https://github.com/oppia/oppia/issues/26831",
          }),
        );
        expect(resolved.resolved.base_branch).toBe("develop");
        expect(resolved.resolved.origin_url).toBe(
          "https://github.com/akshajrawat/oppia.git",
        );
        await page.getByLabel("Entire issue").check();
        await page.getByRole("button", { name: "Close", exact: true }).click();
      }
      await page
        .getByRole("button", { name: "Providers", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Providers", exact: true })
        .waitFor();
      await page.getByText("GitHub", { exact: true }).waitFor();
      expect(await page.locator(".auth-terminal").count()).toBe(0);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByText("CODEX IMPLEMENTATION", { exact: true }).waitFor();
      await page.locator(".tree-task").filter({ hasText: "Task A" }).click();
      await page.getByLabel("Task follow-up").fill("Preserve task A draft");
      expect(await page.locator(".context-pane").count()).toBe(0);
      await mkdir("docs/screenshots", { recursive: true });
      await page.screenshot({ path: "docs/screenshots/chat.png" });
      await page.getByRole("tab", { name: "Changes", exact: true }).click();
      await page.locator(".monaco-diff-editor").waitFor();
      expect(await page.locator(".file-toolbar code").innerText()).toContain(
        "source.txt",
      );
      await page.screenshot({ path: "docs/screenshots/diff.png" });
      await page.getByLabel("Diff mode").selectOption("inline");
      await page.getByRole("button", { name: "Review", exact: true }).click();
      await page
        .getByLabel("Local diff review note")
        .fill("Desktop local review");
      await page
        .getByRole("button", { name: "Save note", exact: true })
        .click();
      await page.getByText("Desktop local review", { exact: true }).waitFor();
      page.once("dialog", (d) => void d.accept());
      await page.getByLabel("Delete review note").click();
      await page
        .getByText("Desktop local review", { exact: true })
        .waitFor({ state: "hidden" });
      await page.getByRole("tab", { name: "Chat", exact: true }).click();
      await page.getByLabel("Split Changes beside chat").click();
      await page.locator(".context-pane .monaco-diff-editor").waitFor();
      await page.screenshot({ path: "docs/screenshots/chat-changes.png" });
      await page.getByLabel("Close context pane").click();
      await page.getByLabel("Toggle utility dock").click();
      await page.getByRole("button", { name: "Start task terminal" }).click();
      await page.getByRole("button", { name: "Close shell" }).waitFor();
      await page
        .locator(".xterm-helper-textarea")
        .pressSequentially("printf 'DESKTOP_'; printf 'PTY_OK\\n'");
      await page.keyboard.press("Enter");
      await expect
        .poll(() =>
          page.evaluate(
            async (id) =>
              (
                await window.vibestar.rpc<{ output: string }>(
                  "terminal.status",
                  { id },
                )
              )?.output,
            a.id,
          ),
        )
        .toContain("DESKTOP_PTY_OK");
      await page
        .locator(".xterm-helper-textarea")
        .pressSequentially("printf 'LIVE_DIFF_REFRESH\\n' > live-added.txt");
      await page.keyboard.press("Enter");
      await page.getByRole("tab", { name: "Changes", exact: true }).click();
      await page.getByRole("button", { name: /live-added.txt/ }).waitFor();
      await page.getByRole("button", { name: /live-added.txt/ }).click();
      await expect
        .poll(() => page.locator(".file-toolbar code").innerText())
        .toContain("live-added.txt");
      await page.getByRole("tab", { name: "Chat", exact: true }).click();
      await page.locator(".tree-task").filter({ hasText: "Task B" }).click();
      await page.getByLabel("Task follow-up").waitFor();
      expect(await page.getByLabel("Task follow-up").inputValue()).toBe("");
      expect(await page.locator(".utility-dock").count()).toBe(0);
      await page.getByRole("tab", { name: "Changes", exact: true }).click();
      expect(
        await page.getByRole("button", { name: /live-added.txt/ }).count(),
      ).toBe(0);
      await page.getByRole("tab", { name: "Chat", exact: true }).click();
      await page.getByLabel("Task follow-up").fill("Task B only");
      await page.getByRole("button", { name: "Context", exact: true }).click();
      await page.getByLabel("Context file or note").fill("source.txt");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      expect(await page.getByLabel("Task follow-up").inputValue()).toBe(
        "Task B only\n@source.txt",
      );
      await page.locator(".tree-task").filter({ hasText: "Task A" }).click();
      await page.getByRole("button", { name: "Close shell" }).waitFor();
      expect(await page.getByLabel("Task follow-up").inputValue()).toBe(
        "Preserve task A draft",
      );
      await page.getByRole("button", { name: "Close shell" }).click();
      await page.getByLabel("Hide utility dock").click();
      await page.getByRole("tab", { name: "Plan", exact: true }).click();
      await page
        .getByText("Antigravity original plan", { exact: true })
        .waitFor();
      await page.screenshot({ path: "docs/screenshots/plans.png" });
      await page.keyboard.press("Control+Shift+P");
      await page.getByLabel("Search commands").fill("Task: Logs");
      await page.keyboard.press("Enter");
      await page.locator(".logs-panel").waitFor();
      const separator = page.getByRole("separator", {
        name: "Resize navigation pane",
      });
      const width = Number(await separator.getAttribute("aria-valuenow"));
      await separator.focus();
      await page.keyboard.press("ArrowRight");
      expect(Number(await separator.getAttribute("aria-valuenow"))).toBe(
        width + 16,
      );
      expect(errors).toEqual([]);
      const closed = new Promise<void>((r) => page.once("close", () => r()));
      await page.getByLabel("Close window").click();
      await closed;
    } finally {
      await app.close();
      await rm(dir, { recursive: true });
    }
  },
  120000,
);
