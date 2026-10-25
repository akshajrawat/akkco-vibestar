import { expect, it } from "vitest";
import { _electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Rpc } from "../backend/rpc";
import { defaultSettings, parseIssue } from "../backend/domain";
import {
  createFixtureEngine,
  fixtureRepository,
  FixtureProvider,
} from "./fixtures";
import { ValidationBlockerProvider } from "./verification/provider";

const require = createRequire(import.meta.url);

it.skipIf(process.env.VIBESTAR_WORKSPACE_DESKTOP_TEST !== "1")(
  "exercises the workspace validation blocker and safe recovery using built Electron and fixture-only providers",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-chat-workspace-"));
    const evidence = join(dir, "screenshots");
    await mkdir(evidence);
    const engine = await createFixtureEngine(
      join(dir, "data"),
      () => new ValidationBlockerProvider(),
    );
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
    const { repo } = await fixtureRepository(engine, dir);
    const emptyRoot = join(dir, "empty-core");
    const empty = await createFixtureEngine(emptyRoot);
    empty.db.run(
      "INSERT INTO settings VALUES('github_watch',?)",
      JSON.stringify({
        auto_watch: false,
        interval_minutes: 60,
        verify_codex: false,
      }),
    );
    await empty.close();
    const home = join(dir, "isolated-home");
    const blockedCli = join(dir, "blocked-cli");
    await mkdir(home);
    await mkdir(blockedCli);
    for (const name of ["codex", "agy", "gh"])
      await writeFile(
        join(blockedCli, name),
        "#!/bin/sh\necho 'Live services disabled in workspace fixture' >&2\nexit 1\n",
        { mode: 0o755 },
      );
    const app = await _electron.launch({
      executablePath: require("electron") as string,
      args: [resolve(".")],
      env: {
        ...process.env,
        VIBESTAR_HOME: emptyRoot,
        HOME: home,
        PATH: `${blockedCli}:${process.env.PATH}`,
        VIBESTAR_USER_DATA: join(dir, "profile"),
      },
    });
    let forward: ((event: unknown) => void) | undefined;
    try {
      const page = await app.firstWindow();
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1440, 900),
      );
      await expect
        .poll(() => page.evaluate(() => window.innerWidth))
        .toBe(1440);
      page.setDefaultTimeout(15000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();
      const detection = await new FixtureProvider().detect();
      await page.exposeFunction(
        "fixtureRpc",
        async (method: string, params: unknown) =>
          method === "providers.detect"
            ? ["antigravity", "codex", "github"].map((provider) => ({
                ...detection,
                provider,
                accountLabel: `${provider} fixture account`,
                models: provider === "github" ? [] : detection.models,
              }))
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
            ({ BrowserWindow }, value) =>
              BrowserWindow.getAllWindows()[0]?.webContents.send(
                "core:event",
                value,
              ),
            event,
          )
          .catch(() => {});
      };
      engine.on("event", forward);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      for (const [navigation, heading, file] of [
        ["Pull Requests", "Pull requests", "premium-pull-requests"],
        ["Issue Watch", "Issue Watch", "premium-issue-watch"],
        ["Repositories", "Repositories", "premium-repositories"],
        ["Providers", "Providers", "premium-providers"],
        ["Usage", "Local AI usage", "premium-usage-empty"],
        ["Settings", "Settings", "premium-settings"],
        ["Tasks", "Tasks", "premium-tasks"],
      ]) {
        await page
          .getByRole("button", { name: navigation, exact: true })
          .click();
        await page
          .getByRole("heading", { name: heading, exact: true })
          .waitFor();
        await page.evaluate(() => document.fonts.ready);
        for (const [width, height] of [
          [1920, 1080],
          [1440, 900],
          [1280, 720],
        ]) {
          await app.evaluate(
            ({ BrowserWindow }, dimensions) =>
              BrowserWindow.getAllWindows()[0].setSize(
                ...(dimensions as [number, number]),
              ),
            [width, height],
          );
          await expect
            .poll(() => page.evaluate(() => window.innerWidth))
            .toBe(width);
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
          ).toBe(true);
          await page.screenshot({
            animations: "disabled",
            path: join(evidence, `${file}-${width}x${height}.png`),
          });
        }
      }
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1440, 900),
      );
      expect(engine.db.all("SELECT * FROM ai_usage")).toEqual([]);
      const task = engine.enqueue(
        repo,
        parseIssue("https://github.com/fixture/fixture/issues/7"),
        "Multiplication table",
        "",
        {
          title: "Accessible multiplication table",
          body: "HTML, CSS and JavaScript multiplication table",
        },
      );
      await page.locator(".tree-task").first().click();
      const draft = page.getByLabel("Task follow-up");
      await draft.fill(
        "Keep this independent unsent instruction through plan approval.",
      );
      expect(await page.locator(".workspace-tabs").count()).toBe(0);
      expect(await page.locator(".bottom-dock").isVisible()).toBe(false);
      const resize = page.getByRole("separator", {
        name: "Resize secondary workspace",
      });
      await resize.focus();
      await page.keyboard.press("ArrowLeft");
      await page
        .getByRole("button", {
          name: "Approve → Codex refinement",
          exact: true,
        })
        .waitFor();
      await draft.fill(
        "SAVED_HELPER_INSTRUCTION: use the existing helper and preserve unrelated tests.",
      );
      await page
        .getByRole("button", { name: "Save for later", exact: true })
        .click();
      await expect
        .poll(() => engine.db.detail(task.id).messages.length)
        .toBe(1);
      expect(engine.db.detail(task.id).messages[0].status).toBe("draft");
      expect(engine.db.detail(task.id).runs).toHaveLength(1);
      expect(engine.db.task(task.id).approval_gate).toBe("antigravity_plan");
      expect(await draft.inputValue()).toContain("SAVED_HELPER_INSTRUCTION");
      await draft.fill(
        "Keep this independent unsent instruction through plan approval.",
      );
      await page
        .getByRole("button", { name: "Add context", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Add text note", exact: true })
        .click();
      await page
        .getByLabel("Context note", { exact: true })
        .fill(
          "UNSENT_CONTEXT_NOTE: check the browser evidence before accepting.",
        );
      await page
        .getByRole("button", { name: "Attach context", exact: true })
        .click();
      await page.getByText("Text note", { exact: true }).waitFor();
      for (const name of [
        "Approve → Codex refinement",
        "Approve → Implement",
      ]) {
        await page.getByRole("button", { name, exact: true }).waitFor();
        expect(
          await page
            .getByRole("dialog", { name: "Stage review required" })
            .count(),
        ).toBe(0);
        await page
          .getByRole("button", { name: "View plan", exact: true })
          .click();
        await page
          .getByText(
            name.includes("refinement")
              ? "Antigravity original plan"
              : "Codex refined plan",
            { exact: true },
          )
          .waitFor();
        expect(await draft.inputValue()).toContain("Keep this independent");
        await page
          .getByLabel("Saved instructions on approval")
          .selectOption(
            name.includes("refinement") ? "keep_saved" : "include_next_stage",
          );
        await page.screenshot({
          path: join(
            evidence,
            name.includes("refinement")
              ? "antigravity-plan-approval.png"
              : "codex-plan-approval.png",
          ),
        });
        await page.getByRole("button", { name, exact: true }).click();
      }
      expect(engine.db.detail(task.id).messages).toHaveLength(1);
      expect(engine.db.detail(task.id).messages[0].content).not.toContain(
        "Keep this independent",
      );
      expect(engine.db.detail(task.id).messages[0].content).not.toContain(
        "UNSENT_CONTEXT_NOTE",
      );
      expect(await draft.inputValue()).toContain("Keep this independent");
      await expect
        .poll(() => engine.db.task(task.id).status, { timeout: 30000 })
        .toBe("verification_blocked");
      await expect
        .poll(() => page.locator(".validation-turn").innerText())
        .toContain("Tooling setup interrupted");
      expect(await page.locator(".validation-turn .success").count()).toBe(0);
      expect(engine.db.detail(task.id).messages[0].status).toBe("delivered");
      expect(engine.db.detail(task.id).runs.at(-1)?.prompt).toContain(
        "SAVED_HELPER_INSTRUCTION",
      );
      await page.locator(".validation-turn button").click();
      await page
        .getByRole("region", { name: "Verification evidence" })
        .waitFor();
      const setupRow = page
        .getByRole("region", { name: "Verification evidence" })
        .locator("li")
        .filter({ hasText: "Playwright installation · interrupted" });
      await page
        .locator(".verification-group > summary")
        .filter({ hasText: "Blocked" })
        .click();
      await setupRow
        .getByRole("button", { name: "Inspect exact command" })
        .click();
      await expect
        .poll(() => page.getByLabel("Selected command output").innerText())
        .toContain("Fixture: Playwright setup interrupted; no network used");
      expect(await page.locator(".command-log-heading").innerText()).toContain(
        "interrupted · exit 130",
      );
      await page.screenshot({
        path: join(evidence, "interrupted-setup-command.png"),
      });
      await page
        .locator(".secondary-content")
        .getByRole("button", { name: "Recheck saved evidence" })
        .click();
      await expect.poll(() => engine.db.detail(task.id).tests.length).toBe(6);
      expect(engine.db.detail(task.id).runs).toHaveLength(3);
      await page.locator(".browser-environment > summary").click();
      await page
        .getByRole("button", {
          name: "Inspect browser environment",
          exact: true,
        })
        .click();
      await page.getByLabel("Observed browser capabilities").waitFor();
      expect(engine.db.task(task.id).status).toBe("verification_blocked");
      expect(engine.db.detail(task.id).runs).toHaveLength(3);
      await page.screenshot({
        path: join(evidence, "browser-environment.png"),
      });
      await page.locator(".browser-environment > summary").click();
      for (const [width, height] of [
        [1920, 1080],
        [1440, 900],
        [1280, 720],
      ]) {
        await app.evaluate(
          ({ BrowserWindow }, size) =>
            BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]),
          [width, height],
        );
        await expect
          .poll(() => page.evaluate(() => window.innerWidth))
          .toBe(width);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        await page.screenshot({
          path: join(evidence, `validation-blocker-${width}x${height}.png`),
        });
      }
      expect(await page.locator(".bottom-dock").isVisible()).toBe(false);
      await page.getByRole("tab", { name: "Changes", exact: true }).click();
      await page
        .getByRole("button", { name: "Open full diff review", exact: true })
        .click();
      await page.getByLabel("Task changes").waitFor();
      await page.getByRole("button", { name: /^script.js · / }).click();
      await page.locator(".diff-scroll .syntax-keyword").first().waitFor();
      await page.getByLabel("Mark task file reviewed").click();
      await expect
        .poll(
          () =>
            engine.db.all(
              "SELECT path FROM task_reviewed_files WHERE task_id=?",
              task.id,
            ).length,
        )
        .toBe(1);
      await expect
        .poll(() => page.getByLabel("Mark task file reviewed").isChecked())
        .toBe(true);
      await page
        .getByRole("button", { name: "Unified diff", exact: true })
        .click();
      await page.screenshot({
        path: join(evidence, "expanded-review-unified.png"),
      });
      await page
        .getByRole("button", { name: "Side-by-side diff", exact: true })
        .click();
      expect(await draft.inputValue()).toContain("Keep this independent");
      await page.screenshot({ path: join(evidence, "expanded-review.png") });
      await page.getByLabel("Return to chat").click();
      await page.getByRole("tab", { name: "Tests", exact: true }).click();
      await page.getByLabel("Toggle utility dock").click();
      await page
        .getByRole("button", { name: "Start task terminal", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Close shell", exact: true })
        .waitFor();
      const before = await rpc.call("terminal.status", { id: task.id });
      await page.getByLabel("Hide utility dock").click();
      await page.getByLabel("Toggle utility dock").click();
      expect(await rpc.call("terminal.status", { id: task.id })).toMatchObject({
        session_id: (before as { session_id: string }).session_id,
      });
      await page
        .getByRole("button", { name: "Close shell", exact: true })
        .click();
      await page.getByLabel("Hide utility dock").click();
      await draft.focus();
      await page.keyboard.press("Control+b");
      await expect
        .poll(() => page.locator(".sidebar:not([inert])").count())
        .toBe(0);
      await expect.poll(() => page.locator(".sidebar").count()).toBe(0);
      await page.keyboard.press("Control+b");
      await expect.poll(() => page.locator(".sidebar").count()).toBe(1);
      await draft.evaluate((element) =>
        element.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            ctrlKey: true,
            key: "b",
            isComposing: true,
          }),
        ),
      );
      expect(await page.locator(".sidebar").count()).toBe(1);
      await page.keyboard.press("Control+`");
      expect(await page.locator(".bottom-dock").isVisible()).toBe(true);
      expect(
        await draft.evaluate((element) => document.activeElement === element),
      ).toBe(true);
      await page.keyboard.press("Control+j");
      expect(await page.locator(".bottom-dock").isVisible()).toBe(false);
      await page.keyboard.press("Control+Shift+P");
      await page.getByRole("dialog", { name: "Command palette" }).waitFor();
      await page.keyboard.press("Escape");
      expect(
        await draft.evaluate((element) => document.activeElement === element),
      ).toBe(true);
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(980, 720),
      );
      await page.getByRole("dialog", { name: "Secondary workspace" }).waitFor();
      await page.screenshot({
        path: join(evidence, "narrow-workspace-drawer.png"),
      });
      await page.keyboard.press("Escape");
      expect(
        await page.getByRole("dialog", { name: "Secondary workspace" }).count(),
      ).toBe(0);
      await draft.fill(
        "Keep this unsent instruction while I inspect verification.",
      );
      await page.reload();
      await page.getByLabel("Task follow-up").waitFor();
      expect(await page.getByLabel("Task follow-up").inputValue()).toContain(
        "Keep this unsent instruction",
      );
      expect(
        await page.evaluate(
          (id) =>
            JSON.parse(localStorage.getItem(`vibestar.layout.${id}`)!)
              .secondaryWidth,
          task.id,
        ),
      ).toBe(396);
      expect(await page.locator(".bottom-dock").isVisible()).toBe(false);
      expect(await page.getByText("Text note", { exact: true }).count()).toBe(
        1,
      );
      await page.getByLabel("Toggle secondary workspace").click();
      expect(
        await page
          .getByRole("tab", { name: "Tests", exact: true })
          .getAttribute("aria-selected"),
      ).toBe("true");
      expect(engine.db.detail(task.id).runs).toHaveLength(3);
      // Explicit fixture telemetry exercises partial coverage without live inference.
      const usage = engine.db.all<{ id: string }>(
        "SELECT id FROM ai_usage WHERE task_id=? ORDER BY started_at,id",
        task.id,
      );
      expect(usage).toHaveLength(3);
      engine.db.run(
        "UPDATE ai_usage SET input_tokens=100,output_tokens=20,cached_input_tokens=10,reasoning_tokens=4,total_tokens=120 WHERE id=?",
        usage[0].id,
      );
      engine.db.run(
        "UPDATE ai_usage SET input_tokens=42,output_tokens=8 WHERE id=?",
        usage[1].id,
      );
      await page.getByRole("button", { name: "Usage", exact: true }).click();
      await page.getByRole("table").waitFor();
      expect(await page.locator(".usage-table tbody tr").count()).toBe(3);
      await expect
        .poll(() => page.locator(".usage-tokens").textContent())
        .toContain("Input142");
      expect(await page.locator(".usage-tokens").textContent()).toContain(
        "Total1201/3 runs reported",
      );
      for (const [width, height] of [
        [1920, 1080],
        [1440, 900],
        [1280, 720],
      ]) {
        await app.evaluate(
          ({ BrowserWindow }, dimensions) =>
            BrowserWindow.getAllWindows()[0].setSize(
              ...(dimensions as [number, number]),
            ),
          [width, height],
        );
        await expect
          .poll(() => page.evaluate(() => window.innerWidth))
          .toBe(width);
        await page.screenshot({
          animations: "disabled",
          path: join(
            evidence,
            `premium-usage-populated-${width}x${height}.png`,
          ),
        });
        await page.locator(".usage-charts").scrollIntoViewIfNeeded();
        await page
          .getByRole("button", {
            name: /120 tokens.*1\/3 runs reported totals/,
          })
          .focus();
        await page.screenshot({
          animations: "disabled",
          path: join(evidence, `premium-usage-charts-${width}x${height}.png`),
        });
        await page
          .getByRole("heading", { name: "Local AI usage", exact: true })
          .scrollIntoViewIfNeeded();
      }
      expect(errors).toEqual([]);
      await writeFile(
        join(evidence, "results.json"),
        JSON.stringify(
          {
            errors,
            detail: await rpc.call("task.detail", { id: task.id }),
            inference:
              "Fixture processes only; no subscription or GitHub operations",
            usage_fixture_note:
              "Two saved fixture rows have explicit token samples (120 reported total; one partial row). The third remains unavailable. These are test values, not real subscription usage.",
          },
          null,
          2,
        ),
      );
      console.log("Workspace desktop evidence", evidence);
    } catch (error) {
      await (
        await app.firstWindow()
      )
        .screenshot({ path: join(evidence, "failure.png") })
        .catch(() => {});
      console.log("Workspace desktop failure evidence", evidence);
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
