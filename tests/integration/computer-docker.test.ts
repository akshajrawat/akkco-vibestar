import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { defaultSettings } from "../../apps/core/domain";
import { Rpc } from "../../apps/core/rpc";
import { CodexProvider } from "../../apps/core/execution/providers/codex";
import type { AgentRunRequest } from "../../apps/core/execution/providers/contracts";
import { checked } from "../../apps/core/execution/runtime/process";
import type { ViberMessage, ViberSession } from "../../apps/core/vibers/contracts";
import { sharedFilesMount, sharedServicesMount } from "../../apps/core/computers/contracts";
import { createFixtureEngine, detectFixtureProvider } from "../helpers/fixtures";
import { testProfileIds } from "../helpers/viber-fixtures";

const marker = "shared-docker-smoke-ready";
const selection = { provider: "codex", model: "next-model", effort: "high" } as const;
const profileIds = [testProfileIds.implementer, testProfileIds.reviewer];

class ComputerFixtureProvider extends CodexProvider {
  detect = detectFixtureProvider;

  invocation = (request: AgentRunRequest) => ({
    program: process.execPath,
    input: "",
    args: [
      "-e",
      `
      const fs = require("node:fs");
      const { execFileSync } = require("node:child_process");
      const assert = require("node:assert/strict");
      const files = ${JSON.stringify(sharedFilesMount)};
      const socket = ${JSON.stringify(sharedServicesMount)};
      const use = ${JSON.stringify(request.sharedComputer)};
      assert.equal(fs.existsSync('/var/run/docker.sock'), false);
      assert.equal(fs.existsSync('/tmp/.X11-unix/X0'), false);
      assert.equal(fs.existsSync(files), use);
      assert.equal(fs.existsSync(socket), use && ${request.access === "workspace-write"});
      if (${JSON.stringify(request.prompt.includes("write the smoke file"))}) {
        fs.writeFileSync(files + '/index.html', '<h1>${marker}</h1>');
      } else if (use) {
        assert.match(fs.readFileSync(files + '/index.html', 'utf8'), /${marker}/);
      }
      if (${JSON.stringify(request.prompt.includes("read the guest service"))}) {
        assert.match(execFileSync('curl', ['--fail', '--unix-socket', socket, 'http://localhost:8049/'], {encoding:'utf8'}), /${marker}/);
      }
      console.log(JSON.stringify({type: 'thread.started', thread_id: ${JSON.stringify(request.conversation?.threadId || request.runId)}}));
      console.log(JSON.stringify({type: 'item.completed', item:{type: 'agent_message',text: 'Isolated chat ran successfully.'}}));
      console.log(JSON.stringify({type: 'turn.completed'}));
    `,
    ],
  });
}

it.skipIf(process.env.VIBESTAR_DOCKER_TEST !== "1")(
  "runs a real Linux desktop, shares files and a service across Vibers, and resets only its data",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "vibestar-real-computer-"));
    const provider = new ComputerFixtureProvider();
    let engine: Awaited<ReturnType<typeof createFixtureEngine>> | undefined;
    let rpc: Rpc | undefined;
    let failure: unknown;
    const cleanupErrors: unknown[] = [];
    let sessions: ViberSession[] = [];
    try {
      engine = await createFixtureEngine(join(directory, "data"), () => provider);
      engine.db.saveSettings({ ...defaultSettings, allow_viber_communication: true });
      const host = engine;
      rpc = new Rpc(engine);
      const call = rpc.call;
      const owner = createHash("sha256").update(engine.root).digest("hex").slice(0, 24);
      const name = `vibestar-shared-${owner}`;
      const docker = (...args: string[]) => checked("docker", args, directory);

      expect(await call("computer.control", { action: "start" })).toMatchObject({
        status: "ready",
        error: null,
      });

      const inspection = JSON.parse(await docker("inspect", name))[0];
      expect(inspection.HostConfig.PortBindings ?? {}).toEqual({});
      expect(inspection.Mounts).toHaveLength(2);
      expect(await docker("exec", name, "xset", "q")).toMatch(/timeout:\s+0\b/);

      await docker(
        "exec",
        name,
        "sh",
        "-c",
        "test ! -S /var/run/docker.sock && test $(id -u) -ne 0",
      );

      const writer = engine.vibers.profile(profileIds[0]);
      const reader = engine.vibers.profile(profileIds[1]);

      engine.vibers.saveProfile(
        {
          ...reader,
          revision: reader.revision + 1,
          supported_access: ["workspace-write", "read-only"],
          execution: { ...writer.execution, ...selection },
        },
        reader.revision,
      );

      sessions = await Promise.all(
        profileIds.map(
          async (profile_id) =>
            (await call("viber.session.create", {
              profile_id,
              request_id: randomUUID(),
              selection,
            })) as ViberSession,
        ),
      );

      const send = async (session: ViberSession, content: string, shared = true) => {
        const request_id = randomUUID();

        await call("viber.session.send", {
          profile_id: session.profile_id,
          session_id: session.id,
          request_id,
          content,
          history_ids: [],
          ...(shared ? { shared_computer: true } : {}),
        });

        await expect
          .poll(() => host.isActive(`viber:${session.id}`), { timeout: 15000 })
          .toBe(false);

        expect(
          host.db.all("SELECT status,error FROM viber_messages WHERE id=?", request_id),
        ).toMatchObject([{ status: "completed", error: null }]);

        const messages = (
          (await call("viber.session.detail", {
            session_id: session.id,
            profile_id: session.profile_id,
          })) as { messages: ViberMessage[] }
        ).messages;

        expect(messages.at(-1)?.content).toBe("Isolated chat ran successfully.");
      };

      await send(sessions[0], "write the smoke file");

      expect(
        await readFile(join(engine.root, "shared-computer", "files", "index.html"), "utf8"),
      ).toContain(marker);

      await docker(
        "exec",
        "-d",
        name,
        "sh",
        "-c",
        "nohup python3 -m http.server 8049 --bind 127.0.0.1 >/tmp/http.log 2>&1",
      );

      await expect
        .poll(() => docker("exec", name, "curl", "-fsS", "http://127.0.0.1:8049").catch(() => ""))
        .toContain(marker);

      await send(sessions[1], "read the guest service");
      const controller_id = randomUUID();
      await call("computer.desktop.acquire", { controller_id });

      await expect(
        call("computer.desktop.acquire", { controller_id: randomUUID() }),
      ).rejects.toThrow("Another window");

      const input = (value: unknown) =>
        call("computer.desktop.input", { controller_id, input: value });

      await input({ type: "key", keys: "ctrl+l" });
      await input({ type: "text", text: "http://127.0.0.1:8049" });
      await input({ type: "key", keys: "Return" });

      await expect
        .poll(() => docker("exec", name, "xdotool", "getactivewindow", "getwindowname"))
        .toContain("127.0.0.1");

      expect(await call("computer.desktop.frame", { controller_id })).toMatch(/^\/9j\//);
      await call("computer.desktop.release", { controller_id });

      await call("profile.delete", { profile_id: sessions[0].profile_id, confirmed: true });
      expect(await call("computer.status", {})).toMatchObject({ status: "ready" });
      await send(sessions[1], "read the guest service");
      await docker("exec", name, "sh", "-c", "printf persisted > /home/viber/smoke-home");

      expect(await call("computer.control", { action: "restart" })).toMatchObject({
        status: "ready",
      });

      expect(await docker("exec", name, "cat", "/home/viber/smoke-home")).toBe("persisted");
      await send(sessions[1], "read the shared file");

      const workspace = await engine.viberSessions.prepareWorkspace(
        sessions[1].id,
        sessions[1].profile_id,
      );

      const sentinel = join(workspace, "normal-viber.txt");
      await writeFile(sentinel, "kept");

      expect(await call("computer.control", { action: "stop" })).toMatchObject({
        status: "stopped",
        has_data: true,
      });

      await send(sessions[1], "send a normal message while stopped", false);
      await expect(call("computer.control", { action: "reset" })).rejects.toThrow();

      expect(await call("computer.control", { action: "reset", confirmed: true })).toMatchObject({
        status: "stopped",
        has_data: false,
      });

      await expect(docker("container", "inspect", name)).rejects.toThrow();
      await expect(docker("volume", "inspect", `${name}-home`)).rejects.toThrow();
      expect(await readFile(sentinel, "utf8")).toBe("kept");
    } catch (error) {
      failure = error;
    } finally {
      for (const clean of [
        async () => {
          await Promise.allSettled(
            sessions.map((session) => engine?.viberSessions.cancel(session.id, session.profile_id)),
          );

          if (engine?.db.all("SELECT singleton FROM shared_computer").length) {
            const status = await engine.computers.control("reset");
            if (status.error) {
              throw new Error(status.error);
            }
          }
        },
        () => rpc?.close(),
        () => engine?.close(),
        () => rm(directory, { recursive: true, force: true }),
      ]) {
        try {
          await clean();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }

    if (failure) {
      throw failure;
    }

    if (cleanupErrors.length) {
      throw new AggregateError(cleanupErrors, "Docker smoke cleanup failed");
    }
  },
  960000,
);
