import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { defaultSettings } from "../../apps/core/domain";
import { Rpc } from "../../apps/core/rpc";
import { CodexProvider } from "../../apps/core/execution/providers/codex";
import type { AgentRunRequest } from "../../apps/core/execution/providers/contracts";
import { checked } from "../../apps/core/execution/runtime/process";
import type { ViberMessage, ViberSession } from "../../apps/core/vibers/contracts";
import {
  sharedCommandUrl,
  sharedFilesMount,
  sharedServicesMount,
} from "../../apps/core/computers/contracts";
import { desktopImageTag, guestServiceCommand } from "../../apps/core/computers/image";
import { createFixtureEngine, detectFixtureProvider } from "../helpers/fixtures";
import { testProfileIds } from "../helpers/viber-fixtures";

const marker = "shared-docker-smoke-ready";
const editedMarker = "updated-by-second-viber";
const selection = { provider: "codex", model: "next-model", effort: "high" } as const;
const profileIds = [testProfileIds.implementer, testProfileIds.reviewer];

class ComputerFixtureProvider extends CodexProvider {
  detect = detectFixtureProvider;

  invocation = (request: AgentRunRequest) => {
    const [prompt] = request.prompt.split("\n\nShared Computer is enabled");
    const structuredPrompt = prompt.split("\n\n", 2)[1];

    const content = structuredPrompt?.startsWith("{")
      ? JSON.parse(structuredPrompt).inputs.at(-1).content
      : prompt;

    return {
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
      const canControl = use && ${request.access === "workspace-write"};
      const command = (script) => JSON.parse(execFileSync('curl', [
        '--fail', '--max-time', '10', '--unix-socket', socket, '--data-binary', script,
        ${JSON.stringify(sharedCommandUrl)},
      ], {encoding:'utf8'}));
      assert.equal(fs.existsSync('/var/run/docker.sock'), false);
      assert.equal(fs.existsSync('/tmp/.X11-unix/X0'), false);
      assert.equal(fs.existsSync(files), use);
      assert.equal(fs.existsSync(socket), canControl);
      assert.equal(${JSON.stringify(request.prompt.includes(sharedCommandUrl))}, canControl);
      const privateProject = ${content === "keep using the private project"};
      assert.equal(process.cwd(), ${JSON.stringify(request.cwd)});
      if (privateProject) {
        assert.equal(fs.readFileSync('normal-viber.txt', 'utf8'), 'kept');
        assert.match(fs.readFileSync(files + '/index.html', 'utf8'), /${editedMarker}/);
      } else if (use) {
        assert.equal(process.cwd(), files);
      }
      if (${content === "write the smoke file"}) {
        fs.writeFileSync('index.html', '<h1>${marker}</h1>');
      } else if (use && !privateProject) {
        assert.match(fs.readFileSync('index.html', 'utf8'), /${marker}/);
      }
      if (${content === "read the shared file in read-only mode"}) {
        assert.equal(canControl, false);
        assert.throws(() => fs.appendFileSync('index.html', 'unexpected write'), { code: 'EROFS' });
      }
      if (${content === "edit the open smoke app"}) {
        assert.match(command("curl -fsS http://127.0.0.1:9222/json/list").stdout, /127.0.0.1:8049/);
        fs.appendFileSync('index.html', '<p>${editedMarker}</p>');
        assert.match(execFileSync('curl', ['--fail', '--unix-socket', socket, 'http://localhost:8049/'], {encoding:'utf8'}), /${editedMarker}/);
      }
      if (${content === "start the smoke server"}) {
        const started = command('${guestServiceCommand} python3 -m http.server 8049 --bind 127.0.0.1');
        assert.equal(started.code, 0, started.stderr);
        assert.ok(JSON.parse(started.stdout).pid > 0);
      }
      if (canControl && ${content === "read the guest service"}) {
        assert.match(execFileSync('curl', ['--fail', '--unix-socket', socket, 'http://localhost:8049/'], {encoding:'utf8'}), /${marker}/);
      }
      if (${content.startsWith("open the smoke page in Chromium")}) {
        const env = command('printf "%s %s %s" "$DISPLAY" "$PWD" "$BROWSER"; gh --version >/dev/null');
        assert.equal(env.code, 0, env.stderr);
        assert.equal(env.stdout, ':0 /home/viber/workspace /usr/local/bin/vibestar-browser');
        assert.equal(command('exit 7').code, 7);
        const opened = command('vibestar-browser http://127.0.0.1:8049/');
        assert.equal(opened.code, 0, opened.stderr);
      }
      if (${content === "inspect the smoke page in Chromium"}) {
        const script = [
          "node --input-type=module <<'JS'",
          "const pages = await (await fetch('http://127.0.0.1:9222/json/list')).json();",
          "const page = pages.find((item) => item.url === 'http://127.0.0.1:8049/');",
          "const socket = new WebSocket(page.webSocketDebuggerUrl);",
          "const send = (id, method, params) => socket.send(JSON.stringify({ id, method, params }));",
          "socket.addEventListener('open', () => send(1, 'Page.enable'));",
          "socket.addEventListener('message', (event) => {",
          "  const reply = JSON.parse(event.data);",
          "  if (reply.id === 1) send(2, 'Page.reload');",
          "  if (reply.method === 'Page.loadEventFired') send(3, 'Runtime.evaluate', { expression: 'document.body.innerText' });",
          "  if (reply.id === 3) { console.log(reply.result.result.value); socket.close(); }",
          "});",
          "JS",
        ].join('\\n');
        const output = command(script);
        assert.equal(output.code, 0, output.stderr);
        assert.match(output.stdout, /${editedMarker}/);
      }
      console.log(JSON.stringify({type: 'thread.started', thread_id: ${JSON.stringify(request.conversation?.threadId || request.runId)}}));
      console.log(JSON.stringify({type: 'item.completed', item:{type: 'agent_message',text: 'Isolated chat ran successfully.'}}));
      console.log(JSON.stringify({type: 'turn.completed'}));
    `,
      ],
    };
  };
}

it.skipIf(process.env.VIBESTAR_DOCKER_TEST !== "1")(
  "lets opted-in Vibers control a real Chromium desktop and share files and services",
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

      expect(await call("computer.control", { action: "start" })).toMatchObject({
        status: "ready",
        error: null,
      });

      const [{ socket }] = engine.db.all<{ socket: string }>("SELECT socket FROM shared_computer");

      const docker = (...args: string[]) =>
        checked("docker", ["--host", `unix://${socket}`, ...args], directory);

      const inspection = JSON.parse(await docker("inspect", name))[0];
      expect(inspection.Config.Image).toBe(desktopImageTag(process.getuid!(), process.getgid!()));
      expect(inspection.HostConfig.PortBindings ?? {}).toEqual({});
      expect(inspection.Mounts).toHaveLength(2);
      expect(inspection.HostConfig.Privileged).toBe(false);
      expect(inspection.HostConfig.CapDrop).toContain("ALL");
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

      await send(sessions[0], "start the smoke server");

      await expect
        .poll(() => docker("exec", name, "curl", "-fsS", "http://127.0.0.1:8049").catch(() => ""))
        .toContain(marker);

      await send(sessions[1], "read the guest service");
      await send(sessions[0], "open the smoke page in Chromium");

      await expect
        .poll(() => docker("exec", name, "xdotool", "getactivewindow", "getwindowname"))
        .toContain("127.0.0.1");

      await send(sessions[1], "edit the open smoke app");

      expect(
        await readFile(join(engine.root, "shared-computer", "files", "index.html"), "utf8"),
      ).toContain(editedMarker);

      await send(sessions[0], "inspect the smoke page in Chromium");

      const controller = new AbortController();
      let commandPid: number | undefined;

      await engine.computers.withTurn(false, controller.signal, async ({ socket }) => {
        const client = request(
          { socketPath: socket, path: "/exec", method: "POST", headers: { host: "computer" } },
          (response) => response.resume(),
        );

        const closed = new Promise<void>((resolve) => client.once("close", resolve));
        client.on("error", () => {});
        client.end("echo $$ > command.pid; exec sleep 60");

        try {
          const pidPath = join(host.root, "shared-computer", "files", "command.pid");

          await expect
            .poll(
              async () => {
                commandPid = Number(await readFile(pidPath, "utf8").catch(() => ""));
                return commandPid;
              },
              { timeout: 10000 },
            )
            .toBeGreaterThan(0);
        } finally {
          controller.abort();
          client.destroy();
          await closed;
        }
      });

      await expect
        .poll(() =>
          docker(
            "exec",
            name,
            "sh",
            "-c",
            'if test -d "/proc/$1"; then printf alive; else printf absent; fi',
            "check-process",
            String(commandPid),
          ),
        )
        .toBe("absent");

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

      const browserState = () =>
        docker(
          "exec",
          name,
          "sh",
          "-c",
          'status=0; pgrep -x chromium >/dev/null || status=$?; case "$status" in 0) printf open ;; 1) printf closed ;; *) exit "$status" ;; esac',
        );

      expect(await call("computer.desktop.frame", { controller_id })).toMatch(/^\/9j\//);
      expect(await browserState()).toBe("open");
      await input({ type: "key", keys: "ctrl+shift+w" });
      await call("computer.desktop.release", { controller_id });

      await expect.poll(browserState).toBe("closed");

      await send(sessions[0], "open the smoke page in Chromium after closing it");

      await expect
        .poll(() => docker("exec", name, "xdotool", "getactivewindow", "getwindowname"))
        .toContain("127.0.0.1");

      await call("profile.delete", { profile_id: sessions[0].profile_id, confirmed: true });
      expect(await call("computer.status", {})).toMatchObject({ status: "ready" });
      await send(sessions[1], "read the guest service");
      await docker("exec", name, "sh", "-c", "printf persisted > /home/viber/smoke-home");

      expect(await call("computer.control", { action: "restart" })).toMatchObject({
        status: "ready",
      });

      expect(await docker("inspect", "--format", "{{.Image}}", name)).toBe(inspection.Image);
      expect(await docker("exec", name, "cat", "/home/viber/smoke-home")).toBe("persisted");
      await expect(docker("exec", name, "curl", "-fsS", "http://127.0.0.1:8049")).rejects.toThrow();
      await send(sessions[1], "read the shared file");

      const writable = engine.vibers.profile(sessions[1].profile_id);

      engine.vibers.saveProfile(
        {
          ...writable,
          revision: writable.revision + 1,
          execution: { ...writable.execution, access: "read-only" },
        },
        writable.revision,
      );

      await send(sessions[1], "read the shared file in read-only mode");

      await docker("exec", name, "sh", "-c", "printf saved > /home/viber/chromium/smoke-profile");

      expect(await call("computer.control", { action: "stop" })).toMatchObject({
        status: "stopped",
      });

      await docker("container", "rm", name);

      await docker(
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "/bin/ln",
        "--mount",
        `type=volume,source=${name}-home,target=/home/viber`,
        desktopImageTag(process.getuid!(), process.getgid!()),
        "-sfn",
        "previous-desktop-17",
        "/home/viber/chromium/SingletonLock",
      );

      expect(await call("computer.control", { action: "start" })).toMatchObject({
        status: "ready",
      });

      expect(await docker("exec", name, "cat", "/home/viber/chromium/smoke-profile")).toBe("saved");

      const workspace = await engine.viberSessions.prepareWorkspace(
        sessions[1].id,
        sessions[1].profile_id,
      );

      const sentinel = join(workspace, "normal-viber.txt");
      await writeFile(sentinel, "kept");
      await send(sessions[1], "keep using the private project");

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
      await expect(docker("network", "inspect", `${name}-net`)).rejects.toThrow();
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
