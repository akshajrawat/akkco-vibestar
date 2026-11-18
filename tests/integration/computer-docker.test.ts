import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { Engine } from "../../apps/core/execution/engine";
import {
  testProfileIds as builtInProfiles,
  createTestProfiles as initializeProfiles,
} from "../helpers/viber-fixtures";
import { capture, execute } from "../../apps/core/execution/runtime/process";
import { Rpc } from "../../apps/core/rpc";

const requested = process.env.VIBESTAR_DOCKER_TEST === "1";

const docker = requested
  ? await capture("docker", ["--host", "unix:///var/run/docker.sock", "info"], process.cwd()).catch(
      () => null,
    )
  : null;

it.skipIf(!requested || docker?.code !== 0)(
  "runs real Docker with persistent homes, isolated mounts, terminal access and destructive cleanup",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "vibestar-real-computer-"));
    const root = join(directory, "data");
    let engine = await Engine.create(root);
    initializeProfiles(engine.db);
    let rpc = new Rpc(engine);
    const profile_id = builtInProfiles.implementer;
    const session = engine.viberSessions.store.create({ profile_id, request_id: randomUUID() });
    const scope = { profile_id, session_id: session.id };
    try {
      const workspace = await engine.viberSessions.prepareWorkspace(session.id, profile_id);
      await writeFile(join(directory, "host-secret.txt"), "must stay on host");
      const release = engine.computers.acquire(scope, "agent", async () => {});
      try {
        await engine.computers.ensure(scope, workspace);
        const transform = await engine.computers.transform(scope);

        const output = await execute({
          ...transform({
            program: "node",
            args: [
              "-e",
              `const fs=require('fs'); if(process.getuid()===0)process.exit(2); for(const path of [${JSON.stringify(join(directory, "host-secret.txt"))},'/var/run/docker.sock']) {if(fs.existsSync(path))process.exit(3);} fs.writeFileSync('/home/viber/data/installed.txt','persisted');fs.writeFileSync('code.txt','changed');`,
            ],
          }),
          cwd: root,
        });

        expect(output.code).toBe(0);
        expect(await readFile(join(workspace, "code.txt"), "utf8")).toBe("changed");
        await engine.computers.finish(profile_id);
      } finally {
        release();
      }

      await rpc.close();
      await engine.close();
      engine = await Engine.create(root);
      rpc = new Rpc(engine);

      await engine.computers.control(scope, "start", undefined, () =>
        engine.viberSessions.prepareWorkspace(session.id, profile_id),
      );

      const lease = engine.computers.acquire(scope, "agent", async () => {});
      try {
        const transform = await engine.computers.transform(scope);

        expect(
          (
            await execute({
              ...transform({ program: "cat", args: ["/home/viber/data/installed.txt"] }),
              cwd: root,
            })
          ).stdout,
        ).toBe("persisted");
      } finally {
        lease();
      }

      const terminal = await engine.computers.openTerminal(scope, () =>
        engine.viberSessions.prepareWorkspace(session.id, profile_id),
      );

      engine.computers.terminalInput(scope, terminal.id, "printf 'real-terminal-ready\\n'\r");

      await expect
        .poll(() => engine.computers.terminalStatus(scope)?.output, { timeout: 10000 })
        .toContain("real-terminal-ready");

      await engine.computers.closeTerminal(scope);
      await engine.computers.control(scope, "reset", true);
      expect(await readFile(join(workspace, "code.txt"), "utf8")).toBe("changed");
      await rpc.call("profile.delete", { profile_id, confirmed: true });
    } finally {
      await rpc.close();
      await engine.computers.remove({ profile_id: builtInProfiles.reviewer });
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  660000,
);
