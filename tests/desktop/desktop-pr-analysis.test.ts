import { createFixtureEngine } from "../helpers/fixtures";
import { it, expect, vi } from "vitest";
import { _electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Rpc } from "../../backend/rpc";
import { GitHubMonitor } from "../../backend/scheduled/github";
import { PRFixtureProvider, prSnapshot } from "../helpers/pr-fixtures";
import type { Snapshot } from "../../src/lib/types";
import type { PRAnalysisSession } from "../../backend/review/pr/contracts";

const require = createRequire(import.meta.url);

it.skipIf(process.env.VIBESTAR_PR_DESKTOP_TEST !== "1")(
  "exercises manual tracking, explicit analysis, complete report/history and no startup inference through Electron IPC",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-pr-desktop-"));
    const engine = await createFixtureEngine(join(dir, "fixture"), () => new PRFixtureProvider());
    const monitor = new GitHubMonitor(dir);
    vi.spyOn(monitor, "inspect").mockResolvedValue(structuredClone(prSnapshot));
    const rpc = new Rpc(engine, monitor);

    const refreshMetadata = vi
      .spyOn(rpc.github, "refreshPullRequests")
      .mockImplementation(async () => ({ ...rpc.github.snapshot(), error: null }));

    vi.spyOn(rpc.prWatch.reader, "read").mockImplementation(async (url) => ({
      url,
      title: "Review fixture",
      body: "Migrate tests",
      lifecycle: "OPEN",
      updated_at: "2026-10-23T12:00:00Z",
      head: "a".repeat(40),
      viewer: "contributor",
      review_decision: null,
      requested_reviewers: 0,
      issues: [],
      sources: [],
      complete: true,
    }));

    engine.db.run(
      "INSERT INTO github_pull_requests VALUES(?,?,?)",
      "https://github.com/upstream/project/pull/1",
      JSON.stringify({
        url: "https://github.com/upstream/project/pull/1",
        repository: "upstream/project",
        number: 1,
        title: "Review fixture",
        state: "OPEN",
        head_branch: "existing-pr",
        head_repository: "contributor/project",
        updated_at: "2026-10-23T12:00:00Z",
        task_id: null,
      }),
      "2026-10-23T12:00:00Z",
    );

    for (const [number, state, title] of [
      [2, "MERGED", "Merged fixture"],
      [3, "CLOSED", "Closed fixture"],
    ] as const) {
      const url = `https://github.com/upstream/project/pull/${number}`;

      engine.db.run(
        "INSERT INTO github_pull_requests VALUES(?,?,?)",
        url,
        JSON.stringify({
          url,
          repository: "upstream/project",
          number,
          title,
          state,
          head_branch: "completed-contribution",
          head_repository: "contributor/project",
          updated_at: "2026-10-22T12:00:00Z",
          task_id: null,
        }),
        "2026-10-22T12:00:00Z",
      );
    }

    const emptyRoot = join(dir, "empty-core");
    const empty = await createFixtureEngine(emptyRoot);
    await empty.close();
    const home = join(dir, "isolated-home");
    const cli = join(dir, "blocked-cli");
    await mkdir(home);
    await mkdir(cli);
    for (const name of ["codex", "agy", "gh"])
      await writeFile(
        join(cli, name),
        "#!/bin/sh\necho 'Real provider/GitHub CLI disabled in fixture' >&2\nexit 1\n",
        { mode: 0o755 },
      );

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
      timeout: 30000,
    });

    let forward: ((event: unknown) => void) | undefined;
    try {
      const page = await app.firstWindow();
      page.setDefaultTimeout(15000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();

      await page.exposeFunction("fixtureRpc", async (method: string, params: unknown) =>
        method === "pr.watch.start" && (params as { trigger: string }).trigger === "open"
          ? null
          : method === "providers.detect"
            ? [await new PRFixtureProvider().detect()]
            : rpc.call(method, params),
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
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.getByRole("button", { name: "Pull Requests", exact: true }).click();
      await page.getByRole("heading", { name: "Pull requests", exact: true }).waitFor();

      expect(await page.getByRole("button", { name: "Merged fixture", exact: true }).count()).toBe(
        0,
      );

      await page.screenshot({ animations: "disabled", path: join(dir, "open-pr-inbox.png") });
      await page.getByRole("combobox", { name: "Filter by status" }).click();
      await page.getByRole("option", { name: /^Merged/ }).click();
      await page.getByRole("button", { name: "Merged fixture", exact: true }).waitFor();
      expect(await page.locator(".pr-list").innerText()).not.toMatch(/awaiting|not checked/i);
      await page.screenshot({ animations: "disabled", path: join(dir, "merged-pr-history.png") });
      await page.getByRole("combobox", { name: "Filter by status" }).click();
      await page.getByRole("option", { name: /^Closed/ }).click();
      await page.getByRole("button", { name: "Closed fixture", exact: true }).waitFor();
      await page.screenshot({ animations: "disabled", path: join(dir, "closed-pr-history.png") });
      await page.getByRole("combobox", { name: "Filter by status" }).click();
      await page.keyboard.press("Home");
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Review fixture", exact: true }).waitFor();
      await page.getByRole("button", { name: "Choose PR review model", exact: true }).click();
      await page.getByRole("dialog", { name: "PR review model", exact: true }).waitFor();

      await page.screenshot({
        animations: "disabled",
        path: join(dir, "compact-review-model.png"),
      });

      await page.keyboard.press("Escape");

      expect(
        await page
          .getByRole("button", { name: "Choose PR review model" })
          .evaluate((element) => element === document.activeElement),
      ).toBe(true);

      expect(engine.db.all("SELECT * FROM ai_usage")).toEqual([]);
      expect(engine.db.all("SELECT * FROM scheduled_jobs")).toEqual([]);
      expect(await page.getByLabel("PR URL").count()).toBe(0);
      await page.getByRole("button", { name: "Review fixture", exact: true }).click();
      await page.getByRole("dialog", { name: "Pull request details" }).waitFor();
      await page.getByRole("button", { name: "Close PR details" }).click();
      await page.getByRole("button", { name: "Analyze review", exact: true }).waitFor();
      expect(engine.db.all("SELECT * FROM ai_usage")).toEqual([]);
      expect(vi.mocked(monitor.inspect)).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Analyze review", exact: true }).click();

      await page
        .getByRole("heading", {
          name: "Three observations require consideration, plus positive feedback.",
          exact: true,
        })
        .waitFor();

      const snapshot = await page.evaluate(() => window.vibestar.rpc<Snapshot>("snapshot"));
      expect(snapshot.scheduled?.[0].enabled).toBe(false);
      expect(engine.db.all("SELECT * FROM scheduled_agent_runs")).toHaveLength(1);
      await page.getByRole("tab", { name: "Full Conversation", exact: true }).click();

      await page
        .getByText("Apart from that, everything seems to be fine to me.", {
          exact: true,
        })
        .waitFor();

      await page.getByRole("tab", { name: "Review Actions", exact: true }).click();
      await page.getByRole("heading", { name: "Positive feedback / information" }).waitFor();

      expect(
        await page.getByRole("button", { name: "Solve Review", exact: true }).isDisabled(),
      ).toBe(false);

      await page.getByRole("tab", { name: "Analysis History", exact: true }).click();
      await page.getByText(/input 50/).waitFor();
      await page.getByRole("button", { name: "Raw stdout", exact: true }).click();
      await page.getByText("Saved redacted provider output", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Analyze Again", exact: true }).last().click();
      const jobId = snapshot.scheduled![0].id;

      await expect
        .poll(async () => {
          const detail = await page.evaluate(
            (id) =>
              window.vibestar.rpc<{ analyses: PRAnalysisSession[] }>("scheduled.detail", { id }),
            jobId,
          );

          return detail.analyses[0].method;
        })
        .toBe("reused");

      expect(engine.db.all("SELECT * FROM scheduled_agent_runs")).toHaveLength(1);
      await page.screenshot({ animations: "disabled", path: join(dir, "manual-pr-report.png") });
      await page.getByRole("button", { name: "Close PR details" }).click();

      const checkAll = page.getByRole("button", { name: "Recheck open PRs", exact: true });
      await checkAll.focus();
      await page.keyboard.press("Enter");
      expect(await page.getByRole("dialog", { name: "Analyze All" }).count()).toBe(0);
      await expect.poll(() => rpc.prWatch.snapshot()?.status).toBe("completed");
      expect(rpc.prWatch.snapshot()?.items[0].status).toBe("clear");

      expect(engine.db.all("SELECT * FROM scheduled_agent_runs")).toHaveLength(1);
      await page.getByRole("status", { name: "PR watch progress" }).waitFor();
      await page.screenshot({ animations: "disabled", path: join(dir, "v3-batch-complete.png") });

      vi.mocked(rpc.prWatch.reader.read).mockImplementationOnce(async (_url, signal) => {
        return new Promise<never>((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              setTimeout(() => reject(new Error("Cancelled fixture retrieval")), 250);
            },
            { once: true },
          ),
        );
      });

      await page.getByRole("button", { name: "Recheck open PRs", exact: true }).click();
      await page.getByText("Checking open PRs", { exact: true }).waitFor();

      await page
        .getByText(/Reading 1 PR conversations concurrently/)
        .first()
        .waitFor();

      expect(await page.getByRole("button", { name: "Stop PR check" }).count()).toBe(1);
      await page.emulateMedia({ reducedMotion: "no-preference" });

      const spinner = page
        .getByRole("status", { name: "PR watch progress" })
        .locator("svg.spinning");

      const animationTime = await spinner.evaluate((element) =>
        Number(element.getAnimations()[0]?.currentTime || 0),
      );

      await expect
        .poll(() =>
          spinner.evaluate((element) => Number(element.getAnimations()[0]?.currentTime || 0)),
        )
        .toBeGreaterThan(animationTime + 50);

      expect(await page.getByRole("button", { name: "Analyze review", exact: true }).count()).toBe(
        0,
      );

      expect(await page.getByRole("button", { name: "Cancel analysis", exact: true }).count()).toBe(
        0,
      );

      await page.screenshot({ animations: "disabled", path: join(dir, "live-check-progress.png") });
      await page.getByRole("button", { name: "Stop PR check" }).click();
      await page.getByText("Stopping PR check…", { exact: true }).waitFor();
      await page.screenshot({ animations: "disabled", path: join(dir, "stopping-check.png") });
      await expect.poll(() => rpc.prWatch.snapshot()?.status).toBe("cancelled");
      refreshMetadata.mockRestore();

      const runsBeforeRefresh = engine.db.all("SELECT id FROM scheduled_agent_runs").length;
      const inspectionsBeforeRefresh = vi.mocked(monitor.inspect).mock.calls.length;

      vi.spyOn(rpc.github.client, "detect").mockResolvedValue({
        installed: true,
        connected: true,
        username: "contributor",
        version: "fixture",
        error: null,
      });

      const metadata = vi
        .spyOn(rpc.github.client, "authored")
        .mockResolvedValue(
          rpc.github.prs().map((pr) => ({ ...pr, state: pr.number === 1 ? "MERGED" : pr.state })),
        );

      const catalog = vi
        .spyOn(rpc.github.client, "pages")
        .mockRejectedValue(new Error("PR refresh must not load the repository catalog"));

      await page.getByRole("button", { name: "Refresh PR List", exact: true }).click();
      await expect.poll(() => rpc.github.prs().find((pr) => pr.number === 1)?.state).toBe("MERGED");
      await page.getByRole("button", { name: "Refresh PR List", exact: true }).waitFor();
      await page.getByRole("combobox", { name: "Filter by status" }).click();
      await page.getByRole("option", { name: /^Merged/ }).click();
      await page.getByRole("button", { name: "Review fixture", exact: true }).waitFor();
      expect(metadata).toHaveBeenCalledOnce();
      expect(catalog).not.toHaveBeenCalled();
      expect(engine.db.all("SELECT id FROM scheduled_agent_runs")).toHaveLength(runsBeforeRefresh);
      expect(vi.mocked(monitor.inspect)).toHaveBeenCalledTimes(inspectionsBeforeRefresh);
      expect(await page.locator(".pr-list").innerText()).not.toMatch(/awaiting|not checked/i);

      await page.screenshot({
        animations: "disabled",
        path: join(dir, "bulk-metadata-refreshed.png"),
      });

      expect(errors).toEqual([]);
      process.stdout.write(`PR Electron evidence: ${dir}\n`);
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
