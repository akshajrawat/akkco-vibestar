import { it, expect } from "vitest";
import { _electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultSettings, parseIssue, now } from "../backend/domain";
import { ActionSchema } from "../backend/scheduled/action";
import {
  createFixtureEngine,
  fixtureRepository,
  FixtureProvider,
  finishFixtureTask as waitForTask,
} from "./fixtures";
import type { Detection, Snapshot } from "../src/lib/types";
const require = createRequire(import.meta.url);

it.skipIf(process.env.VIBESTAR_UX_TEST !== "1")(
  "inspects the polished screens and real cleanup blockers through Electron IPC",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-desktop-polish-"));
    const root = join(dir, "data");
    const engine = await createFixtureEngine(root, () => new FixtureProvider());
    let taskId = "";
    try {
      const { repo } = await fixtureRepository(engine, dir);
      const task = engine.enqueue(
        repo,
        parseIssue("https://github.com/fixture/fixture/issues/26829"),
        "Workspace polish",
        "",
        {},
      );
      taskId = task.id;
      await waitForTask(engine, task.id, (s) => s === "ready_for_review");
      engine.db.saveTask({
        ...engine.db.task(task.id),
        status: "cancelled",
        error: "Run cancelled",
      });
      const run = engine.db.detail(task.id).runs.at(-1)!;
      engine.db.run(
        "UPDATE agent_runs SET status='cancelled',error='Run cancelled' WHERE id=?",
        run.id,
      );
      engine.db.run(
        "INSERT INTO settings VALUES('github_watch',?)",
        JSON.stringify({
          auto_watch: false,
          interval_minutes: 60,
          verify_codex: false,
        }),
      );
      engine.db.saveSettings(defaultSettings);
      for (const [number, state, summary] of [
        [27527, "waiting_for_reviewer", "Waiting for reviewer"],
        [27500, "waiting_for_me", "@reviewer requested a mobile test"],
        [27480, "approved", "Approved"],
      ] as const) {
        const job = {
          id: `visual-${number}`,
          url: `https://github.com/oppia/oppia/pull/${number}`,
          task_id: null,
          title: "Migrate acceptance tests to Playwright",
          interval_minutes: 60,
          verify_codex: false,
          enabled: false,
          status: "idle",
          next_run_at: now(),
          last_checked_at: now(),
          last_snapshot: null,
          pending_snapshot: null,
          changes: [],
          error: null,
          analysis_method: "deterministic",
          action: ActionSchema.parse({
            manualActionRequired: state === "waiting_for_me",
            conversationState: state,
            severity: state === "waiting_for_me" ? "action_required" : "none",
            summary,
            reason:
              "The reviewer asked for a mobile test. The chronological discussion is preserved in the details drawer.",
            recommendedNextAction: "",
            affectedFiles: [],
          }),
        };
        engine.db.run(
          "INSERT INTO scheduled_jobs VALUES(?,?)",
          job.id,
          JSON.stringify(job),
        );
      }
    } finally {
      await engine.close();
    }
    const evidence = join(root, "artifacts", "verification");
    await mkdir(evidence, { recursive: true });
    const app = await _electron.launch({
      executablePath: require("electron") as string,
      args: [resolve(".")],
      env: {
        ...process.env,
        VIBESTAR_HOME: root,
        VIBESTAR_USER_DATA: join(root, "runtime", "desktop"),
      },
      timeout: 30000,
    });
    try {
      const page = await app.firstWindow();
      page.setDefaultTimeout(30000);
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();
      await page
        .getByRole("button", { name: "Pull Requests", exact: true })
        .click();
      await page.locator(".pr-inbox-row").first().waitFor();
      expect(await page.locator(".pr-row-details[open]").count()).toBe(0);
      expect(await page.locator(".pr-state").allTextContents()).toEqual(
        expect.arrayContaining([
          expect.stringContaining("WAITING FOR REVIEW"),
          expect.stringContaining("ACTION REQUIRED"),
          expect.stringContaining("APPROVED"),
        ]),
      );
      await page.screenshot({ path: join(evidence, "pr-watch.png") });
      await page.locator(".pr-row-details summary").first().click();
      await page.screenshot({ path: join(evidence, "pr-watch-details.png") });
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Storage", exact: true }).click();
      await page
        .getByRole("button", { name: "Clear logs", exact: true })
        .waitFor();
      await page.screenshot({ path: join(evidence, "settings-storage.png") });
      await page
        .getByRole("button", { name: "Providers", exact: true })
        .click();
      await expect
        .poll(() => page.locator(".provider-info .success").count(), {
          timeout: 60000,
        })
        .toBe(3);
      const providers = await page.evaluate(() =>
        window.vibestar.rpc<Detection[]>("providers.detect"),
      );
      await page.screenshot({ path: join(evidence, "providers.png") });
      await page.locator(".tree-task").first().click();
      await page.locator(".workspace-header").waitFor();
      expect(await page.locator(".workspace-header .run-error").count()).toBe(
        0,
      );
      expect(await page.locator(".workspace > .run-error").count()).toBe(0);
      expect(await page.locator(".event-timeline .run-error").count()).toBe(1);
      expect(await page.locator(".status-chip").last().textContent()).toContain(
        "Cancelled",
      );
      await page.screenshot({ path: join(evidence, "task-workspace.png") });
      await page.evaluate(
        (id) =>
          window.vibestar.rpc("terminal.open", { id, cols: 90, rows: 20 }),
        taskId,
      );
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Storage", exact: true }).click();
      await page
        .getByRole("button", { name: "Clear logs", exact: true })
        .click();
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      await page
        .getByText("Can't clean storage right now", { exact: true })
        .waitFor();
      await page
        .getByText("Task #26829 terminal session is open", { exact: true })
        .waitFor();
      await page.screenshot({ path: join(evidence, "storage-blockers.png") });
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.locator(".tree-task").first().click();
      await page
        .getByRole("button", { name: "Delete task data", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Delete selected data", exact: true })
        .click();
      await page
        .getByText("Can't delete task data right now", { exact: true })
        .waitFor();
      await page
        .getByText("Task #26829 terminal session is open", { exact: true })
        .waitFor();
      expect(await page.locator(".operation-error details[open]").count()).toBe(
        0,
      );
      expect(await page.locator(".operation-error").innerText()).not.toContain(
        "Error invoking remote method",
      );
      await page.screenshot({ path: join(evidence, "cleanup-blockers.png") });
      await page
        .getByRole("button", { name: "Stop blockers", exact: true })
        .click();
      await page
        .getByText("Blockers stopped. Try again to finish cleanup.")
        .waitFor();
      await page
        .getByRole("button", { name: "Try again", exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (
              await page.evaluate(() =>
                window.vibestar.rpc<Snapshot>("snapshot"),
              )
            ).tasks.length,
        )
        .toBe(0);
      expect(errors).toEqual([]);
      await writeFile(
        join(evidence, "results.json"),
        JSON.stringify(
          {
            taskId,
            providers: providers.map((p) => ({
              provider: p.provider,
              connected: p.connected,
            })),
            errors,
            cleanup:
              "named terminal blocker stopped and task deleted; IPC failure retained structured context",
          },
          null,
          2,
        ),
      );
      console.log("Electron polish evidence:", evidence);
    } catch (failure) {
      const page = await app.firstWindow();
      await page.screenshot({ path: join(evidence, "failure.png") });
      await writeFile(
        join(evidence, "failure.txt"),
        await page.locator("body").innerText(),
      );
      throw failure;
    } finally {
      await app.close();
      if (process.env.VIBESTAR_KEEP_EVIDENCE !== "1")
        await rm(dir, { recursive: true, force: true });
    }
  },
  120000,
);
