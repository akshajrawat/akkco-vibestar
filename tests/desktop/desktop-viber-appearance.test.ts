import { expect, it } from "vitest";
import { _electron } from "playwright-core";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { Rpc } from "../../backend/rpc";
import { builtInProfiles } from "../../backend/flows/templates";
import { createFixtureEngine } from "../helpers/fixtures";

const require = createRequire(import.meta.url);

it.skipIf(process.env.VIBESTAR_AVATAR_DESKTOP_TEST !== "1")(
  "creates and edits Viber avatars without disturbing tasks, with native modal keyboard and responsive layout",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-avatar-desktop-"));
    const screenshots = join(dir, "screenshots");
    const home = join(dir, "home");
    const blocked = join(dir, "blocked-cli");
    await Promise.all([mkdir(screenshots), mkdir(home), mkdir(blocked)]);
    for (const name of ["gh", "agy", "codex"])
      await writeFile(
        join(blocked, name),
        "#!/bin/sh\necho 'Live CLI disabled in avatar fixture' >&2\nexit 1\n",
        { mode: 0o755 },
      );

    const engine = await createFixtureEngine(join(dir, "fixture-data"));
    const rpc = new Rpc(engine);

    engine.flows.saveProfile(
      {
        ...engine.flows.profile(builtInProfiles.refiner),
        id: randomUUID(),
        revision: 1,
        name: "Imported Refiner",
      },
      null,
    );

    const task = engine.createGeneralTask({
      request_id: randomUUID(),
      goal: "Preserve the current workflow",
      profile_id: builtInProfiles.implementer,
      repository_id: null,
    });

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

    try {
      const profileSaves: unknown[] = [];
      const page = await app.firstWindow();
      page.setDefaultTimeout(15000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));

      const resize = async (width: number, height: number) => {
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
      };

      await resize(1440, 900);
      await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();

      await page.exposeFunction("fixtureRpc", (method: string, input: unknown) => {
        if (method === "pr.watch.start") return null;
        if (method === "profile.save") profileSaves.push(input);
        if (method === "providers.detect")
          return [
            {
              provider: "codex",
              models: [
                {
                  id: "gpt-6.1-sol",
                  label: "GPT-6.1-Sol",
                  isDefault: true,
                  supportedEfforts: ["low", "high", "xhigh"],
                },
              ],
              efforts: ["low", "high", "xhigh"],
            },
            {
              provider: "antigravity",
              models: [
                {
                  id: "gemini-3.8-flash-high",
                  label: "Gemini 3.8 Flash (High)",
                  supportedEfforts: ["high"],
                },
                {
                  id: "gemini-3.8-flash-medium",
                  label: "Gemini 3.8 Flash (Medium)",
                  supportedEfforts: ["medium"],
                },
                {
                  id: "gemini-3.8-flash-low",
                  label: "Gemini 3.8 Flash (Low)",
                  supportedEfforts: ["low"],
                },
              ],
              efforts: ["low", "medium", "high"],
            },
          ];
        return rpc.call(method, input);
      });

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

      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      const sidebar = page.getByRole("complementary", { name: "Workspace navigation" });
      await sidebar.getByRole("button", { name: /^Preserve the current workflow/ }).click();
      await page.locator(".flow-editor").waitFor();

      const modeBounds = await sidebar.locator(".sidebar-mode").evaluateAll((buttons) =>
        buttons.map((button) => {
          const { y, height } = button.getBoundingClientRect();
          return { y, height };
        }),
      );

      expect(modeBounds[0]).toEqual(modeBounds[1]);
      await sidebar.getByRole("button", { name: "Show Vibers" }).click();

      expect(
        await sidebar.locator(".sidebar-mode").evaluateAll((buttons) =>
          buttons.map((button) => {
            const { y, height } = button.getBoundingClientRect();
            return { y, height };
          }),
        ),
      ).toEqual(modeBounds);

      await page.getByRole("heading", { name: "Create your first Viber" }).waitFor();
      expect(await sidebar.locator(".sidebar-viber").count()).toBe(0);
      expect(await sidebar.getByRole("navigation").getByRole("button").count()).toBe(4);
      await page.screenshot({ path: join(screenshots, "viber-welcome.png") });
      const create = sidebar.getByRole("button", { name: "Create Viber", exact: true });
      await create.click();
      const editor = page.getByRole("dialog", { name: "Create Viber profile" });
      await editor.waitFor();

      expect(
        await editor
          .locator(".viber-editor-content")
          .evaluate((element) => element.scrollHeight <= element.clientHeight),
      ).toBe(true);

      expect(await editor.getByRole("region", { name: "Preset Vibers" }).count()).toBe(0);
      expect(await editor.evaluate((element) => getComputedStyle(element).borderWidth)).toBe("0px");

      expect(await editor.locator("details.viber-execution-settings").count()).toBe(0);

      expect(await editor.getByRole("combobox", { name: "Model", exact: true }).isVisible()).toBe(
        true,
      );

      expect(await editor.getByText("Execution settings", { exact: true }).count()).toBe(0);
      const model = editor.getByRole("combobox", { name: "Model", exact: true });
      await model.click();
      const picker = editor.locator(".viber-model-popover");
      await picker.getByRole("button", { name: "Antigravity", exact: true }).click();
      expect(await picker.getByRole("option", { name: /default/i }).count()).toBe(0);

      expect(
        await picker.getByRole("option", { name: "Gemini 3.8 Flash", exact: true }).count(),
      ).toBe(1);

      await picker.getByRole("option", { name: "Gemini 3.8 Flash", exact: true }).click();
      expect(await picker.isVisible()).toBe(true);
      expect(await picker.getByRole("button", { name: "Extra High", exact: true }).count()).toBe(0);
      await picker.getByRole("button", { name: "Medium", exact: true }).click();
      expect(await model.textContent()).toContain("Gemini 3.8 Flash Medium");

      expect(
        await picker
          .locator(".select-options")
          .evaluate((element) => getComputedStyle(element).scrollbarWidth),
      ).toBe("none");

      await picker.getByRole("button", { name: "Codex", exact: true }).click();
      await picker.getByRole("option", { name: "6.1 Sol", exact: true }).click();
      expect(await picker.isVisible()).toBe(true);
      await picker.getByRole("button", { name: "Extra High", exact: true }).click();
      expect(await model.textContent()).toContain("6.1 Sol Extra High");
      await picker.getByRole("combobox", { name: "Search model" }).focus();
      await page.keyboard.press("Tab");

      expect(await picker.evaluate((element) => element.contains(document.activeElement))).toBe(
        true,
      );

      await page.screenshot({ path: join(screenshots, "viber-model-picker.png") });
      await page.keyboard.press("Escape");
      expect(await model.evaluate((element) => element === document.activeElement)).toBe(true);
      await editor.getByLabel("Name", { exact: true }).fill("Orbit");

      await editor
        .getByLabel("Description", { exact: true })
        .fill("A careful reviewer for your next idea.");

      await editor
        .getByLabel("Instructions", { exact: true })
        .fill("Review the supplied context and explain observed results.");

      const instructions = editor.getByLabel("Instructions", { exact: true });
      const instructionHeight = (await instructions.boundingBox())!.height;
      await instructions.fill("A line of instructions.\n".repeat(18));

      await expect
        .poll(async () => (await instructions.boundingBox())!.height)
        .toBe(instructionHeight);

      expect(
        await instructions.evaluate((element) => element.scrollHeight > element.clientHeight),
      ).toBe(true);

      expect(await instructions.evaluate((element) => getComputedStyle(element).resize)).toBe(
        "none",
      );

      await instructions.fill("Review the supplied context and explain observed results.");
      await editor.getByRole("tab", { name: "Glasses", exact: true }).click();
      await editor.getByRole("button", { name: "Square", exact: true }).click();
      await editor.getByRole("tab", { name: "Accessories", exact: true }).click();
      await editor.getByRole("button", { name: "Headphones", exact: true }).click();
      await editor.getByRole("tab", { name: "Shape", exact: true }).click();
      await editor.getByRole("button", { name: "Diamond", exact: true }).click();
      await editor.getByRole("tab", { name: "Color", exact: true }).click();
      await editor.getByLabel("Custom HEX").fill("#45a5d9");
      await editor.getByRole("tab", { name: "Lips", exact: true }).click();
      await editor.getByRole("button", { name: "Smile", exact: true }).click();
      await editor.getByRole("tab", { name: "Eyes", exact: true }).click();
      await editor.getByRole("button", { name: "Wink", exact: true }).click();
      await editor.getByRole("tab", { name: "Shape", exact: true }).click();

      expect(
        await editor
          .getByRole("button", { name: "Diamond", exact: true })
          .getAttribute("aria-pressed"),
      ).toBe("true");

      await editor.locator(".viber-editor-content").evaluate((element) => {
        element.scrollTop = 0;
      });

      await page.screenshot({ path: join(screenshots, "create-viber-1440.png") });

      for (let index = 0; index < 35; index++) {
        await page.keyboard.press("Tab");

        expect(await editor.evaluate((element) => element.contains(document.activeElement))).toBe(
          true,
        );
      }

      await page.keyboard.press("Control+b");
      expect(await sidebar.isVisible()).toBe(true);
      await page.keyboard.press("Escape");
      const discard = page.getByRole("dialog", { name: "Discard unsaved changes?" });
      await discard.getByRole("button", { name: "Keep editing" }).click();
      expect(await editor.getByLabel("Name", { exact: true }).inputValue()).toBe("Orbit");
      const tabs = editor.getByRole("tablist");
      await tabs.getByRole("tab", { name: "Shape", exact: true }).focus();
      await page.keyboard.press("End");

      await expect
        .poll(() =>
          tabs.getByRole("tab", { name: "Accessories", exact: true }).getAttribute("aria-selected"),
        )
        .toBe("true");

      await page.keyboard.press("Home");
      await page.emulateMedia({ reducedMotion: "reduce" });
      for (const [width, height] of [
        [1280, 720],
        [800, 540],
        [390, 640],
      ]) {
        await resize(width, height);

        expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );

        expect(
          await editor
            .locator(".viber-editor-content")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);

        await expect
          .poll(async () => {
            const actions = await editor
              .getByRole("button", { name: "Create Viber", exact: true })
              .boundingBox();

            return actions!.y + actions!.height;
          })
          .toBeLessThanOrEqual(height);

        if (width >= 1280) {
          expect(
            await editor
              .locator(".viber-editor-content")
              .evaluate((element) => element.scrollHeight <= element.clientHeight),
          ).toBe(true);

          for (const category of ["Shape", "Color", "Eyes", "Accessories"]) {
            await editor.getByRole("tab", { name: category, exact: true }).click();

            expect(
              await editor
                .locator(".viber-editor-content")
                .evaluate((element) => element.scrollHeight <= element.clientHeight),
            ).toBe(true);
          }

          await editor.getByRole("tab", { name: "Shape", exact: true }).click();
        }

        await page.screenshot({ path: join(screenshots, `create-viber-${width}.png`) });
      }

      await resize(1440, 900);
      await page.evaluate(() => document.documentElement.style.setProperty("--accent", "#dd9a4d"));

      await expect
        .poll(() =>
          tabs
            .getByRole("tab", { name: "Shape", exact: true })
            .evaluate((element) => getComputedStyle(element).borderBottomWidth),
        )
        .toBe("0px");

      await page.screenshot({ path: join(screenshots, "custom-accent.png") });
      await page.evaluate(() => document.documentElement.style.removeProperty("--accent"));
      await editor.getByRole("button", { name: "Create Viber", exact: true }).click();
      await editor.waitFor({ state: "detached" });

      await expect
        .poll(() => create.evaluate((element) => element === document.activeElement))
        .toBe(true);

      await expect.poll(() => sidebar.locator(".sidebar-viber").count()).toBe(1);

      const profile = engine.db
        .all<{ id: string }>("SELECT id FROM agent_profiles")
        .map(({ id }) => engine.flows.profile(id))
        .find((profile) => profile.name === "Orbit")!;

      expect(profile.description).toBe("A careful reviewer for your next idea.");

      expect(profile.appearance).toMatchObject({
        shape: "diamond",
        color: "#45a5d9",
        eyes: "wink",
        glasses: "square",
        accessory: "headphones",
        lips: "smile",
      });

      const conversation = engine.createGeneralTask({
        request_id: randomUUID(),
        goal: "Review a launch update",
        profile_id: profile.id,
        repository_id: null,
      });

      const chatNode = engine.flows.definition(conversation.flow_id!).definition.nodes[0];
      for (const [role, content, time] of [
        ["user", "What is the latest update on the launch?", "2026-11-14T09:41:00.000Z"],
        [
          "assistant",
          "The plan is ready for review. I found two items that still need your decision.",
          "2026-11-14T09:41:05.000Z",
        ],
        ["user", "Perfect. Keep me posted this week.", "2026-11-14T09:41:10.000Z"],
      ])
        engine.db.run(
          "INSERT INTO task_messages(id,task_id,role,content,created_at,status,purpose,flow_node_id,viber_profile_id) VALUES(?,?,?,?,?,'chat_completed','chat',?,?)",
          randomUUID(),
          conversation.id,
          role,
          content,
          time,
          chatNode.id,
          profile.id,
        );

      await sidebar.getByRole("button", { name: /Orbit/ }).click();
      await page.getByRole("region", { name: "Chat with Orbit" }).waitFor();
      const chat = page.getByRole("region", { name: "Chat with Orbit" });
      const prompt = chat.getByRole("textbox", { name: "Message Orbit" });
      await prompt.click();
      expect(await prompt.evaluate((element) => getComputedStyle(element).borderWidth)).toBe("0px");
      await page.screenshot({ path: join(screenshots, "viber-chat-welcome.png") });
      const savedBeforeSelection = profileSaves.length;
      const chatModel = chat.getByRole("combobox", { name: "Model", exact: true });
      await chatModel.click();
      const chatPicker = page.locator(".viber-model-popover");
      await chatPicker.getByRole("button", { name: "Antigravity", exact: true }).click();
      await chatPicker.getByRole("option", { name: "Gemini 3.8 Flash", exact: true }).click();
      await chatPicker.getByRole("button", { name: "Low", exact: true }).click();
      expect(await chatPicker.isVisible()).toBe(true);
      expect(profileSaves.length).toBe(savedBeforeSelection);
      await page.keyboard.press("Escape");

      expect(engine.flows.profile(profile.id).execution).toEqual(profile.execution);
      expect(profileSaves.length).toBe(savedBeforeSelection);
      const composer = chat.locator(".chat-input");

      expect(await composer.evaluate((element) => getComputedStyle(element).borderWidth)).toBe(
        "0px",
      );

      expect(await composer.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
        "rgb(32, 40, 55)",
      );

      expect((await composer.boundingBox())!.height).toBeGreaterThanOrEqual(110);
      expect(await chat.locator(".viber-chat-welcome .viber-idle").count()).toBe(1);
      await chat.locator(".viber-chat-history > summary").click();
      await chat.getByRole("button", { name: "Review a launch update", exact: true }).click();

      await chat
        .getByText(
          "The plan is ready for review. I found two items that still need your decision.",
          { exact: true },
        )
        .waitFor();

      expect(await chat.locator(".viber-chat-welcome").count()).toBe(0);
      const outgoing = chat.locator(".user-message").first();
      const incoming = chat.locator(".saved-assistant-message").first();
      expect((await incoming.boundingBox())!.height).toBeLessThanOrEqual(60);
      expect((await outgoing.boundingBox())!.x).toBeGreaterThan((await incoming.boundingBox())!.x);
      const savedPrompt = chat.getByRole("textbox", { name: "Viber conversation" });
      await savedPrompt.click();

      expect(await savedPrompt.evaluate((element) => getComputedStyle(element).borderWidth)).toBe(
        "0px",
      );

      await page.screenshot({ path: join(screenshots, "viber-chat.png") });
      expect(await page.locator(".flow-editor").count()).toBe(0);
      await page.getByRole("button", { name: "Edit Viber", exact: true }).click();
      const edit = page.getByRole("dialog", { name: "Edit Viber profile" });
      await edit.getByRole("tab", { name: "Color", exact: true }).click();
      expect(await edit.getByLabel("Custom HEX").inputValue()).toBe("#45a5d9");
      await edit.getByRole("button", { name: "Randomize Appearance" }).click();
      await edit.getByRole("button", { name: "Purple", exact: true }).click();
      await edit.getByRole("tab", { name: "Glasses", exact: true }).click();
      await edit.getByRole("button", { name: "Round", exact: true }).click();
      await edit.getByRole("button", { name: "Save Viber", exact: true }).click();
      await edit.waitFor({ state: "detached" });

      expect(engine.flows.profile(profile.id).appearance).toMatchObject({
        color: "#9b5cff",
        glasses: "round",
      });

      expect(engine.flows.profile(profile.id).instructions).toBe(profile.instructions);
      expect(engine.db.all("SELECT id FROM flow_runs")).toHaveLength(0);
      await sidebar.getByRole("button", { name: "Show Tasks" }).click();

      await sidebar.getByRole("button", { name: /^Preserve the current workflow/ }).click();
      await page.locator(".flow-editor").waitFor();
      expect(engine.db.task(task.id).goal).toBe("Preserve the current workflow");
      await sidebar.getByRole("button", { name: "New task", exact: true }).click();
      await page.getByRole("dialog", { name: "New Viber task" }).waitFor();

      await page
        .getByRole("dialog", { name: "New Viber task" })
        .getByRole("button", { name: "Close", exact: true })
        .click();

      await sidebar.getByRole("button", { name: "Settings", exact: true }).click();
      const settings = page.getByRole("dialog", { name: "Settings", exact: true });
      await settings.waitFor();

      expect(await settings.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
        "rgb(23, 29, 42)",
      );

      await settings
        .getByRole("combobox", { name: "Notification preference", exact: true })
        .click();

      await settings.getByRole("option", { name: "All notifications", exact: true }).click();
      const toast = page.locator(".notification").filter({ hasText: "Settings saved" });
      await toast.waitFor();

      const centers = await toast.evaluate((element) =>
        Array.from(element.children).map((child) => {
          const rect = child.getBoundingClientRect();
          return rect.y + rect.height / 2;
        }),
      );

      expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
      expect((await toast.boundingBox())!.height).toBeLessThanOrEqual(48);
      await page.screenshot({ path: join(screenshots, "notification-spacing.png") });
      await toast.getByRole("button", { name: "Dismiss notification" }).click();
      await page.screenshot({ path: join(screenshots, "settings-theme.png") });
      await settings.getByRole("button", { name: "Close Settings", exact: true }).click();
      expect(errors).toEqual([]);
      console.log(`Avatar Electron screenshots: ${screenshots}`);
    } finally {
      await app.close();
      await rpc.close();
      await engine.close();
      if (!process.env.VIBESTAR_KEEP_EVIDENCE) await rm(dir, { recursive: true, force: true });
    }
  },
  90000,
);
