import { createFixtureEngine } from "../helpers/fixtures";
import { it, expect } from "vitest";
import { _electron } from "playwright-core";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checked } from "../../backend/execution/runtime/process";
import { defaultSettings, now, type Task } from "../../backend/domain";
import { StorageService } from "../../backend/storage/service";
import type { Detail, Snapshot } from "../../src/lib/types";

const require = createRequire(import.meta.url);

it.skipIf(process.env.VIBESTAR_PRODUCT_DESKTOP_TEST !== "1")(
  "verifies live Oppia pipeline, selected-code AI, usage, editors and clone progress in real Electron",
  async () => {
    const source = "/home/aksha/oppia";
    const cloneRepository = "akshajrawat/DSA-daily";

    const before = {
      branch: await checked("git", ["branch", "--show-current"], source),
      status: await checked("git", ["--no-optional-locks", "status", "--porcelain=v1"], source),
      diff: await checked("git", ["diff", "--binary", "HEAD"], source),
      config: await readFile(join(source, ".git", "config"), "utf8"),
    };

    const dir = await mkdtemp(join(tmpdir(), "vibestar-product-desktop-"));
    const reuse = process.env.VIBESTAR_PRODUCT_REUSE_ROOT;
    const root = reuse || join(dir, "data");
    const evidence = join(root, "artifacts", "verification");
    const engine = await createFixtureEngine(root);
    let id: Task["id"] = randomUUID();
    let reusedReady = false;
    let success = false;
    let file = `.vibestar-quality-${id.slice(0, 8)}.txt`;
    try {
      if (reuse) {
        const previous = engine.db
          .tasks()
          .find(
            (t) => t.issue_number === 26831 && t.claimed_scope.startsWith(".vibestar-quality-"),
          );

        if (!previous) throw new Error("Reuse requires the private Oppia acceptance task");
        id = previous.id;
        file = previous.claimed_scope;

        const implemented = engine.db
          .detail(previous.id)
          .runs.some((r) => r.stage === 3 && r.status === "completed");

        if (
          implemented &&
          previous.worktree_path &&
          (await readFile(join(previous.worktree_path, file), "utf8")) ===
            "vibestar product quality verified\nread-only review context\n"
        ) {
          await engine.git.assertTask(previous);
          reusedReady = true;
        } else if (!previous.worktree_path)
          await engine.git.prepare(engine.db.repository(previous.repo_id), previous);

        engine.db.saveTask({
          ...previous,
          status: reusedReady ? "ready_for_review" : "cancelled",
          stage: reusedReady
            ? 5
            : engine.db.all(
                  "SELECT id FROM task_artifacts WHERE task_id=? AND stage=2",
                  previous.id,
                ).length
              ? 3
              : 2,
          archived: false,
          error: null,
        });
      } else {
        const verified = await engine.verifyLocalRepository({
          environment: "wsl",
          path: source,
        });

        const repo = await engine.connectLocalRepository({
          verification_id: verified.verification_id,
          upstream_remote: "upstream",
          origin_remote: "origin",
          base_branch: "develop",
        });

        engine.db.saveSettings({
          ...defaultSettings,
          antigravity: {
            model: "gemini-3.8-flash-low",
            effort: "low",
            timeout_secs: 600,
          },
          codex_plan: { model: "", effort: "low", timeout_secs: 600 },
          codex_implementation: { model: "", effort: "low", timeout_secs: 600 },
          utility_ai: {
            provider: "antigravity",
            model: "gemini-3.8-flash-low",
            effort: "low",
            timeout_secs: 300,
          },
          repository_discovery: { roots: [], max_depth: 4, scan_home: false },
        });

        engine.db.run(
          "INSERT INTO settings VALUES('github_watch',?)",
          JSON.stringify({
            auto_watch: false,
            interval_minutes: 60,
            verify_codex: false,
          }),
        );

        const task: Task = {
          id,
          repo_id: repo.id,
          issue_number: 26831,
          issue_url: "https://github.com/oppia/oppia/issues/26831",
          claimed_scope: file,
          scope_mode: "partial",
          notes: `Product acceptance verification only. The ONLY scope is a NEW file ${file}. Put exactly these two lines in it: vibestar product quality verified\\nread-only review context\\n (actual newline characters). Do not edit any existing file. Validate the exact contents with python3. Do not install dependencies or run full Oppia tests. Plans can be concise; inspect only what this tiny text-file task requires. No remote writes.`,
          issue: {
            title: "Product acceptance verification · isolated Oppia worktree",
            body: "This manually created acceptance task exercises the product pipeline using a tiny temporary text file. It is not implementation of the linked historical issue.",
          },
          branch_name: "",
          base_branch: "develop",
          base_commit_sha: "",
          worktree_path: "",
          stage: 0,
          status: "cancelled",
          error: null,
          created_at: now(),
          updated_at: now(),
        };

        engine.db.saveTask(task);
      }
    } finally {
      await engine.close();
    }

    await mkdir(evidence, { recursive: true });
    console.log(`Product-quality evidence: ${evidence}`);

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

    const errors: string[] = [];
    let last: Detail | undefined;
    let managedTask: Detail | undefined;
    try {
      const page = await app.firstWindow();
      page.setDefaultTimeout(30000);
      page.on("pageerror", (e) => errors.push(e.message));
      await page.locator(".tree-task").first().waitFor();
      await page.locator(".tree-task").first().click();
      if (!reusedReady) await page.getByRole("button", { name: "Resume", exact: true }).click();

      const initial = await page.evaluate(
        (id) => window.vibestar.rpc<Detail>("task.detail", { id }),
        id,
      );

      const stages = new Set(
        initial.runs
          .filter((r) => r.status === "completed" && r.purpose !== "Code Review Ask AI")
          .map((r) => r.stage),
      );

      const deadline = Date.now() + 1200000;
      while (Date.now() < deadline) {
        last = await page.evaluate((id) => window.vibestar.rpc<Detail>("task.detail", { id }), id);
        const run = last.runs.find((r) => r.status === "running");
        if (run && !stages.has(run.stage)) {
          stages.add(run.stage);

          console.log(
            `Live stage ${run.stage}: ${run.provider} · ${run.model || "CLI default"} · ${run.effort}`,
          );

          await page.getByLabel("Current agent run").waitFor();
          await page.getByRole("tab", { name: "Plan", exact: true }).click();

          await expect
            .poll(() => page.getByLabel("Current agent run").innerText(), {
              timeout: 10000,
            })
            .toContain(run.provider === "antigravity" ? "Antigravity" : "Codex");

          await page.screenshot({
            path: join(evidence, `stage-${run.stage}.png`),
          });

          await page.getByRole("tab", { name: "Chat", exact: true }).click();

          await page
            .getByLabel("Current agent run")
            .getByRole("button", { name: "Agent Output" })
            .click();

          await page.getByRole("tab", { name: "Agent Output", exact: true }).waitFor();
        }

        if (["ready_for_review", "failed", "cancelled", "interrupted"].includes(last.task.status))
          break;
        await page.waitForTimeout(1000);
      }

      expect(last?.task.status, last?.task.error || "pipeline timeout").toBe("ready_for_review");
      expect(stages).toEqual(new Set([1, 2, 3]));

      expect(
        last!.usage?.filter(
          (r) =>
            r.status === "completed" &&
            ["Plan", "Plan refinement", "Implementation"].includes(r.purpose),
        ).length,
      ).toBeGreaterThanOrEqual(3);

      expect(await readFile(join(last!.task.worktree_path, file), "utf8")).toBe(
        "vibestar product quality verified\nread-only review context\n",
      );

      if (await page.getByLabel("Hide utility dock").count())
        await page.getByLabel("Hide utility dock").click();
      await page.getByRole("tab", { name: "Changes", exact: true }).click();
      await page.locator(".monaco-diff-editor").waitFor();
      await page.locator(".monaco-diff-editor .modified .view-lines").click();
      await page.keyboard.press("Control+Home");
      await page.keyboard.press("Control+Shift+End");
      if (await page.getByRole("button", { name: "✓ Reviewed", exact: true }).count())
        await page.getByRole("button", { name: "✓ Reviewed", exact: true }).click();
      await page.getByRole("button", { name: "Mark reviewed", exact: true }).click();
      await page.getByRole("button", { name: "✓ Reviewed", exact: true }).waitFor();
      if (!(await page.getByLabel("Selected code Ask AI").count()))
        await page.getByRole("button", { name: "Ask AI", exact: true }).click();

      const reuseAnswer =
        process.env.VIBESTAR_PRODUCT_REUSE_ANSWER === "1" &&
        (
          await page.evaluate(
            (id) =>
              window.vibestar.rpc<{ status: string; answer: string | null }[]>("review.questions", {
                id,
              }),
            id,
          )
        ).some((q) => q.status === "completed" && q.answer?.includes("### Why This Was Changed"));

      if (!reuseAnswer) {
        await page
          .getByLabel("Ask about selected code")
          .fill("Why was this changed? Explain only; do not modify anything.");

        const priorAnswers = await page.locator(".code-answers .agent-response").count();

        await page
          .getByLabel("Selected code Ask AI")
          .getByRole("button", { name: "Ask AI", exact: true })
          .click();

        await page.getByLabel("Current agent run").waitFor();

        expect(await page.getByLabel("Current agent run").innerText()).toContain(
          "Code review · read-only",
        );

        await page.screenshot({ path: join(evidence, "ask-ai-running.png") });

        await expect
          .poll(() => page.locator(".code-answers .agent-response").count(), {
            timeout: 360000,
          })
          .toBe(priorAnswers + 1);
      }

      expect(await readFile(join(last!.task.worktree_path, file), "utf8")).toBe(
        "vibestar product quality verified\nread-only review context\n",
      );

      await page.locator(".code-answers article").last().scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidence, "review-answer.png") });
      await page.getByRole("button", { name: "Add review note", exact: true }).last().click();
      const reviewButton = page.getByRole("button", { name: "Review", exact: true }).first();
      if ((await reviewButton.getAttribute("aria-pressed")) !== "true") await reviewButton.click();
      await page.locator(".diff-review-notes article").first().waitFor();
      await page.getByRole("tab", { name: "Usage", exact: true }).click();
      await page.getByText("Code Review Ask AI", { exact: true }).first().waitFor();
      await page.screenshot({ path: join(evidence, "task-usage.png") });

      const editors = await page.evaluate(() =>
        window.vibestar.rpc<{ editors: { id: string }[] }>("editors.list"),
      );

      if (editors.editors.some((e) => e.id === "code")) {
        await page.getByRole("button", { name: /Open in Editor/ }).click();
        const dialog = page.getByRole("dialog", { name: "Open in Editor" });
        await dialog.getByRole("button", { name: "VS Code", exact: true }).click();
        await dialog.waitFor({ state: "hidden", timeout: 930000 });
        console.log("VS Code opened the isolated task worktree through its WSL CLI.");
      }

      // Restart planning and stop only after provider output confirms invocation.
      await page.evaluate((id) => window.vibestar.rpc("task.retry", { id, stage: 1 }), id);

      await expect
        .poll(
          () =>
            page.evaluate(async (id) => {
              const detail = await window.vibestar.rpc<Detail>("task.detail", {
                id,
              });

              const run = detail.runs.at(-1);
              return (
                run?.status === "running" &&
                detail.events.some((e) => e.run_id === run.id && e.kind === "run.started")
              );
            }, id),
          { timeout: 120000, interval: 1000 },
        )
        .toBe(true);

      const stoppingRun = (
        await page.evaluate((id) => window.vibestar.rpc<Detail>("task.detail", { id }), id)
      ).runs.at(-1)!.id;

      await page
        .getByLabel("Current agent run")
        .getByRole("button", { name: "Stop", exact: true })
        .click();

      await expect
        .poll(
          () =>
            page.evaluate(
              async ({ id, runId }) =>
                (await window.vibestar.rpc<Detail>("task.detail", { id })).usage?.find(
                  (r) => r.id === runId,
                )?.status,
              { id, runId: stoppingRun },
            ),
          { timeout: 30000, interval: 1000 },
        )
        .toBe("cancelled");

      await page.getByRole("button", { name: "Settings", exact: true }).click();

      await page
        .locator(".settings-nav")
        .getByRole("button", { name: "Usage", exact: true })
        .click();

      await page.locator(".usage-run").filter({ hasText: "cancelled" }).first().waitFor();

      await page.screenshot({
        path: join(evidence, "global-usage-cancelled.png"),
      });

      await page.getByRole("button", { name: "Providers", exact: true }).click();
      await page.getByText("Connected", { exact: true }).first().waitFor();
      await page.screenshot({ path: join(evidence, "providers.png") });
      await page.getByRole("button", { name: "Repositories", exact: true }).click();
      const row = page.locator(".repo-catalog-row").filter({ hasText: cloneRepository });
      await row.getByRole("button", { name: "Use repository", exact: true }).click();

      const cloneDialog = page.getByRole("dialog", {
        name: "Local checkout search",
      });

      await cloneDialog.waitFor();
      page.once("dialog", (d) => void d.accept());
      await cloneDialog.getByRole("button", { name: "Clone with Vibestar", exact: true }).click();
      await page.getByLabel(`Clone ${cloneRepository}`).waitFor();

      await page.screenshot({
        path: join(evidence, "managed-clone-progress.png"),
      });

      await expect
        .poll(
          () =>
            page.evaluate(
              async (repository) =>
                (await window.vibestar.rpc<Snapshot>("snapshot")).github?.clones?.some(
                  (c) => c.repository === repository && c.status === "completed",
                ),
              cloneRepository,
            ),
          { timeout: 180000, interval: 1000 },
        )
        .toBe(true);

      await page.screenshot({
        path: join(evidence, "managed-clone-ready.png"),
      });

      // The small catalog repository has no issues. Use another small public
      // managed clone with an existing issue for the actual task-creation check.
      await page.evaluate(() =>
        window.vibestar.rpc("github.clone", {
          repository: "octocat/Hello-World",
        }),
      );

      await expect
        .poll(
          () =>
            page.evaluate(async () =>
              (await window.vibestar.rpc<Snapshot>("snapshot")).repositories.some(
                (r) =>
                  r.owner === "octocat" &&
                  r.name === "Hello-World" &&
                  r.connected !== false &&
                  r.clone_status === "ready",
              ),
            ),
          { timeout: 180000, interval: 1000 },
        )
        .toBe(true);

      const managed = (
        await page.evaluate(() => window.vibestar.rpc<Snapshot>("snapshot"))
      ).repositories.find((r) => r.owner === "octocat" && r.name === "Hello-World")!;

      expect(managed.source).toBe("managed");
      expect(managed.path.startsWith(join(root, "repos") + "/")).toBe(true);
      await page.getByRole("button", { name: "New task", exact: true }).first().click();
      const newTask = page.getByRole("dialog", { name: "New task" });
      await newTask.getByLabel("Repository", { exact: true }).selectOption(managed.id);

      await newTask
        .getByLabel("Issue URL", { exact: true })
        .fill("https://github.com/octocat/Hello-World/issues/11468");

      await newTask.getByText("Creating issue with GraphQL", { exact: true }).waitFor();
      await newTask.getByLabel("Specific part / claimed subtask").check();

      await newTask
        .getByLabel("Claimed scope", { exact: true })
        .fill(".vibestar-managed-quality.txt");

      await newTask
        .getByLabel("Optional instructions")
        .fill(
          "Product acceptance test only, not implementation of the historical issue. ONLY create .vibestar-managed-quality.txt with exactly: managed clone verified followed by a newline. Do not change any existing file. Use concise plans, minimal inspection and git diff --check for validation. No dependency installation, no remote writes.",
        );

      await newTask.getByRole("button", { name: "Create task", exact: true }).click();
      await newTask.waitFor({ state: "hidden" });

      await expect
        .poll(
          () =>
            page.evaluate(async (repositoryId) => {
              const task = (await window.vibestar.rpc<Snapshot>("snapshot")).tasks.find(
                (t) => t.repo_id === repositoryId,
              );

              return (
                task &&
                ["ready_for_review", "failed", "cancelled", "interrupted"].includes(task.status)
              );
            }, managed.id),
          { timeout: 900000, interval: 1000 },
        )
        .toBe(true);

      const created = (
        await page.evaluate(() => window.vibestar.rpc<Snapshot>("snapshot"))
      ).tasks.find((t) => t.repo_id === managed.id)!;

      managedTask = await page.evaluate(
        (id) => window.vibestar.rpc<Detail>("task.detail", { id }),
        created.id,
      );

      expect(created.status, created.error || "managed pipeline timeout").toBe("ready_for_review");
      expect(created.worktree_path).not.toBe(managed.path);
      expect(created.worktree_path.startsWith(join(root, "worktrees") + "/")).toBe(true);

      expect(
        await readFile(join(created.worktree_path, ".vibestar-managed-quality.txt"), "utf8"),
      ).toBe("managed clone verified\n");

      expect(await checked("git", ["status", "--porcelain"], managed.path)).toBe("");
      await page.getByRole("tab", { name: "Usage", exact: true }).click();
      await page.screenshot({ path: join(evidence, "managed-task-usage.png") });
      last = await page.evaluate((id) => window.vibestar.rpc<Detail>("task.detail", { id }), id);
      const snapshot = await page.evaluate(() => window.vibestar.rpc<Snapshot>("snapshot"));
      expect(snapshot.warning).toBeUndefined();
      expect(errors).toEqual([]);
      success = true;

      await writeFile(
        join(evidence, "results.json"),
        JSON.stringify(
          {
            task: last,
            managedTask,
            clone: snapshot.github?.clones,
            editors,
            rendererErrors: errors,
            sourceBranch: before.branch,
          },
          null,
          2,
        ),
      );
    } finally {
      await (
        await app.firstWindow()
      )
        .screenshot({ path: join(evidence, "last-window.png") })
        .catch(() => {});

      await app.close();
      const cleanup = await createFixtureEngine(root);
      try {
        for (const task of cleanup.db.tasks())
          if (success && task.worktree_path)
            await new StorageService(cleanup).cleanupTask(task.id, {
              worktree: true,
              logs: false,
              artifacts: false,
              history: false,
            });
      } finally {
        await cleanup.close();
      }

      expect(await checked("git", ["branch", "--show-current"], source)).toBe(before.branch);

      expect(
        await checked("git", ["--no-optional-locks", "status", "--porcelain=v1"], source),
      ).toBe(before.status);

      expect(await checked("git", ["diff", "--binary", "HEAD"], source)).toBe(before.diff);
      expect(await readFile(join(source, ".git", "config"), "utf8")).toBe(before.config);
    }
  },
  1600000,
);
