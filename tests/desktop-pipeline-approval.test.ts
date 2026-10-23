import { it, expect } from "vitest";
import { _electron } from "playwright-core";
import Sqlite from "better-sqlite3";
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
const require = createRequire(import.meta.url);

it.skipIf(process.env.VIBESTAR_GATE_DESKTOP_TEST !== "1")(
  "visually exercises the real Electron renderer and IPC with fixture-only review gates and prompts",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-gate-desktop-"));
    const evidence = join(dir, "screenshots");
    await mkdir(evidence);
    const engine = await createFixtureEngine(
      join(dir, "fixture-data"),
      (stage, provider) => ({
        ...new FixtureProvider(
          async () => new Promise<void>((resolve) => setTimeout(resolve, 1800)),
        ),
        name:
          provider || (stage === 1 || stage === 5 ? "antigravity" : "codex"),
      }),
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
    const blockedCli = join(dir, "blocked-ai-cli");
    await mkdir(blockedCli);
    const isolatedHome = join(dir, "isolated-home");
    await mkdir(isolatedHome);
    for (const name of ["agy", "codex"])
      await writeFile(
        join(blockedCli, name),
        "#!/bin/sh\necho 'Real AI execution is disabled in this desktop fixture test' >&2\nexit 1\n",
        { mode: 0o755 },
      );
    // The desktop's normal core has a separate empty root. No real provider can
    // receive a queued fixture task, and production has no mock-provider setting.
    const app = await _electron.launch({
      executablePath: require("electron") as string,
      args: [resolve(".")],
      env: {
        ...process.env,
        VIBESTAR_HOME: emptyRoot,
        HOME: isolatedHome,
        PATH: `${blockedCli}:${process.env.PATH}`,
        VIBESTAR_USER_DATA: join(dir, "desktop-profile"),
      },
      timeout: 30000,
    });
    let forward: ((event: unknown) => void) | undefined;
    try {
      const page = await app.firstWindow();
      page.setDefaultTimeout(15000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();
      const detection = await new FixtureProvider().detect();
      await page.exposeFunction(
        "fixtureRpc",
        async (method: string, params: unknown) =>
          method === "providers.detect"
            ? ["antigravity", "codex"].map((provider) => ({
                ...detection,
                provider,
              }))
            : rpc.call(method, params),
      );
      // Install a test-only IPC target in this isolated Electron instance.
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
        parseIssue("https://github.com/fixture/fixture/issues/26831"),
        "Task A",
        "",
        {
          title: "Review-gated fixture task",
          body: "Inspect source.txt and preserve isolation",
          comments: [{ body: "Add coverage" }],
          linkedPullRequests: [{ title: "Related fixture PR" }],
        },
      );
      await page.locator(".tree-task").first().click();
      await page.getByRole("region", { name: "Current agent run" }).waitFor();
      await expect
        .poll(() => page.locator(".current-run").innerText())
        .toContain("Antigravity");
      await page.screenshot({ path: join(evidence, "current-run.png") });
      await page
        .getByRole("button", { name: "Approve → Codex refinement" })
        .waitFor();
      expect(engine.db.detail(task.id).runs).toHaveLength(1);
      expect(
        await page
          .getByRole("dialog", { name: "Stage review required" })
          .count(),
      ).toBe(0);
      await page.screenshot({ path: join(evidence, "review-required.png") });
      await page
        .getByRole("button", { name: "View plan", exact: true })
        .click();
      await page
        .locator(".secondary-content")
        .getByText("Fixture plan", { exact: true })
        .waitFor();
      await page
        .locator(".plan-comparison .run-prompt summary")
        .first()
        .click();
      expect(
        await page
          .locator(".plan-comparison .run-prompt pre")
          .first()
          .innerText(),
      ).toContain("every available issue comment");
      await page.screenshot({
        path: join(evidence, "antigravity-plan-prompt.png"),
      });
      await page
        .getByRole("button", { name: "Approve → Codex refinement" })
        .click();
      await page.getByRole("button", { name: "Approve → Implement" }).waitFor();
      expect(engine.db.detail(task.id).runs).toHaveLength(2);
      expect(
        await page
          .getByRole("dialog", { name: "Stage review required" })
          .count(),
      ).toBe(0);
      await page
        .getByRole("button", { name: "View plan", exact: true })
        .click();
      await page.screenshot({ path: join(evidence, "codex-plan-gate.png") });
      await page.getByRole("button", { name: "Approve → Implement" }).click();
      await page
        .getByRole("button", { name: "Approve → Antigravity review & tests" })
        .waitFor();
      await page
        .getByRole("button", { name: "View tests", exact: true })
        .click();
      expect(
        await page.getByRole("tab", { name: "Changes", exact: true }).count(),
      ).toBe(1);
      expect(await page.locator(".monaco-diff-editor").count()).toBe(0);
      await page
        .getByRole("button", { name: "Open in VS Code", exact: true })
        .waitFor();
      await page.screenshot({
        path: join(evidence, "implementation-review-gate.png"),
      });
      await page
        .getByRole("button", { name: "Approve → Antigravity review & tests" })
        .click();
      await page
        .getByRole("button", { name: "Accept review", exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "View review", exact: true })
        .click();
      await page
        .locator(".secondary-content")
        .getByText("Fixture final review", { exact: true })
        .waitFor();
      await page
        .locator(".secondary-content")
        .getByText("remote CI", { exact: true })
        .waitFor();
      await page.screenshot({ path: join(evidence, "final-review.png") });
      await page
        .getByRole("button", { name: "Accept review", exact: true })
        .click();
      await page.getByRole("button", { name: "Finalize…" }).waitFor();
      await page.getByRole("tab", { name: "Changes", exact: true }).click();
      await page
        .getByRole("button", { name: "Open full diff review", exact: true })
        .click();
      await page
        .getByLabel("Task changes")
        .getByText("A", { exact: true })
        .waitFor();
      const fullHeight = await page
        .locator(".secondary-expanded")
        .evaluate((element) => element.getBoundingClientRect().height);
      const workspaceHeight = await page
        .locator(".workspace")
        .evaluate((element) => element.getBoundingClientRect().height);
      expect(fullHeight).toBeGreaterThan(workspaceHeight * 0.85);
      await page.screenshot({ path: join(evidence, "changes-maximized.png") });
      await page.getByLabel("Return to chat").click();
      await page.getByLabel("Toggle utility dock").click();
      await page
        .getByRole("button", { name: "Start task terminal", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Close shell", exact: true })
        .waitFor();
      await page.getByLabel("Maximize utility dock").click();
      const terminalBefore = await rpc.call("terminal.status", { id: task.id });
      await page.getByLabel("Restore utility dock").click();
      await page.getByLabel("Maximize utility dock").click();
      const terminalAfter = await rpc.call("terminal.status", { id: task.id });
      expect(terminalAfter).toMatchObject({
        session_id: (terminalBefore as { session_id: string }).session_id,
      });
      await page.screenshot({ path: join(evidence, "terminal-maximized.png") });
      await page
        .getByRole("button", { name: "Close shell", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Start task terminal", exact: true })
        .waitFor();
      await page.getByLabel("Restore utility dock").click();
      await engine.runCommand(task.id, [
        process.execPath,
        "-e",
        "console.log('desktop verification passed'); console.error('verification stderr retained')",
      ]);
      await page.getByRole("tab", { name: "Tests", exact: true }).click();
      await expect
        .poll(() => page.getByLabel("Selected command output").innerText())
        .toContain("desktop verification passed");
      expect(
        await page.getByLabel("Selected command output").innerText(),
      ).toContain("verification stderr retained");
      await page.getByLabel("Expand workspace tool").click();
      await page.screenshot({
        path: join(evidence, "test-output-maximized.png"),
      });
      await page.getByLabel("Return to chat").click();
      await page
        .getByRole("tab", { name: "Usage", exact: true })
        .first()
        .click();
      await page
        .getByText("Antigravity Final Review", { exact: true })
        .first()
        .waitFor();
      await page.screenshot({ path: join(evidence, "task-usage.png") });
      await page.getByRole("tab", { name: "Run details", exact: true }).click();
      await page
        .getByRole("button", { name: "View sent prompts", exact: true })
        .click();
      await page.getByRole("dialog", { name: "Agent prompts" }).waitFor();
      expect(
        await page
          .getByRole("dialog", { name: "Agent prompts" })
          .locator(".run-prompt")
          .count(),
      ).toBe(4);
      await page.screenshot({ path: join(evidence, "all-sent-prompts.png") });
      await page
        .getByRole("dialog", { name: "Agent prompts" })
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await page.getByLabel("Collapse secondary workspace").click();
      await page.screenshot({ path: join(evidence, "sidebar-collapsed.png") });
      const emptyAudit = new Sqlite(
        join(emptyRoot, "state", "vibestar.sqlite"),
        { readonly: true },
      );
      try {
        expect(emptyAudit.prepare("SELECT id FROM ai_usage").all()).toEqual([]);
      } finally {
        emptyAudit.close();
      }
      expect(errors).toEqual([]);
      await writeFile(
        join(evidence, "results.json"),
        JSON.stringify(
          {
            errors,
            task: engine.db.task(task.id),
            stages: engine.db.detail(task.id).runs.map((r) => r.stage),
            inference: "Fixtures only; no real model invocations",
          },
          null,
          2,
        ),
      );
      console.log("Gate desktop evidence", evidence);
    } catch (error) {
      await (
        await app.firstWindow()
      )
        .screenshot({ path: join(evidence, "failure.png") })
        .catch(() => {});
      console.log("Gate desktop failure evidence", evidence);
      throw error;
    } finally {
      if (forward) engine.off("event", forward);
      await app.close();
      await rpc.close();
      await engine.close();
    }
  },
  60000,
);
