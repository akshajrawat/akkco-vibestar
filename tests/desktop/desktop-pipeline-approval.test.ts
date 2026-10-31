import { it, expect, vi } from "vitest";
import { _electron } from "playwright-core";
import Sqlite from "better-sqlite3";

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { Rpc } from "../../backend/rpc";
import { defaultSettings, now, parseIssue } from "../../backend/domain";
import { createFixtureEngine, fixtureRepository, FixtureProvider } from "../helpers/fixtures";

const require = createRequire(import.meta.url);

it.skipIf(process.env.VIBESTAR_GATE_DESKTOP_TEST !== "1")(
  "visually exercises the real Electron renderer and IPC with fixture-only review gates and prompts",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-gate-desktop-"));
    const evidence = join(dir, "screenshots");
    await mkdir(evidence);

    const engine = await createFixtureEngine(join(dir, "fixture-data"), (stage, provider) => ({
      ...new FixtureProvider(async () => new Promise<void>((resolve) => setTimeout(resolve, 1800))),
      name: provider || (stage === 1 || stage === 5 ? "antigravity" : "codex"),
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

      await page.exposeFunction("fixtureRpc", async (method: string, params: unknown) =>
        method === "pr.watch.start"
          ? null
          : method === "providers.detect"
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
            ({ BrowserWindow }, payload) =>
              BrowserWindow.getAllWindows()[0]?.webContents.send("core:event", payload),
            event,
          )
          .catch(() => {});
      };

      engine.on("event", forward);

      await page.getByRole("button", { name: "Repositories", exact: true }).click();
      await page.getByRole("heading", { name: "Repositories", exact: true }).waitFor();
      const repositoryActions = await page.locator(".active-repository-actions").boundingBox();
      const repositoryHeading = await page.locator(".active-repository-heading").boundingBox();
      expect(repositoryActions!.x).toBeGreaterThan(repositoryHeading!.x + repositoryHeading!.width);
      await page.screenshot({ path: join(evidence, "repositories-aligned.png") });

      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Agents & Models", exact: true }).click();
      const planSettings = page.getByRole("region", { name: "1 · Plan", exact: true });
      await planSettings.getByRole("combobox", { name: "Provider", exact: true }).click();
      await page.getByRole("option", { name: "Codex", exact: true }).click();
      await planSettings.getByRole("combobox", { name: "Model", exact: true }).click();
      await page.getByRole("option", { name: "next-model", exact: true }).click();

      const refinementSettings = page.getByRole("region", {
        name: "2 · Plan refinement",
        exact: true,
      });

      await refinementSettings.getByRole("combobox", { name: "Provider", exact: true }).click();
      await page.getByRole("option", { name: "Antigravity", exact: true }).click();
      await page.screenshot({ path: join(evidence, "pipeline-providers.png") });
      await page.setViewportSize({ width: 900, height: 900 });

      expect(
        await page
          .locator(".stage-settings .pipeline-config > label")
          .evaluateAll((labels) =>
            labels.every((label) => label.getBoundingClientRect().width > 140),
          ),
      ).toBe(true);

      await page.screenshot({ path: join(evidence, "pipeline-providers-narrow.png") });
      await page.setViewportSize({ width: 1440, height: 940 });
      await page.getByRole("button", { name: "Save settings", exact: true }).click();
      await expect.poll(() => engine.db.settings().antigravity.provider).toBe("codex");
      expect(engine.db.settings().codex_plan.provider).toBe("antigravity");
      expect(engine.db.settings().antigravity_review?.provider).toBe("antigravity");

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
      await expect.poll(() => page.locator(".current-run").innerText()).toContain("Codex");
      await page.screenshot({ path: join(evidence, "current-run.png") });
      await page.getByRole("button", { name: "Approve → Plan refinement" }).waitFor();
      expect(await page.locator(".secondary-workspace .approval-tray").count()).toBe(1);
      expect(await page.locator(".chat-main .approval-tray, .validation-turn").count()).toBe(0);
      expect(engine.db.detail(task.id).runs).toHaveLength(1);
      expect(await page.getByRole("dialog", { name: "Stage review required" }).count()).toBe(0);
      await page.screenshot({ path: join(evidence, "review-required.png") });
      await page.setViewportSize({ width: 1000, height: 800 });
      await page.getByRole("dialog", { name: "Secondary workspace" }).waitFor();
      await page.getByRole("button", { name: "Request changes", exact: true }).click();

      await expect
        .poll(() =>
          page.getByLabel("Task conversation").evaluate((node) => node === document.activeElement),
        )
        .toBe(true);

      expect(await page.getByRole("combobox", { name: "Message action" }).count()).toBe(0);
      await page.getByText("Write your feedback, then choose Send to workflow.").waitFor();

      expect(engine.db.detail(task.id).runs).toHaveLength(1);
      await page.setViewportSize({ width: 1440, height: 940 });
      await page.getByLabel("Toggle secondary workspace").click();
      await page.getByRole("button", { name: "View plan", exact: true }).click();
      await page.locator(".secondary-content").getByText("Fixture plan", { exact: true }).waitFor();
      await page.locator(".plan-comparison .run-prompt summary").first().click();

      expect(await page.locator(".plan-comparison .run-prompt pre").first().innerText()).toContain(
        "This is the issue : Review-gated fixture task",
      );

      await page.screenshot({
        path: join(evidence, "antigravity-plan-prompt.png"),
      });

      await page.getByRole("button", { name: "Approve → Plan refinement" }).click();
      await page.getByRole("button", { name: "Approve → Implement" }).waitFor();
      expect(engine.db.detail(task.id).runs).toHaveLength(2);
      expect(await page.getByRole("dialog", { name: "Stage review required" }).count()).toBe(0);
      await page.getByRole("button", { name: "View plan", exact: true }).click();
      await page.screenshot({ path: join(evidence, "codex-plan-gate.png") });
      await page.getByRole("button", { name: "Approve → Implement" }).click();
      await page.getByRole("button", { name: "Approve → Review" }).waitFor();

      expect(
        await page.getByRole("button", { name: "Prepare missing checks", exact: true }).count(),
      ).toBe(0);

      await page.getByRole("tab", { name: "Workflow", exact: true }).click();
      expect(await page.locator(".pipeline-step").count()).toBe(5);
      await page.getByRole("button", { name: "View tests", exact: true }).click();
      expect(await page.getByRole("tab", { name: "Changes", exact: true }).count()).toBe(1);
      expect(await page.locator(".monaco-diff-editor").count()).toBe(0);
      await page.getByRole("button", { name: "Open in VS Code", exact: true }).waitFor();

      await page.screenshot({
        path: join(evidence, "implementation-review-gate.png"),
      });

      await page.getByRole("button", { name: "Approve → Review" }).click();
      await page.getByRole("button", { name: "Open terminal", exact: true }).waitFor();

      expect(await page.getByRole("button", { name: "Accept review", exact: true }).count()).toBe(
        0,
      );

      await page.getByRole("tab", { name: "Final review", exact: true }).click();

      await page
        .locator(".secondary-content")
        .getByText("Fixture final review", { exact: true })
        .waitFor();

      await page
        .locator(".secondary-content")
        .getByText("View result details", { exact: true })
        .click();

      await page.locator(".secondary-content").getByText("remote CI", { exact: true }).waitFor();
      await page.screenshot({ path: join(evidence, "final-review.png") });
      await page.getByRole("button", { name: "Open terminal" }).waitFor();
      await page.getByRole("tab", { name: "Workflow", exact: true }).click();
      const panel = await page.locator(".engineering-panel").boundingBox();
      const stages = await page.locator(".pipeline-stages").boundingBox();
      expect(stages!.x - panel!.x).toBeGreaterThanOrEqual(20);
      expect(await page.locator(".workspace-tab-selection").count()).toBe(0);

      await page.screenshot({
        animations: "disabled",
        path: join(evidence, "workflow-spacing-restored.png"),
      });

      await page.getByRole("tab", { name: "Changes", exact: true }).click();
      await page.getByRole("button", { name: "Open full diff review", exact: true }).click();
      await page.getByLabel("Task changes").getByText("A", { exact: true }).waitFor();

      const fullHeight = await page
        .locator(".secondary-expanded")
        .evaluate((element) => element.getBoundingClientRect().height);

      const workspaceHeight = await page
        .locator(".workspace")
        .evaluate((element) => element.getBoundingClientRect().height);

      expect(fullHeight).toBeGreaterThan(workspaceHeight * 0.85);
      await page.screenshot({ path: join(evidence, "changes-maximized.png") });
      await page.getByLabel("Return to chat").click();
      vi.stubEnv("HOME", isolatedHome);
      vi.stubEnv("SHELL", "/bin/bash");
      vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
      await page.getByLabel("Toggle utility dock").click();
      await page.getByRole("button", { name: "Close shell", exact: true }).waitFor();

      const terminal = page.locator(".terminal-surface textarea");

      await expect
        .poll(() => terminal.evaluate((element) => element === document.activeElement))
        .toBe(true);

      await page.keyboard.type("pwd; git remote get-url origin; git branch --show-current");
      await page.keyboard.press("Enter");

      await expect
        .poll(
          async () =>
            ((await rpc.call("terminal.status", { id: task.id })) as { output: string }).output,
        )
        .toContain(repo.upstream_url);

      await page.screenshot({ path: join(evidence, "terminal-open-focused.png") });

      await page.keyboard.press("Control+`");
      expect(await page.locator(".utility-dock").isVisible()).toBe(false);
      await page.keyboard.press("Control+`");

      await expect
        .poll(() => terminal.evaluate((element) => element === document.activeElement))
        .toBe(true);

      await page.getByLabel("Maximize utility dock").click();
      const terminalBefore = await rpc.call("terminal.status", { id: task.id });
      await page.getByLabel("Restore utility dock").click();
      await page.getByLabel("Maximize utility dock").click();
      const terminalAfter = await rpc.call("terminal.status", { id: task.id });

      expect(terminalAfter).toMatchObject({
        session_id: (terminalBefore as { session_id: string }).session_id,
      });

      await page.screenshot({ path: join(evidence, "terminal-maximized.png") });
      await page.getByRole("button", { name: "Close shell", exact: true }).click();
      await page.getByRole("button", { name: "Start terminal", exact: true }).waitFor();
      await page.getByLabel("Restore utility dock").click();

      await engine.runCommand(task.id, [
        process.execPath,
        "-e",
        "console.log('desktop verification passed'); console.error('verification stderr retained')",
      ]);

      await page.getByRole("tab", { name: "Checks", exact: true }).click();
      await page.getByText("Advanced evidence and tools", { exact: true }).click();

      await expect
        .poll(() => page.getByLabel("Selected command output").innerText())
        .toContain("desktop verification passed");

      expect(await page.getByLabel("Selected command output").innerText()).toContain(
        "verification stderr retained",
      );

      await page.getByLabel("Expand workspace tool").click();

      await page.screenshot({
        path: join(evidence, "test-output-maximized.png"),
      });

      await page.getByLabel("Return to chat").click();
      await page.getByRole("tab", { name: "Usage", exact: true }).first().click();
      await page.getByText("Review", { exact: true }).first().waitFor();
      await page.screenshot({ path: join(evidence, "task-usage.png") });
      await page.getByRole("tab", { name: "Run details", exact: true }).click();
      await page.getByLabel("Expand workspace tool").click();
      const toolTitle = await page.locator(".secondary-heading strong").boundingBox();
      const runPicker = await page.getByRole("combobox", { name: "Inspect run" }).boundingBox();
      expect(Math.abs(toolTitle!.x - runPicker!.x)).toBeLessThan(2);
      await page.screenshot({ path: join(evidence, "run-details-aligned.png") });
      await page.getByLabel("Return to chat").click();
      await page.getByRole("button", { name: "View sent prompts", exact: true }).click();
      await page.getByRole("dialog", { name: "Agent prompts" }).waitFor();

      expect(
        await page.getByRole("dialog", { name: "Agent prompts" }).locator(".run-prompt").count(),
      ).toBe(4);

      await page.screenshot({ path: join(evidence, "all-sent-prompts.png") });

      await page
        .getByRole("dialog", { name: "Agent prompts" })
        .getByRole("button", { name: "Close", exact: true })
        .click();

      await page.getByLabel("Collapse secondary workspace").click();
      await page.screenshot({ path: join(evidence, "sidebar-collapsed.png") });

      const idleTask = {
        id: randomUUID(),
        repo_id: repo.id,
        issue_number: 26832,
        issue_url: "https://github.com/fixture/fixture/issues/26832",
        claimed_scope: "",
        notes: "",
        issue: { title: "Plan a contribution before starting" },
        error: null,
        status: "not_started" as const,
        stage: 0,
        worktree_path: "",
        branch_name: "",
        base_branch: "main",
        base_commit_sha: "",
        execution_settings: {
          ...defaultSettings,
          antigravity: { model: "gemini-3.8-flash-high", effort: "high", timeout_secs: 60 },
          codex_plan: { model: "gpt-6.1-sol", effort: "xhigh", timeout_secs: 60 },
          codex_implementation: { model: "gpt-6-luna", effort: "high", timeout_secs: 60 },
        },
        created_at: now(),
        updated_at: now(),
      };

      engine.db.saveTask(idleTask);
      forward({ event: "changed", task_id: idleTask.id });
      await page.getByRole("button", { name: /Issue #26832/ }).click();
      await page.getByRole("heading", { name: "Workflow not started", exact: true }).waitFor();
      await page.emulateMedia({ reducedMotion: "reduce" });

      for (const [width, height] of [
        [1920, 1080],
        [1440, 900],
        [1280, 720],
      ]) {
        await page.setViewportSize({ width, height });
        const sidebar = page.getByRole("complementary", { name: "Secondary workspace" });

        await expect
          .poll(() =>
            page.locator(".engineering-panel").evaluate((panel) => {
              const content = panel.parentElement!.getBoundingClientRect();
              const start = panel.querySelector(".workflow-start")!.getBoundingClientRect();
              return start.top - content.top;
            }),
          )
          .toBe(20);

        expect(await sidebar.evaluate((panel) => panel.scrollWidth <= panel.clientWidth)).toBe(
          true,
        );

        const button = page.getByRole("button", { name: "Start workflow", exact: true });
        const startButton = await button.boundingBox();
        const timeline = await page.locator(".pipeline-stages").boundingBox();
        expect(timeline!.y - startButton!.y - startButton!.height).toBeGreaterThanOrEqual(18);
        await button.focus();
        expect(await button.evaluate((element) => element === document.activeElement)).toBe(true);
        await page.keyboard.press("Tab");

        expect(
          await page
            .getByLabel("Actions for Prepare workspace")
            .evaluate((element) => element === document.activeElement),
        ).toBe(true);

        await page.screenshot({ path: join(evidence, `workflow-idle-${width}.png`) });
      }

      await page.getByLabel("Expand workspace tool").click();
      await page.getByLabel("Return to chat").waitFor();
      await page.screenshot({ path: join(evidence, "workflow-idle-expanded.png") });
      await page.keyboard.press("Escape");

      expect(
        await page
          .getByLabel("Expand workspace tool")
          .evaluate((element) => element === document.activeElement),
      ).toBe(true);

      await page.setViewportSize({ width: 1000, height: 800 });
      const drawer = page.getByRole("dialog", { name: "Secondary workspace" });
      await drawer.waitFor();
      expect(await drawer.evaluate((panel) => panel.scrollWidth <= panel.clientWidth)).toBe(true);
      await page.screenshot({ path: join(evidence, "workflow-idle-drawer.png") });
      await page.keyboard.press("Escape");

      expect(
        await page
          .getByLabel("Toggle secondary workspace")
          .evaluate((element) => element === document.activeElement),
      ).toBe(true);

      expect(engine.db.detail(idleTask.id).runs).toEqual([]);

      const emptyAudit = new Sqlite(join(emptyRoot, "state", "vibestar.sqlite"), {
        readonly: true,
      });

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
      vi.unstubAllEnvs();
      await rpc.close();
      await engine.close();
    }
  },
  60000,
);
