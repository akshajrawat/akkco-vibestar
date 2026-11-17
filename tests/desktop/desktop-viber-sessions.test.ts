import { expect, it } from "vitest";
import { _electron } from "playwright-core";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { Rpc } from "../../apps/core/rpc";
import { builtInProfiles } from "../../apps/core/flows/templates";
import { defaultAppearance } from "../../apps/core/flows/appearance";
import type { AgentRunRequest } from "../../apps/core/execution/providers/contracts";
import { createFixtureEngine, fixtureRepository, FixtureProvider } from "../helpers/fixtures";

class SessionFixture extends FixtureProvider {
  readonly requests: AgentRunRequest[] = [];

  waiting = true;

  invocation = (request: AgentRunRequest) => {
    this.requests.push(request);
    return {
      program: process.execPath,
      input: "",
      args: [
        "-e",
        `
        const emit = value => console.log(JSON.stringify(value));
        require('node:fs').writeFileSync('answer.txt','Inspect this saved work');
        emit({type:'thread.started',thread_id:${JSON.stringify(request.conversation?.threadId || request.runId)}});
        emit({type:'item.started',item:{id:'command',type:'command_execution',command:'inspect workspace'}});
        ${
          this.waiting
            ? "setInterval(() => {}, 1000);"
            : `
        emit({type:'item.completed',item:{id:'command',type:'command_execution',command:'inspect workspace',exit_code:0,aggregated_output:'Inspected'}});
        emit({type:'item.completed',item:{id:'answer',type:'agent_message',text:'The saved work is ready.'}});
        emit({type:'turn.completed'});`
        }
      `,
      ],
    };
  };
}

const require = createRequire(import.meta.url);

it.skipIf(process.env.VIBESTAR_SESSION_DESKTOP_TEST !== "1")(
  "exercises standalone session streaming, stop, recovery, history, reset and compact repository attachment",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-session-desktop-"));
    const home = join(dir, "home");
    const blocked = join(dir, "blocked");
    await Promise.all([mkdir(home), mkdir(blocked)]);
    for (const name of ["gh", "agy", "codex"]) {
      await writeFile(
        join(blocked, name),
        "#!/bin/sh\necho 'Live CLI disabled in session fixture' >&2\nexit 1\n",
        { mode: 0o755 },
      );
    }

    const provider = new SessionFixture();
    const engine = await createFixtureEngine(join(dir, "fixture"), () => provider);
    const rpc = new Rpc(engine);
    const { repo } = await fixtureRepository(engine, dir);

    const profile = engine.flows.saveProfile(
      {
        ...engine.flows.profile(builtInProfiles.implementer),
        id: randomUUID(),
        revision: 1,
        name: "Orbit Lifecycle",
        appearance: defaultAppearance(),
        execution: {
          provider: "codex",
          model: "next-model",
          effort: "low",
          timeout_secs: 30,
          access: "workspace-write",
          output: "conversation",
        },
      },
      null,
    );

    const empty = await createFixtureEngine(join(dir, "empty-core"));
    await empty.close();

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
            ? [{ ...(await provider.detect()), provider: "codex" }]
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
      engine.changed();
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      const sidebar = page.getByRole("complementary", { name: "Workspace navigation" });
      await sidebar.getByRole("button", { name: "Show Vibers" }).click();
      await sidebar.getByRole("button", { name: /Orbit Lifecycle/ }).click();
      const chat = page.getByRole("region", { name: "Chat with Orbit Lifecycle" });
      await chat.getByRole("heading", { name: "Ready when you are." }).waitFor();
      expect(await chat.getByRole("checkbox").count()).toBe(0);
      expect(await chat.getByRole("combobox", { name: "Repository workspace" }).count()).toBe(0);
      const attach = chat.getByRole("combobox", { name: "Attach repository" });
      expect((await attach.boundingBox())!.width).toBeLessThan(220);
      await attach.click();
      const popover = page.locator(".select-popover");
      expect((await popover.boundingBox())!.width).toBeLessThan(400);
      await popover.getByRole("combobox", { name: "Search attach repository" }).fill(repo.name);
      await popover.getByRole("option", { name: `${repo.owner}/${repo.name}` }).click();
      await chat.getByRole("button", { name: "Remove repository" }).click();
      await attach.waitFor();

      const prompt = chat.getByRole("textbox", { name: "Message Orbit Lifecycle" });
      await prompt.fill("Inspect the current files");
      await prompt.press("Enter");
      await chat.getByRole("button", { name: "Stop response" }).waitFor();
      await chat.getByText("Running command", { exact: true }).waitFor();

      expect(
        await chat
          .locator(".working-shimmer")
          .evaluate((element) => getComputedStyle(element).animationName),
      ).toBe("working-shine");

      expect(await chat.locator(".flow-draft-notice").count()).toBe(0);
      const first = engine.viberSessions.store.list(profile.id)[0];
      expect(first.repository_id).toBeNull();
      const workspace = engine.viberSessions.store.workspace(first.id).worktree_path;
      expect(await chat.getByText(workspace, { exact: true }).count()).toBe(0);
      await page.screenshot({ path: join(dir, "working.png") });
      await chat.getByRole("button", { name: "Stop response" }).click();
      await chat.getByRole("button", { name: "Retry", exact: true }).waitFor();
      await prompt.fill("Continue after inspection");
      await prompt.press("Enter");
      const recovery = page.getByRole("dialog", { name: "Review previous work" });
      await recovery.waitFor();
      expect(provider.requests).toHaveLength(1);
      await recovery.getByRole("button", { name: "Inspect activity and files" }).click();
      await recovery.getByRole("button", { name: "answer.txt", exact: true }).click();
      await recovery.getByText("Inspect this saved work", { exact: true }).waitFor();
      await page.screenshot({ path: join(dir, "recovery.png") });
      await recovery.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(await prompt.inputValue()).toBe("Continue after inspection");
      await prompt.press("Enter");
      provider.waiting = false;
      await recovery.getByRole("button", { name: "I understand, continue" }).click();
      await chat.getByText("The saved work is ready.", { exact: true }).waitFor();
      expect(provider.requests).toHaveLength(2);
      const thread = engine.viberSessions.store.session(first.id, profile.id).thread?.thread_id;
      expect(provider.requests[1].conversation).toEqual({ threadId: thread });
      expect(await chat.locator(".working-shimmer").count()).toBe(0);
      await chat.getByRole("combobox", { name: "Conversation menu" }).click();
      await page.getByRole("option", { name: "Reset AI context", exact: true }).click();
      await prompt.fill("Start fresh");
      await prompt.press("Enter");
      await expect.poll(() => provider.requests.length).toBe(3);
      await chat.getByRole("button", { name: "Continue", exact: true }).waitFor();
      expect(provider.requests[2].conversation).toEqual({});
      expect(engine.viberSessions.store.workspace(first.id).worktree_path).toBe(workspace);

      expect(engine.viberSessions.store.session(first.id, profile.id).thread?.thread_id).not.toBe(
        thread,
      );

      await chat.getByRole("button", { name: "New chat", exact: true }).click();
      await attach.waitFor();
      await prompt.fill("A separate conversation");
      await prompt.press("Enter");
      await chat.getByRole("button", { name: "Continue", exact: true }).waitFor();
      expect(engine.viberSessions.store.list(profile.id)).toHaveLength(2);
      await chat.getByRole("combobox", { name: "Chat history" }).click();
      await page.getByRole("option", { name: "Inspect the current files", exact: true }).click();
      await chat.getByText("Continue after inspection", { exact: true }).waitFor();
      expect(provider.requests).toHaveLength(4);
      expect(await chat.getByRole("combobox", { name: "Attach repository" }).count()).toBe(0);
      await page.emulateMedia({ reducedMotion: "reduce" });
      provider.waiting = true;
      await prompt.fill("Check reduced motion");
      await prompt.press("Enter");
      await chat.getByRole("button", { name: "Stop response" }).waitFor();

      await expect
        .poll(() =>
          chat
            .locator(".working-shimmer")
            .evaluate((element) => getComputedStyle(element).animationName),
        )
        .toBe("none");

      for (const [width, height] of [
        [1280, 720],
        [390, 640],
      ]) {
        if (width < 640) {
          await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
        }

        await app.evaluate(
          ({ BrowserWindow }, size) => {
            const window = BrowserWindow.getAllWindows()[0];
            window.setMinimumSize(360, 400);
            window.setSize(size.width, size.height);
          },
          { width, height },
        );

        await page.waitForFunction(
          ([width, height]) => window.innerWidth === width && window.innerHeight === height,
          [width, height],
        );

        expect(await chat.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
      }

      await chat.getByRole("button", { name: "Stop response" }).click();
      await chat.getByRole("button", { name: "Retry", exact: true }).waitFor();
      expect(errors).toEqual([]);
    } finally {
      if (forward) {
        engine.off("event", forward);
      }

      await app.close();
      await rpc.close();
      await engine.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
  90000,
);
