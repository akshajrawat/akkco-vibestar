import { it, expect } from "vitest";
import { _electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Engine } from "../backend/execution/engine";
import { parseIssue, defaultSettings } from "../backend/domain";
import {
  fixtureRepository,
  FixtureProvider,
  finishFixtureTask as waitForTask,
} from "./fixtures";
import type { Detail, Detection, Snapshot } from "../src/lib/types";
const require = createRequire(import.meta.url);

it.skipIf(process.env.VIBESTAR_DESKTOP_TEST !== "1")(
  "checks milestone workflows in real Electron with authenticated official providers",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-desktop-milestone-"));
    const root = join(dir, "data");
    const engine = await Engine.create(root, () => new FixtureProvider());
    let taskId = "";
    try {
      const { repo, upstream } = await fixtureRepository(engine, dir);
      const task = engine.enqueue(
        repo,
        parseIssue("https://github.com/fixture/fixture/issues/1"),
        "Keyboard verification",
        "",
        {},
      );
      taskId = task.id;
      await waitForTask(
        engine,
        task.id,
        (status) => status === "ready_for_review",
      );
      engine.db.run(
        "INSERT INTO settings VALUES('github_watch',?)",
        JSON.stringify({
          auto_watch: false,
          interval_minutes: 60,
          verify_codex: false,
        }),
      );
      engine.db.saveSettings({
        ...defaultSettings,
        utility_ai: {
          provider: "codex",
          model: "gpt-6.1-sol",
          effort: "low",
          timeout_secs: 120,
        },
        repository_discovery: {
          roots: [upstream],
          max_depth: 4,
          scan_home: false,
        },
      });
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
        .getByRole("button", { name: "Providers", exact: true })
        .click();
      const detections = await page.evaluate(() =>
        window.vibestar.rpc<Detection[]>("providers.detect"),
      );
      expect(
        detections
          .filter((d) => d.connected)
          .map((d) => d.provider)
          .sort(),
      ).toEqual(["antigravity", "codex", "github"]);
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect
        .poll(() => page.locator(".provider-info .success").count())
        .toBe(3);
      expect(
        detections.find((d) => d.provider === "antigravity")!.models.length,
      ).toBeGreaterThan(0);
      await page.screenshot({ path: join(evidence, "electron-providers.png") });
      await page.evaluate(() => window.vibestar.rpc("github.sync"));
      const github = await page.evaluate(() =>
        window.vibestar.rpc<Snapshot>("snapshot"),
      );
      expect(github.github?.status?.connected).toBe(true);
      expect(github.github?.error).toBeNull();
      const pr = github.github?.pull_requests.find((p) => p.state === "OPEN");
      if (pr) {
        const job = await page.evaluate(
          (url) =>
            window.vibestar.rpc<{ id: string }>("scheduled.add", {
              url,
              task_id: null,
              interval_minutes: 60,
              verify_codex: false,
            }),
          pr.url,
        );
        await expect
          .poll(
            () =>
              page.evaluate(async (id) => {
                const watched = (
                  await window.vibestar.rpc<Snapshot>("snapshot")
                ).scheduled?.find((j) => j.id === id);
                return watched?.status === "error"
                  ? "error"
                  : watched?.last_snapshot
                    ? "done"
                    : "pending";
              }, job.id),
            { timeout: 180000 },
          )
          .not.toBe("pending");
        const snapshot = await page.evaluate(() =>
          window.vibestar.rpc<Snapshot>("snapshot"),
        );
        const inspected = snapshot.scheduled!.find((j) => j.id === job.id)!;
        expect(inspected.error, inspected.error || "").toBeNull();
        expect(inspected.last_snapshot?.authenticatedUser).toBe(
          github.github?.status?.username,
        );
        expect(inspected.action?.conversationState).toBeTruthy();
        console.log(
          "Live PR decision",
          inspected.url,
          inspected.action?.conversationState,
          inspected.action?.summary,
          inspected.analysis_method,
        );
        await page.evaluate(
          (id) =>
            window.vibestar.rpc("scheduled.enabled", { id, enabled: false }),
          job.id,
        );
        await page
          .getByRole("button", { name: "PR watch", exact: true })
          .click();
        await page.getByText(inspected.title!, { exact: true }).first().click();
        await page
          .getByRole("dialog", { name: "Pull request details" })
          .waitFor();
        await page.screenshot({
          path: join(evidence, "electron-pr-conversation.png"),
        });
        await page
          .getByRole("tab", { name: "CI / Checks", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Overview", exact: true })
          .click();
        await page
          .getByRole("tab", { name: "Analysis History", exact: true })
          .click();
        await page.screenshot({
          path: join(evidence, "electron-pr-analysis.png"),
        });
        await page.getByLabel("Close PR details").click();
      }
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page
        .locator(".settings-nav")
        .getByRole("button", { name: "Repositories", exact: true })
        .click();
      await page.getByRole("button", { name: "Scan now", exact: true }).click();
      await page
        .getByText("Repositories indexed: 1", { exact: true })
        .waitFor();
      await page
        .locator(".settings-nav")
        .getByRole("button", { name: "Storage", exact: true })
        .click();
      await page.getByText(root, { exact: true }).waitFor();
      expect(await page.locator(".storage-sizes").innerText()).toContain(
        "Database",
      );
      await page.screenshot({ path: join(evidence, "electron-storage.png") });
      await page
        .locator(".settings-nav")
        .getByRole("button", { name: "Usage", exact: true })
        .click();
      await page.getByText(/Agent runs: [3-9]/).waitFor();
      await page.screenshot({ path: join(evidence, "electron-usage.png") });
      await page
        .locator(".tree-task")
        .filter({ hasText: "Keyboard verification" })
        .click();
      await page.getByLabel("Toggle utility dock").click();
      await page.getByRole("button", { name: "Start task terminal" }).click();
      await page.getByRole("button", { name: "Close shell" }).waitFor();
      const composer = page.getByLabel("Task follow-up");
      let navigations = 0;
      page.on("framenavigated", () => {
        navigations++;
      });
      await composer.fill("First line");
      await composer.press("Shift+Enter");
      await composer.pressSequentially("Second line");
      expect(await composer.inputValue()).toBe("First line\nSecond line");
      await composer.press("Enter");
      await expect.poll(() => composer.inputValue()).toBe("");
      const detail = await page.evaluate(
        (id) => window.vibestar.rpc<Detail>("task.detail", { id }),
        taskId,
      );
      expect(detail.messages.at(-1)).toMatchObject({
        content: "First line\nSecond line",
        status: "draft",
      });
      expect(navigations).toBe(0);
      await page.getByText("First line", { exact: false }).waitFor();
      await page.getByRole("button", { name: "Close shell" }).click();
      await page.getByLabel("Hide utility dock").click();
      await expect
        .poll(() => composer.getAttribute("placeholder"))
        .toBe("Ask Vibestar…");
      await page.getByLabel("Choose chat model").click();
      await page
        .getByRole("dialog", { name: "Chat model configuration" })
        .getByRole("button", { name: "low", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Chat model configuration" })
        .getByRole("button", { name: "Done", exact: true })
        .click();
      const instruction =
        "Verify that chat execution works. Do not change any files or run tests for this verification. Return the required structured implementation result with a concise summary and empty test arrays. The previous First line/Second line message was a keyboard test only.";
      await composer.fill(instruction);
      await composer.press("Enter");
      await expect.poll(() => composer.inputValue()).toBe("");
      const saved = await page.evaluate(
        (id) => window.vibestar.rpc<Detail>("task.detail", { id }),
        taskId,
      );
      expect(saved.messages.at(-1)?.content).toBe(instruction);
      await expect
        .poll(
          () =>
            page.evaluate(async (id) => {
              const task = (
                await window.vibestar.rpc<Detail>("task.detail", { id })
              ).task;
              return ["ready_for_review", "failed"].includes(task.status)
                ? task.status
                : "running";
            }, taskId),
          { timeout: 120000 },
        )
        .toBe("ready_for_review");
      const completed = await page.evaluate(
        (id) => window.vibestar.rpc<Detail>("task.detail", { id }),
        taskId,
      );
      expect(
        completed.usage?.find((r) => r.purpose === "Chat Follow-up"),
      ).toMatchObject({
        provider: "codex",
        model: "gpt-6.1-sol",
        effort: "low",
        status: "completed",
      });
      expect(navigations).toBe(0);
      await page.screenshot({
        path: join(evidence, "electron-chat.png"),
      });
      await writeFile(
        join(evidence, "results.json"),
        JSON.stringify(
          {
            detections,
            taskId,
            keyboard: { shiftEnter: true, enterSaved: true, navigations },
            github: {
              connected: github.github?.status?.connected,
              repositories: github.github?.repositories.length,
            },
            usage: completed.usage,
            watches: (
              await page.evaluate(() =>
                window.vibestar.rpc<Snapshot>("snapshot"),
              )
            ).scheduled,
            errors,
          },
          null,
          2,
        ),
      );
      expect(errors).toEqual([]);
      console.log("Electron milestone evidence:", root);
    } finally {
      await app.close();
      if (process.env.VIBESTAR_KEEP_EVIDENCE !== "1")
        await rm(dir, { recursive: true, force: true });
    }
  },
  240000,
);
