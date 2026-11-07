import { expect, it } from "vitest";
import { _electron } from "playwright-core";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { Rpc } from "../../backend/rpc";
import {
  createFixtureEngine,
  fixtureRepository,
  prepareFixtureTask,
  FixtureProvider,
  plan1,
  plan2,
} from "../helpers/fixtures";
import type { AgentRunRequest } from "../../backend/execution/providers/contracts";
import { builtInProfiles } from "../../backend/flows/templates";
import { migrateLegacyTask } from "../../backend/flows/legacy-migration";
import { TaskTerminals } from "../../backend/execution/terminals/task-terminals";
import { callTerminals } from "../../backend/rpc/terminals";

class CanvasFixture extends FixtureProvider {
  readonly requests: AgentRunRequest[] = [];

  invocation = (request: AgentRunRequest) => {
    this.requests.push(request);
    const fields = request.schema.properties as Record<string, unknown>;

    const result = fields.understanding
      ? plan1
      : fields.filesToModify
        ? plan2
        : fields.approval
          ? {
              approval: "approved",
              summary: "Fixture independent review",
              findings: [],
              testsRun: [],
              testsNotRun: ["No repository checks selected"],
            }
          : {
              summary:
                request.access === "workspace-write"
                  ? "I created hello.txt in the owned workspace."
                  : "I inspected the selected task.",
            };

    const delay = Object.keys(fields).length === 1 ? 3500 : 1500;

    const write =
      request.access === "workspace-write"
        ? "require('node:fs').writeFileSync('hello.txt','Hello from a Viber');"
        : "";

    return {
      program: process.execPath,
      input: "",
      args: [
        "-e",
        `${write} const argv=[process.execPath,'--version'];const output=require('node:child_process').execFileSync(argv[0],argv.slice(1),{encoding:'utf8'});console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',id:'fixture-version',command:JSON.stringify(argv),exit_code:0,aggregated_output:output}}));setTimeout(()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(${JSON.stringify(result)})}}));console.log(JSON.stringify({type:'turn.completed'}));},${delay});`,
      ],
    };
  };
}

const require = createRequire(import.meta.url);

it.skipIf(process.env.VIBESTAR_FLOW_DESKTOP_TEST !== "1")(
  "edits the real Viber canvas and runs solo chat through built Electron with isolated fixture providers",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-flow-desktop-"));
    const screenshots = join(dir, "screenshots");
    const home = join(dir, "home");
    const blocked = join(dir, "blocked-cli");
    await Promise.all([mkdir(screenshots), mkdir(home), mkdir(blocked)]);
    for (const program of ["gh", "agy", "codex"])
      await writeFile(
        join(blocked, program),
        "#!/bin/sh\necho 'Live services disabled in canvas fixture' >&2\nexit 1\n",
        { mode: 0o755 },
      );
    const provider = new CanvasFixture();
    const engine = await createFixtureEngine(join(dir, "fixture-data"), () => provider);
    for (const id of Object.values(builtInProfiles)) {
      const profile = engine.flows.profile(id);

      engine.flows.saveProfile(
        {
          ...profile,
          revision: 2,
          execution: { ...profile.execution, model: "next-model", effort: "low", timeout_secs: 30 },
        },
        1,
      );
    }

    const rpc = new Rpc(engine);

    const terminals = new TaskTerminals(engine, undefined, {
      HOME: home,
      SHELL: "/bin/bash",
      PATH: `${blocked}:${process.env.PATH}`,
    });

    const core = await createFixtureEngine(join(dir, "empty-core"));
    await core.close();

    const app = await _electron.launch({
      executablePath: require("electron") as string,
      args: [resolve(".")],
      env: {
        ...process.env,
        VIBESTAR_HOME: join(dir, "empty-core"),
        VIBESTAR_USER_DATA: join(dir, "electron-profile"),
        HOME: home,
        PATH: `${blocked}:${process.env.PATH}`,
      },
    });

    let forward: ((event: unknown) => void) | undefined;
    try {
      const page = await app.firstWindow();
      page.setDefaultTimeout(15000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));

      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1440, 900),
      );

      await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();

      await page.exposeFunction("fixtureRpc", async (method: string, input: unknown) =>
        method === "pr.watch.start"
          ? null
          : method === "providers.detect"
            ? [await provider.detect()]
            : method.startsWith("terminal.")
              ? callTerminals(
                  { terminals, repairTerminals: terminals, repairs: rpc.repairs },
                  method,
                  input,
                )
              : rpc.call(method, input),
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
            ({ BrowserWindow }, value) =>
              BrowserWindow.getAllWindows()[0]?.webContents.send("core:event", value),
            event,
          )
          .catch(() => {});
      };

      engine.on("event", forward);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.getByRole("button", { name: "New task", exact: true }).first().click();
      const creation = page.getByRole("dialog", { name: "New Viber task" });
      await creation.getByLabel("Goal", { exact: true }).fill("Draft the Viber crew");
      await creation.getByLabel("Start with", { exact: true }).selectOption("full");
      await creation.getByRole("button", { name: "Create workspace" }).click();
      await page.locator(".flow-editor").waitFor();
      const task = engine.db.tasks()[0];
      const saved = engine.flows.definition(task.flow_id!);
      expect(saved.definition.nodes).toHaveLength(8);
      expect(provider.requests).toHaveLength(0);
      const first = saved.definition.nodes[0];
      const node = page.locator(`.react-flow__node[data-id="${first.id}"]`);
      await node.click();
      const inspector = page.getByLabel("Node inspector", { exact: true });

      await inspector
        .getByLabel("Node instructions", { exact: true })
        .fill("Keep the plan focused.");

      await page.getByRole("button", { name: "Save draft", exact: true }).click();
      await expect.poll(() => engine.flows.definition(task.flow_id!).revision).toBe(2);
      await node.focus();
      const previousX = engine.flows.layout(task.flow_id!)?.positions[first.id]?.x || 0;
      await page.keyboard.press("ArrowRight");

      await expect
        .poll(() => engine.flows.layout(task.flow_id!)?.positions[first.id]?.x)
        .toBeGreaterThan(previousX);

      expect(engine.flows.definition(task.flow_id!).revision).toBe(2);
      expect(provider.requests).toHaveLength(0);
      await page.screenshot({ path: join(screenshots, "vibers-canvas-1440.png") });
      await inspector.getByRole("button", { name: "Duplicate", exact: true }).click();
      await page.getByRole("button", { name: "Save draft", exact: true }).click();

      await expect
        .poll(() => engine.flows.definition(task.flow_id!).definition.nodes.length)
        .toBe(9);

      await page.getByRole("button", { name: "Delete node", exact: true }).click();
      await page.getByRole("button", { name: "Save draft", exact: true }).click();

      await expect
        .poll(() => engine.flows.definition(task.flow_id!).definition.nodes.length)
        .toBe(8);

      await node.click();
      await page.getByRole("button", { name: "Run flow", exact: true }).click();

      await page
        .getByLabel("Current node activity", { exact: true })
        .getByText(/--version/)
        .first()
        .waitFor();

      await page.screenshot({ path: join(screenshots, "vibers-running-1440.png") });

      await expect
        .poll(
          () =>
            engine.flowRuns.run(
              engine.db.all<{ id: string }>("SELECT id FROM flow_runs WHERE task_id=?", task.id)[0]
                .id,
            ).status,
          { timeout: 10000 },
        )
        .toBe("waiting");

      await page.locator(".viber-node.waiting").waitFor();
      await page.screenshot({ path: join(screenshots, "vibers-approval-1440.png") });
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      const refiner = saved.definition.nodes.find((node) => node.name === "Refiner")!;
      await page.locator(`.react-flow__node[data-id="${refiner.id}"]`).click();

      await inspector
        .getByLabel("Node instructions", { exact: true })
        .fill("Refine only the selected scope.");

      await page.getByRole("button", { name: "Save draft", exact: true }).click();
      await page.getByRole("button", { name: "Apply saved revision…", exact: true }).click();

      const continuation = page.getByRole("dialog", {
        name: "Apply saved flow revision",
        exact: true,
      });

      await continuation.getByText("Reuse completed result", { exact: true }).waitFor();
      expect(provider.requests).toHaveLength(1);

      await continuation
        .getByRole("button", { name: "Apply and run remaining work", exact: true })
        .click();

      await page.getByText("Reused · completed", { exact: true }).waitFor();
      await page.locator(".viber-node.waiting").waitFor();
      expect(provider.requests).toHaveLength(1);
      await page.screenshot({ path: join(screenshots, "vibers-continuation-1440.png") });

      const currentGraph = engine.db.all<{ id: string }>(
        "SELECT id FROM flow_runs WHERE task_id=? AND kind='flow' ORDER BY rowid DESC LIMIT 1",
        task.id,
      )[0].id;

      const graphAttempts = engine.flowRuns.attempts(currentGraph);
      const chatRevision = engine.flows.definition(task.flow_id!).revision;
      await node.click();
      await inspector.getByRole("button", { name: "Chat with Viber", exact: true }).click();
      await page.getByLabel("Chat with Viber", { exact: true }).selectOption(first.id);

      await page
        .getByRole("textbox", { name: "Viber conversation", exact: true })
        .fill("Inspect this task without changing files");

      await page.getByRole("textbox", { name: "Viber conversation", exact: true }).press("Enter");
      await page.getByText("Planner · running", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Flow", exact: true }).click();
      await node.click();

      await page
        .getByLabel("Current node activity", { exact: true })
        .getByText(/--version/)
        .first()
        .waitFor();

      await page.screenshot({ path: join(screenshots, "vibers-connected-chat-running-1440.png") });
      await page.getByRole("button", { name: "Chat", exact: true }).click();
      await page.getByText("I inspected the selected task.", { exact: true }).first().waitFor();
      await expect.poll(() => engine.isActive(task.id)).toBe(false);
      expect(engine.flowRuns.run(currentGraph).status).toBe("waiting");
      expect(engine.flowRuns.attempts(currentGraph)).toEqual(graphAttempts);
      expect(engine.flows.definition(task.flow_id!).revision).toBe(chatRevision);
      expect(provider.requests).toHaveLength(2);
      await page.screenshot({ path: join(screenshots, "vibers-connected-chat-1440.png") });
      await page.getByRole("button", { name: "Flow", exact: true }).click();
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await page.getByRole("button", { name: "Back to tasks", exact: true }).click();
      await page.getByRole("button", { name: "New task", exact: true }).first().click();
      await creation.getByLabel("Goal", { exact: true }).fill("Work directly with a solo Viber");
      await creation.getByRole("button", { name: "Create workspace" }).click();
      await page.locator(".flow-editor").waitFor();
      await page.getByRole("button", { name: "Chat", exact: true }).click();

      await page
        .getByRole("textbox", { name: "Viber conversation", exact: true })
        .fill("Create hello.txt");

      await page
        .getByRole("textbox", { name: "Viber conversation", exact: true })
        .press("Shift+Enter");

      expect(provider.requests).toHaveLength(2);

      await page
        .getByRole("textbox", { name: "Viber conversation", exact: true })
        .fill("Create hello.txt");

      await page.getByRole("textbox", { name: "Viber conversation", exact: true }).press("Enter");

      await page
        .getByText("I created hello.txt in the owned workspace.", { exact: true })
        .first()
        .waitFor();

      const solo = engine.db.tasks().find((value) => value.id !== task.id)!;

      expect(
        engine.db.detail(solo.id).messages.filter((message) => message.role === "user"),
      ).toHaveLength(1);

      await page.getByRole("button", { name: "Files", exact: true }).click();
      await page.getByRole("button", { name: "hello.txt", exact: true }).click();
      await page.getByText("Hello from a Viber", { exact: true }).waitFor();
      await page.keyboard.press("Control+Shift+P");
      const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
      await palette.locator("input").fill("Task: Usage");
      await palette.getByRole("option", { name: "Task: Usage", exact: true }).click();
      await page.getByRole("heading", { name: "Task usage", exact: true }).waitFor();
      await page.keyboard.press("Control+`");
      await page.getByRole("button", { name: "Close shell", exact: true }).waitFor();
      const terminal = terminals.current(solo.id)!;

      expect(
        engine.db.all("SELECT status FROM terminal_sessions WHERE id=?", terminal.session_id),
      ).toEqual([{ status: "running" }]);

      await page.keyboard.press("Control+j");

      expect(
        await page.getByRole("region", { name: "Terminal and problems", exact: true }).count(),
      ).toBe(0);

      expect(terminals.current(solo.id)?.session_id).toBe(terminal.session_id);
      await page.keyboard.press("Control+`");
      await page.getByRole("button", { name: "Close shell", exact: true }).waitFor();
      expect(terminals.current(solo.id)?.session_id).toBe(terminal.session_id);
      await page.screenshot({ path: join(screenshots, "vibers-usage-terminal-1440.png") });
      await page.getByRole("button", { name: "Close shell", exact: true }).click();
      await page.getByRole("button", { name: "Hide utility dock", exact: true }).click();
      expect(provider.requests).toHaveLength(3);
      await page.getByRole("button", { name: "Flow", exact: true }).click();
      await page.emulateMedia({ reducedMotion: "reduce" });
      for (const [width, height] of [
        [1280, 720],
        [1440, 900],
      ]) {
        await app.evaluate(
          ({ BrowserWindow }, size) =>
            BrowserWindow.getAllWindows()[0].setSize(...(size as [number, number])),
          [width, height],
        );

        await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);

        expect(
          await page
            .locator(".viber-workspace")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);

        await page.screenshot({ path: join(screenshots, `vibers-solo-${width}.png`) });
      }

      expect(errors).toEqual([]);
      await page.locator(".react-flow__node").first().click();

      await page
        .getByLabel("Node inspector", { exact: true })
        .getByLabel("Model", { exact: true })
        .fill("future-model");

      expect(await page.locator(".viber-identity").innerText()).toContain("future-model");
      expect(await page.locator(".viber-node.completed").count()).toBe(0);

      const soloTurn = engine.db.all<{ id: string }>(
        "SELECT id FROM flow_runs WHERE task_id=? AND kind='conversation'",
        solo.id,
      )[0];

      expect(
        Object.values(engine.flowRuns.run(soloTurn.id).snapshot.agents)[0].execution.model,
      ).toBe("next-model");

      expect(provider.requests).toHaveLength(3);

      const { repo } = await fixtureRepository(engine, dir);
      const original = await prepareFixtureTask(engine, repo, randomUUID());

      engine.db.saveTask({
        ...original,
        scope_mode: "partial",
        claimed_scope: "Keep imported approval history",
        status: "awaiting_approval",
        stage: 1,
        approval_gate: "antigravity_plan",
        execution_settings: {
          ...engine.db.settings(),
          antigravity: {
            provider: "antigravity",
            model: "next-model",
            effort: "low",
            timeout_secs: 30,
          },
          codex_plan: { provider: "codex", model: "next-model", effort: "low", timeout_secs: 30 },
          codex_implementation: {
            provider: "codex",
            model: "next-model",
            effort: "low",
            timeout_secs: 30,
          },
          antigravity_review: {
            provider: "antigravity",
            model: "next-model",
            effort: "low",
            timeout_secs: 30,
          },
        },
      });

      engine.db.run(
        "INSERT INTO task_artifacts VALUES(?,?,1,'plan',?,?)",
        randomUUID(),
        original.id,
        JSON.stringify(plan1),
        new Date().toISOString(),
      );

      const imported = migrateLegacyTask(engine.db, original.id)!;
      expect(imported.state).toBe("converted");
      engine.changed(original.id);
      await page.getByRole("button", { name: "Back to tasks", exact: true }).click();

      await page
        .locator(".task-card")
        .filter({ hasText: "Keep imported approval history" })
        .click();

      await page.getByText("Imported from awaiting_approval.", { exact: false }).waitFor();
      expect(engine.flowRuns.attempts(imported.checkpoint_run_id!)).toHaveLength(0);
      await page.getByRole("button", { name: "History", exact: true }).click();
      await page.getByText("Original contribution graph · 8 nodes", { exact: true }).click();

      expect(
        await page
          .getByText("Past approval decision and exact inputs were not recorded.", { exact: true })
          .count(),
      ).toBe(4);

      await page.screenshot({ path: join(screenshots, "vibers-imported-history-1440.png") });
      await page.getByRole("button", { name: "Flow", exact: true }).click();

      await page
        .getByRole("button", { name: "Inspect / continue historical checkpoint", exact: true })
        .click();

      await page.locator(`.react-flow__node[data-id="${imported.boundary_node_id}"]`).click();
      await page.getByRole("button", { name: "Accept inputs", exact: true }).waitFor();
      expect(engine.flowRuns.attempts(imported.checkpoint_run_id!)).toHaveLength(1);
      await page.getByRole("button", { name: "Reject", exact: true }).click();
      expect(provider.requests).toHaveLength(3);
      expect(errors).toEqual([]);
      await page.getByRole("button", { name: "Vibers", exact: true }).click();
      await page.getByRole("heading", { name: "Your Vibers", exact: true }).waitFor();

      await page
        .getByRole("button", { name: "Planner · Draft the Viber crew", exact: true })
        .click();

      await page.getByText("I inspected the selected task.", { exact: true }).first().waitFor();
      expect(await page.getByLabel("Chat with Viber", { exact: true }).inputValue()).toBe(first.id);
      expect(provider.requests).toHaveLength(3);
      await page.screenshot({ path: join(screenshots, "vibers-library-return-1440.png") });
      console.log(`Viber canvas screenshots: ${screenshots}`);
    } catch (error) {
      const page = await app.firstWindow();
      await page.screenshot({ path: join(screenshots, "failure.png") }).catch(() => {});
      console.log(`Viber canvas failure screenshot: ${screenshots}`);
      throw error;
    } finally {
      if (forward) engine.off("event", forward);
      await app.close();
      await terminals.dispose();
      await rpc.close();
      await engine.close();
    }
  },
  90000,
);
