import { it, expect } from "vitest";
import { _electron } from "playwright-core";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Engine } from "../backend/execution/engine";
import { Rpc } from "../backend/rpc";
import { defaultSettings, parseIssue } from "../backend/domain";
import { AntigravityProvider } from "../backend/execution/providers/antigravity";
import { fixtureRepository, FixtureProvider, plan1 } from "./fixtures";
const require = createRequire(import.meta.url);

it.skipIf(process.env.VIBESTAR_OUTPUT_DESKTOP_TEST !== "1")(
  "visually verifies the complete output harness in built Electron using official event shapes and safe fixture processes",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-output-desktop-"));
    const evidence = join(dir, "screenshots");
    await mkdir(evidence);
    const agy = new AntigravityProvider();
    const fixture = new FixtureProvider();
    const engine = await Engine.create(join(dir, "fixture"), () => ({
      ...fixture,
      name: "antigravity",
      normalize: agy.normalize,
      result: agy.result,
      outputSchema: agy.outputSchema,
      parseStructuredOutput: agy.parseStructuredOutput,
      invocation: () => ({
        program: process.execPath,
        args: [
          "-e",
          `
        const emit = (value) => console.log(JSON.stringify(value));
        const tool = (index, name, state, parameters, output, exit) => emit({event:'step_update',step_update:{step_index:index,step_type:'tool',tool_name:name,state,tool_info:{parameters,output,exit_code:exit}}});
        emit({event:'init',init:{model:'reported-fixture-model',effort:'high'}});
        emit({event:'step_update',step_update:{step_index:1,step_type:'agent_response',text_delta:'Inspecting the repository and its verification commands.'}});
        tool(2,'view_file','DONE',{AbsolutePath:'source.txt'},'base source contents');
        tool(3,'run_command','RUNNING',{CommandLine:'npm test',Cwd:'.'},'first check passed');
        console.error('Provider diagnostic: access_token=fixture-secret');
        setTimeout(() => tool(3,'run_command','RUNNING',{CommandLine:'npm test',Cwd:'.'},'first check passed\\nsecond check passed'),2200);
        setTimeout(() => {tool(3,'run_command','DONE',{CommandLine:'npm test',Cwd:'.'},'first check passed\\nsecond check passed',0);tool(4,'run_command','RUNNING',{CommandLine:'npm run pending-check'},'started but unfinished');emit({event:'result',result:{status:'SUCCESS',structured_output:${JSON.stringify(plan1)},usage:{input_tokens:120,output_tokens:30}}});},10000);
      `,
        ],
      }),
    }));
    const rpc = new Rpc(engine);
    engine.db.saveSettings({
      ...defaultSettings,
      antigravity: { model: "next-model", effort: "low", timeout_secs: 30 },
    });
    const { repo } = await fixtureRepository(engine, dir);
    const emptyRoot = join(dir, "empty-core");
    const empty = await Engine.create(emptyRoot);
    await empty.close();
    const home = join(dir, "isolated-home"),
      cli = join(dir, "blocked-cli");
    await mkdir(home);
    await mkdir(cli);
    for (const name of ["codex", "agy", "gh"])
      await writeFile(
        join(cli, name),
        "#!/bin/sh\necho 'Real CLI disabled in fixture' >&2\nexit 1\n",
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
      page.on("pageerror", (e) => errors.push(e.message));
      await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();
      const detection = await fixture.detect();
      await page.exposeFunction(
        "fixtureRpc",
        (method: string, params: unknown) =>
          method === "providers.detect"
            ? ["codex", "antigravity"].map((provider) => ({
                ...detection,
                provider,
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
        parseIssue("https://github.com/fixture/fixture/issues/1"),
        "Harness fixture",
        "",
        { title: "Output harness", body: "Fixture only" },
      );
      const historic = randomUUID();
      engine.db.run(
        "INSERT INTO agent_runs(id,task_id,stage,provider,model,effort,prompt,status,started_at,ended_at,exit_code,output) VALUES(?,?,3,'codex','historic-model','xhigh','Exact historical prompt','completed',?,?,0,?)",
        historic,
        task.id,
        new Date(Date.now() - 60000).toISOString(),
        new Date(Date.now() - 50000).toISOString(),
        JSON.stringify({
          summary: "Historical output result",
          observations: [
            { file: "source.txt", detail: "Nested review evidence" },
          ],
        }),
      );
      const logDir = join(engine.root, "logs", task.id);
      await mkdir(logDir, { recursive: true });
      await writeFile(
        join(logDir, `${historic}.jsonl`),
        `historical needle beyond the UI tail\n${'{"type":"saved","text":"fixture history"}\n'.repeat(40000)}last historical line\n`,
      );
      await writeFile(
        join(logDir, `${historic}.stderr.log`),
        "historical stderr only\n",
      );
      await page.locator(".tree-task").first().click();
      await expect
        .poll(() => page.getByLabel("Current agent run").innerText(), {
          timeout: 10000,
        })
        .toContain("reported-fixture-model");
      expect(await page.locator("aside.context-pane").count()).toBe(0);
      await page.getByRole("tab", { name: "Plan", exact: true }).click();
      expect(await page.getByLabel("Current agent run").innerText()).toContain(
        "high",
      );
      await page.getByRole("tab", { name: "Chat", exact: true }).click();
      await page
        .getByLabel("Current agent run")
        .getByRole("button", { name: "Agent Output", exact: true })
        .click();
      await page.getByLabel("Maximize utility dock").click();
      await page
        .locator(".logs-panel .tool-event")
        .filter({ hasText: "npm test" })
        .locator("summary")
        .first()
        .click();
      await expect
        .poll(() => page.getByLabel("Agent output transcript").innerText(), {
          timeout: 10000,
        })
        .toContain("second check passed");
      expect(await page.getByLabel("Current agent run").isVisible()).toBe(true);
      await page.screenshot({ path: join(evidence, "active-readable.png") });
      await page.getByRole("button", { name: "Raw", exact: true }).click();
      await expect
        .poll(() => page.locator(".logs-panel .raw-log").innerText(), {
          timeout: 10000,
        })
        .toContain('"step_update"');
      await page.screenshot({ path: join(evidence, "active-raw-stdout.png") });
      await page.getByLabel("Raw output stream").selectOption("stderr");
      await expect
        .poll(() => page.locator(".logs-panel .raw-log").innerText(), {
          timeout: 10000,
        })
        .toContain("[REDACTED]");
      expect(
        await page.locator(".logs-panel .raw-log").innerText(),
      ).not.toContain("fixture-secret");
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].focus(),
      );
      await page
        .getByRole("button", { name: "Copy output", exact: true })
        .click();
      await page.getByText("Copied", { exact: true }).waitFor();
      await expect
        .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), {
          timeout: 10000,
        })
        .toContain("[REDACTED]");
      await page.screenshot({ path: join(evidence, "active-raw-stderr.png") });
      await page.getByLabel("Restore utility dock").click();
      await page
        .getByRole("button", { name: "Approve → Codex refinement" })
        .waitFor();
      await page
        .getByRole("button", { name: "Review plan", exact: true })
        .click();
      await page
        .getByRole("tab", { name: "Agent Output", exact: true })
        .click();
      await page.getByRole("button", { name: "Readable", exact: true }).click();
      await page.getByLabel("Maximize utility dock").click();
      const interrupted = page
        .locator(".logs-panel .tool-event[data-state=interrupted]")
        .filter({ hasText: "pending-check" });
      await interrupted.waitFor();
      await interrupted.scrollIntoViewIfNeeded();
      await interrupted.locator("summary").first().click();
      expect(
        await page
          .locator(".logs-panel .tool-event[data-state=interrupted] .success")
          .count(),
      ).toBe(0);
      await page.screenshot({
        path: join(evidence, "completed-and-interrupted-tools.png"),
      });
      await page.getByLabel("Select run").selectOption(historic);
      await page.getByText("Nested review evidence", { exact: true }).waitFor();
      await page
        .getByRole("button", { name: "Saved prompt", exact: true })
        .click();
      expect(await page.locator(".logs-panel .raw-log").innerText()).toBe(
        "Exact historical prompt",
      );
      await page.getByRole("button", { name: "Raw", exact: true }).click();
      await page.getByLabel("Raw output stream").selectOption("stdout");
      await page.getByLabel("Agent output transcript").focus();
      await page.keyboard.press("Control+f");
      await page.keyboard.type("historical needle");
      await expect
        .poll(() => page.locator(".logs-panel .raw-log").innerText(), {
          timeout: 10000,
        })
        .toContain("historical needle beyond the UI tail");
      await page.screenshot({ path: join(evidence, "historical-search.png") });
      await page.keyboard.press("Escape");
      await page
        .getByRole("button", { name: "Load earlier output", exact: true })
        .waitFor();
      if (
        await page
          .getByRole("button", { name: "Follow output", exact: true })
          .count()
      )
        await page
          .getByRole("button", { name: "Follow output", exact: true })
          .click();
      await page
        .getByRole("button", { name: "Pause scrolling", exact: true })
        .click();
      await page.screenshot({
        path: join(evidence, "historical-raw-paused.png"),
      });
      await page.getByLabel("Restore utility dock").click();
      await page
        .getByRole("tab", { name: "Usage", exact: true })
        .first()
        .click();
      await page
        .getByText("Antigravity Plan", { exact: true })
        .first()
        .waitFor();
      await page.screenshot({ path: join(evidence, "reported-usage.png") });
      await page.getByRole("tab", { name: "Chat", exact: true }).click();
      await page.reload();
      await page.locator(".tree-task").first().waitFor();
      expect(await page.locator(".tree-task.selected").count()).toBe(1);
      await page
        .getByRole("button", { name: "Review plan", exact: true })
        .click();
      await page
        .getByRole("tab", { name: "Agent Output", exact: true })
        .click();
      expect(await page.getByLabel("Select run").inputValue()).toBe(historic);
      expect(await page.getByLabel("Raw output stream").inputValue()).toBe(
        "stdout",
      );
      await page
        .getByRole("button", { name: "Follow output", exact: true })
        .waitFor();
      expect(errors).toEqual([]);
      expect(engine.db.all("SELECT id FROM pr_analyses")).toEqual([]);
      await writeFile(
        join(evidence, "results.json"),
        JSON.stringify(
          {
            rendererErrors: errors,
            usage: engine.db.detail(task.id).usage,
            inference:
              "Fixture Node processes only; real CLI executables blocked",
            task: engine.db.task(task.id),
          },
          null,
          2,
        ),
      );
      console.log("Agent output visual evidence", evidence);
    } catch (e) {
      await (
        await app.firstWindow()
      )
        .screenshot({ path: join(evidence, "failure.png") })
        .catch(() => {});
      console.log("Agent output failure evidence", evidence);
      throw e;
    } finally {
      if (forward) engine.off("event", forward);
      await app.close();
      await rpc.close();
      await engine.close();
    }
  },
  60000,
);
