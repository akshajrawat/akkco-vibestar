import { createFixtureEngine } from "../helpers/fixtures";
import { it, expect } from "vitest";
import { _electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checked } from "../../backend/execution/runtime/process";
import type { Snapshot } from "../../src/lib/types";
const require = createRequire(import.meta.url);

it.skipIf(process.env.VIBESTAR_REPOSITORIES_TEST !== "1")(
  "connects the real Oppia checkout and verifies explicit task selection in Electron",
  async () => {
    const source = "/home/aksha/oppia";
    const before = {
      branch: await checked("git", ["branch", "--show-current"], source),
      status: await checked("git", ["--no-optional-locks", "status", "--porcelain=v1"], source),
      diff: await checked("git", ["diff", "--binary", "HEAD"], source),
      config: await readFile(join(source, ".git", "config"), "utf8"),
    };
    const dir = await mkdtemp(join(tmpdir(), "vibestar-desktop-repositories-"));
    const root = join(dir, "data");
    const engine = await createFixtureEngine(root);
    engine.db.run(
      "INSERT INTO settings VALUES('github_watch',?)",
      JSON.stringify({
        auto_watch: false,
        interval_minutes: 60,
        verify_codex: false,
      }),
    );
    await engine.close();
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
      await page.getByRole("button", { name: "Repositories", exact: true }).click();
      await page.getByText("No active repositories", { exact: true }).waitFor();
      await page.screenshot({ path: join(evidence, "repositories-empty.png") });
      await page
        .getByRole("button", { name: "Connect local repository", exact: true })
        .first()
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Connect local repository",
        exact: true,
      });
      await dialog.getByLabel("WSL", { exact: true }).check();
      await dialog.getByLabel("Path", { exact: true }).fill(source);
      await dialog.getByRole("button", { name: "Verify repository", exact: true }).click();
      await dialog.getByText("Repository verified", { exact: true }).waitFor();
      expect(await dialog.getByLabel("Upstream repository").inputValue()).toBe("upstream");
      expect(await dialog.getByLabel("Origin / fork").inputValue()).toBe("origin");
      expect(await dialog.getByLabel("Base branch").inputValue()).toBe("develop");
      expect(await dialog.innerText()).toContain(before.branch);
      expect(
        await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      await page.screenshot({ path: join(evidence, "oppia-verified.png") });
      await dialog.getByRole("button", { name: "Connect repository", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "Details and actions for oppia/oppia" }).click();
      await page.locator(".active-repository-row").getByText(source, { exact: true }).waitFor();
      await page.screenshot({
        path: join(evidence, "active-repositories.png"),
      });
      const snapshot = await page.evaluate(() => window.vibestar.rpc<Snapshot>("snapshot"));
      const repo = snapshot.repositories.find((r) => r.path === source)!;
      expect(repo).toMatchObject({
        source: "imported",
        connected: true,
        base_branch: "develop",
        owner: "oppia",
        name: "oppia",
      });
      expect(await page.evaluate(() => window.vibestar.rpc("repositories.index"))).toMatchObject({
        last_scan: null,
      });
      await page.getByRole("button", { name: "New task", exact: true }).first().click();
      const taskDialog = page.getByRole("dialog", {
        name: "New task",
        exact: true,
      });
      expect(await taskDialog.getByLabel("Repository", { exact: true }).inputValue()).toBe(repo.id);
      await taskDialog.getByLabel("Issue URL").fill("https://github.com/oppia/oppia/issues/26831");
      await taskDialog.locator(".resolved-issue strong").waitFor({ timeout: 60000 });
      expect(await taskDialog.innerText()).toContain("Matched from issue URL");
      expect(await taskDialog.innerText()).toContain(root + "/worktrees/" + repo.id);
      expect(
        await taskDialog.getByRole("button", { name: "Create task", exact: false }).isEnabled(),
      ).toBe(true);
      await page.screenshot({ path: join(evidence, "new-task-oppia.png") });
      await taskDialog.getByLabel("Issue URL").fill("https://github.com/facebook/react/issues/1");
      await taskDialog.getByText("Repository mismatch", { exact: true }).waitFor();
      expect(
        await taskDialog.getByRole("button", { name: "Create task", exact: false }).isEnabled(),
      ).toBe(false);
      await page.screenshot({
        path: join(evidence, "repository-mismatch.png"),
      });
      await taskDialog.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("button", { name: "Details and actions for oppia/oppia" }).click();
      await page
        .locator(".active-repository-row")
        .getByRole("button", { name: "Verify", exact: true })
        .click();
      await page.locator(".active-repository-row").getByRole("status").waitFor();
      await page.evaluate(
        (id) => window.vibestar.rpc("repository.disconnect", { id, confirmed: true }),
        repo.id,
      );
      await page.getByText("No active repositories", { exact: true }).waitFor();
      expect(errors).toEqual([]);
      await writeFile(
        join(evidence, "results.json"),
        JSON.stringify(
          {
            source,
            repo,
            errors,
            beforeBranch: before.branch,
            checks: [
              "explicit manual verification and connection",
              "upstream/origin/develop recognized",
              "no automatic scan",
              "selected repository visible in task preview",
              "real issue preview",
              "mismatch blocked",
              "disconnect preserves source",
            ],
            inference: "No new AI runs; fixture pipeline isolation is covered separately",
          },
          null,
          2,
        ),
      );
      console.log("Repository connection evidence", evidence);
    } catch (error) {
      const page = await app.firstWindow();
      await page.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
      console.log(await page.locator("body").innerText());
      throw error;
    } finally {
      await app.close();
      expect(await checked("git", ["branch", "--show-current"], source)).toBe(before.branch);
      expect(
        await checked("git", ["--no-optional-locks", "status", "--porcelain=v1"], source),
      ).toBe(before.status);
      expect(await checked("git", ["diff", "--binary", "HEAD"], source)).toBe(before.diff);
      expect(await readFile(join(source, ".git", "config"), "utf8")).toBe(before.config);
      if (process.env.VIBESTAR_KEEP_EVIDENCE !== "1")
        await rm(dir, { recursive: true, force: true });
    }
  },
  180000,
);
