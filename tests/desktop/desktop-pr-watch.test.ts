import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { _electron } from "playwright-core";
import { it, expect, vi } from "vitest";

import { Rpc } from "../../backend/rpc";
import type { PRWatchContext } from "../../backend/review/pr/watch-github";
import { createFixtureEngine } from "../helpers/fixtures";
import { PRFixtureProvider } from "../helpers/pr-fixtures";

const require = createRequire(import.meta.url);

it.skipIf(process.env.VIBESTAR_PR_DESKTOP_TEST !== "1")(
  "automatically watches once per launch, batches classification, rechecks and stops concurrent reads through Electron",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-pr-watch-desktop-"));

    const engine = await createFixtureEngine(
      join(dir, "fixture"),
      () =>
        new PRFixtureProvider({
          "https://github.com/upstream/project/pull/2": {
            needs_review: false,
            reason: "You answered and supplied test links; waiting for the reviewer.",
            source_ids: ["comment-2", "reply-2"],
          },
        }),
    );

    const rpc = new Rpc(engine);

    const prs = Array.from({ length: 5 }, (_, index) => ({
      url: `https://github.com/upstream/project/pull/${index + 1}`,
      title: `Contribution ${index + 1}`,
      repository: "upstream/project",
      number: index + 1,
      state: "OPEN",
      head_branch: "feature",
      head_repository: "akshajrawat/project",
      head_sha: "a".repeat(40),
      updated_at: "2026-10-27T00:00:00Z",
      task_id: null,
    }));

    vi.spyOn(rpc.github.client, "detect").mockResolvedValue({
      installed: true,
      connected: true,
      username: "akshajrawat",
      version: "fixture",
      error: null,
    });

    const metadata = vi.spyOn(rpc.github.client, "authored").mockResolvedValue(prs);
    vi.spyOn(rpc.github.client, "api").mockRejectedValue(new Error("Unexpected live GitHub read"));

    const reader = vi.spyOn(rpc.prWatch.reader, "read").mockImplementation(async (url) => {
      const number = Number(url.split("/").at(-1));
      return {
        url,
        title: `Contribution ${number}`,
        body: "Closes #10: migrate the test",
        lifecycle: "OPEN",
        updated_at: "2026-10-27T00:00:00Z",
        head: "a".repeat(40),
        viewer: "akshajrawat",
        review_decision: number === 2 ? "CHANGES_REQUESTED" : null,
        requested_reviewers: number === 2 ? 1 : 0,
        issues: [
          {
            url: "https://github.com/upstream/project/issues/10",
            title: "Migrate test",
            body: "Original issue requirements",
            state: "OPEN",
          },
        ],
        sources:
          number === 4
            ? []
            : [
                {
                  id: `comment-${number}`,
                  author: number === 3 ? "AkshaJRawat" : "reviewer",
                  body: "Please update the test.",
                  url: `${url}#issuecomment-${number}`,
                  kind: "comment",
                  createdAt: "2026-10-01T10:00:00Z",
                },
                ...(number === 2
                  ? [
                      {
                        id: "reply-2",
                        author: "akshajrawat",
                        body: "Addressed the request; here are both test links.",
                        url: `${url}#issuecomment-reply`,
                        kind: "comment",
                        createdAt: "2026-10-02T10:00:00Z",
                      },
                    ]
                  : []),
              ],
        complete: true,
      } satisfies PRWatchContext;
    });

    const emptyRoot = join(dir, "empty-core");
    const empty = await createFixtureEngine(emptyRoot);
    await empty.close();
    const home = join(dir, "isolated-home");
    const cli = join(dir, "blocked-cli");
    await mkdir(home);
    await mkdir(cli);
    for (const name of ["codex", "agy", "gh"])
      await writeFile(join(cli, name), "#!/bin/sh\necho 'Real CLI disabled' >&2\nexit 1\n", {
        mode: 0o755,
      });

    const app = await _electron.launch({
      executablePath: require("electron") as string,
      args: [resolve(".")],
      env: {
        ...process.env,
        HOME: home,
        PATH: `${cli}:${process.env.PATH}`,
        VIBESTAR_HOME: emptyRoot,
        VIBESTAR_USER_DATA: join(dir, "profile"),
      },
    });

    let forward: ((event: unknown) => void) | undefined;
    try {
      const page = await app.firstWindow();
      page.setDefaultTimeout(15000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();

      await page.exposeFunction("fixtureRpc", (method: string, params: unknown) =>
        rpc.call(method, params),
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
            ({ BrowserWindow }, payload) =>
              BrowserWindow.getAllWindows()[0]?.webContents.send("core:event", payload),
            event,
          )
          .catch(() => {});
      };

      engine.on("event", forward);
      await page.reload();
      await expect.poll(() => rpc.prWatch.snapshot()?.status).toBe("completed");
      expect(metadata).toHaveBeenCalledOnce();
      expect(reader).toHaveBeenCalledTimes(5);

      expect(
        engine.db.all("SELECT id FROM utility_runs WHERE purpose='PR watch attention check'"),
      ).toHaveLength(1);

      expect(engine.db.all("SELECT id FROM pr_analyses")).toEqual([]);
      await page.getByRole("button", { name: "Pull Requests", exact: true }).click();
      await page.getByText("Checked 5 open PRs", { exact: true }).waitFor();

      expect(
        await page.locator(".pr-list").getByText("Needs review", { exact: true }).count(),
      ).toBe(2);

      expect(
        await page.locator(".pr-list").getByText("No action needed", { exact: true }).count(),
      ).toBe(2);

      expect(
        await page.locator(".pr-list").getByText("Waiting for reviewer", { exact: true }).count(),
      ).toBe(1);

      await page.getByRole("button", { name: "Contribution 2", exact: true }).click();
      await page.getByRole("region", { name: "Latest PR check" }).waitFor();

      await page
        .getByText("You answered and supplied test links; waiting for the reviewer.", {
          exact: true,
        })
        .last()
        .waitFor();

      await page.screenshot({
        animations: "disabled",
        path: join(dir, "answered-review-detail.png"),
      });

      await page.getByRole("button", { name: "Close PR details" }).click();

      expect(await page.getByText(/Checking PR 1 of/).count()).toBe(0);

      expect(await page.getByRole("button", { name: "Check open PRs", exact: true }).count()).toBe(
        0,
      );

      await page.screenshot({
        animations: "disabled",
        path: join(dir, "automatic-watch-results.png"),
      });

      await page.getByRole("button", { name: "Recheck open PRs", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => metadata.mock.calls.length).toBe(2);
      await expect.poll(() => rpc.prWatch.snapshot()?.status).toBe("completed");

      expect(
        engine.db.all("SELECT id FROM utility_runs WHERE purpose='PR watch attention check'"),
      ).toHaveLength(1);

      await page.getByRole("button", { name: "Repositories", exact: true }).click();
      await page.getByRole("button", { name: "Pull Requests", exact: true }).click();
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      expect(metadata).toHaveBeenCalledTimes(2);

      reader.mockImplementation(
        async (_url, signal) =>
          new Promise<never>((_, reject) =>
            signal.addEventListener("abort", () => reject(new Error("Stopped")), { once: true }),
          ),
      );

      await page.getByRole("button", { name: "Recheck open PRs", exact: true }).click();
      await page.getByText(/Reading 5 PR conversations concurrently/).waitFor();
      expect(await page.getByRole("button", { name: "Stop PR check" }).count()).toBe(1);

      await page.screenshot({
        animations: "disabled",
        path: join(dir, "concurrent-watch-progress.png"),
      });

      await page.getByRole("button", { name: "Stop PR check" }).click();
      await expect.poll(() => rpc.prWatch.snapshot()?.status).toBe("cancelled");
      expect(errors).toEqual([]);
      process.stdout.write(`Quick PR watch Electron evidence: ${dir}\n`);
    } finally {
      if (forward) engine.off("event", forward);
      await app.close();
      await rpc.close();
      await engine.close();
      vi.restoreAllMocks();
      if (!process.env.VIBESTAR_KEEP_EVIDENCE) await rm(dir, { recursive: true, force: true });
    }
  },
  60000,
);
