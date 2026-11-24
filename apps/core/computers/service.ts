import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";

import { spawn, type IPty } from "node-pty";

import { AdeError } from "../domain";
import type { Engine } from "../execution/engine";
import {
  execute,
  cleanEnvironment,
  redact,
  type ProcessRequest,
} from "../execution/runtime/process";
import { StreamRedactor } from "../execution/output/stream-redactor";
import { OutputBudget } from "../execution/output/bounded-output";
import { CodexProvider } from "../execution/providers/codex";
import { AntigravityProvider } from "../execution/providers/antigravity";
import { ViberSessionStore } from "../vibers/store";
import type { ComputerStatus, ComputerTerminal } from "./contracts";
import { computerImage } from "./image";

export type ProcessTransform = (request: {
  program: string;
  args: string[];
  cwd?: string;
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}) => ProcessRequest;

type Scope = { profile_id: string; session_id?: string };

interface Inspection {
  Id: string;
  Config: { Labels: Record<string, string> };
  State: { Running: boolean };
}

interface Lease {
  scope: Scope;
  kind: "agent" | "terminal" | "control";
  release: () => void;
}

/** The core alone owns Docker authority. No renderer-supplied names, mounts or commands. */
export class Computers {
  private readonly owner: string;

  private readonly leases = new Map<string, Lease>();

  private readonly states = new Map<string, ComputerStatus>();

  private readonly terminals = new Map<
    string,
    { pty: IPty; snapshot: ComputerTerminal; lease: Lease; exited: Promise<void> }
  >();

  private imageReady?: Promise<void>;

  private closed = false;

  private readonly pending = new Set<Promise<unknown>>();

  private track = <T>(operation: () => Promise<T>) => {
    const promise = operation().finally(() => this.pending.delete(promise));
    this.pending.add(promise);
    return promise;
  };

  beginShutdown = () => this.controller.abort();

  private readonly controller = new AbortController();

  constructor(
    private readonly engine: Pick<
      Engine,
      "root" | "db" | "git" | "assertAvailable" | "publish" | "trackActivity"
    >,
  ) {
    this.owner = createHash("sha256").update(engine.root).digest("hex").slice(0, 24);
  }

  authorize = (scope: Scope) => {
    if (this.closed) {
      throw new AdeError("closed", "Computers are shutting down.");
    }

    if (
      !/^[a-f0-9-]{36}$/i.test(scope.profile_id) ||
      !this.engine.db.all(
        "SELECT id FROM agent_profiles WHERE id=? AND id NOT IN (SELECT profile_id FROM retired_viber_profiles)",
        scope.profile_id,
      ).length
    ) {
      throw new AdeError("not_found", "Select an active Viber profile.");
    }

    if (scope.session_id) {
      new ViberSessionStore(this.engine.db).session(scope.session_id, scope.profile_id);
    }
  };

  private names = (profile: string) => {
    const name = `vibestar-${this.owner}-${profile}`;
    return { container: name, volume: `${name}-home`, network: `${name}-net` };
  };

  private socket = async () => {
    for (const path of [`/run/user/${process.getuid?.()}/docker.sock`, "/var/run/docker.sock"]) {
      if ((await lstat(path).catch(() => null))?.isSocket()) {
        return `unix://${path}`;
      }
    }

    throw new AdeError(
      "docker_unavailable",
      "Docker is unavailable. Start Docker Engine or enable Docker Desktop WSL integration, then start the computer again.",
    );
  };

  private command = async (args: string[], options: Partial<ProcessRequest> = {}) => {
    const result = await execute({
      ...options,
      program: "docker",
      args: ["--host", await this.socket(), ...args],
      cwd: this.engine.root,
      signal: ["stop", "ps"].includes(args[0])
        ? options.signal
        : options.signal
          ? AbortSignal.any([options.signal, this.controller.signal])
          : this.controller.signal,
    });

    if (result.code !== 0) {
      throw new AdeError("docker", `Docker operation failed: ${result.stderr || result.stdout}`);
    }

    return result.stdout.trim();
  };

  private inspect = async (profile: string): Promise<Inspection | null> => {
    const result = await execute({
      program: "docker",
      args: ["--host", await this.socket(), "container", "inspect", this.names(profile).container],
      cwd: this.engine.root,
      signal: this.controller.signal.aborted ? undefined : this.controller.signal,
    });

    if (result.code !== 0) {
      if (/No such (object|container)/i.test(result.stderr)) {
        return null;
      }

      throw new AdeError("docker", `Cannot inspect computer: ${result.stderr || result.stdout}`);
    }

    const value: Inspection = JSON.parse(result.stdout)[0];
    if (
      value.Config.Labels["dev.vibestar.owner"] !== this.owner ||
      value.Config.Labels["dev.vibestar.profile"] !== profile
    ) {
      throw new AdeError("ownership", "This Docker container is not owned by this Viber.");
    }

    return value;
  };

  private publish = (
    profile_id: string,
    status: ComputerStatus["status"],
    session_id: string | null = null,
    error: string | null = null,
  ) => {
    const next: ComputerStatus = { profile_id, status, session_id, error };
    this.states.set(profile_id, next);
    this.engine.publish({ event: "computer.changed", data: next });
    return next;
  };

  private image = () => `vibestar-computer:${this.owner}`;

  private ensureImage = async () => {
    if (this.imageReady) {
      return this.imageReady;
    }

    this.imageReady = (async () => {
      const uid = process.getuid?.() ?? 1000;
      const gid = process.getgid?.() ?? 1000;
      if (uid === 0 || gid === 0) {
        throw new AdeError("isolation", "Viber computers require an unprivileged Linux/WSL core.");
      }

      const type = await this.command(["info", "--format", "{{.OSType}}"]);
      if (type !== "linux") {
        throw new AdeError("docker", "Select a Linux Docker engine.");
      }

      await this.command(["build", "--tag", this.image(), "-"], {
        input: computerImage(uid, gid),
        timeoutMs: 600000,
      });
    })().catch((error) => {
      this.imageReady = undefined;
      throw error;
    });

    return this.imageReady;
  };

  private resource = async (profile: string, kind: "volume" | "network") => {
    const name = this.names(profile)[kind];

    const inspected = await execute({
      program: "docker",
      args: ["--host", await this.socket(), kind, "inspect", name],
      cwd: this.engine.root,
      signal: this.controller.signal,
    });

    if (inspected.code === 0) {
      const value = JSON.parse(inspected.stdout)[0];
      if (
        value.Labels["dev.vibestar.owner"] !== this.owner ||
        value.Labels["dev.vibestar.profile"] !== profile
      ) {
        throw new AdeError("ownership", `This ${kind} is not owned by this Viber.`);
      }

      return true;
    }

    if (!/No such (volume|network)/i.test(inspected.stderr)) {
      throw new AdeError("docker", `Cannot inspect computer ${kind}: ${inspected.stderr}`);
    }

    return false;
  };

  ensure = async (scope: Scope, cwd?: string, readonly = false) => {
    this.authorize(scope);
    return this.track(async () => {
      const current = await this.inspect(scope.profile_id);
      if (current?.State.Running) {
        return;
      }

      await this.ensureImage();
      const names = this.names(scope.profile_id);

      for (const kind of ["volume", "network"] as const) {
        if (!(await this.resource(scope.profile_id, kind))) {
          await this.command([
            kind,
            "create",
            "--label",
            `dev.vibestar.owner=${this.owner}`,
            "--label",
            `dev.vibestar.profile=${scope.profile_id}`,
            ...(kind === "network"
              ? ["--driver", "bridge", "--opt", "com.docker.network.bridge.enable_icc=false"]
              : []),
            names[kind],
          ]);
        }
      }

      if (cwd?.includes(",")) {
        throw new AdeError("isolation", "Directory paths cannot contain commas.");
      }

      if (!current) {
        const uid = process.getuid?.() ?? 1000;
        const gid = process.getgid?.() ?? 1000;

        await this.command([
          "create",
          "--name",
          names.container,
          "--label",
          `dev.vibestar.owner=${this.owner}`,
          "--label",
          `dev.vibestar.profile=${scope.profile_id}`,
          "--network",
          names.network,
          "--user",
          `${uid}:${gid}`,
          "--security-opt",
          "no-new-privileges=true",
          "--cap-drop",
          "ALL",
          "--mount",
          `type=volume,source=${names.volume},target=/home/viber`,
          ...(cwd
            ? [
                "--mount",
                `type=bind,source=${cwd},target=/home/viber/workspace${readonly ? ",readonly" : ""}`,
              ]
            : []),
          this.image(),
        ]);
      }

      await this.command(["start", names.container]);

      this.engine.db.run(
        "INSERT OR IGNORE INTO dedicated_viber_computers(profile_id) VALUES(?)",
        scope.profile_id,
      );
    });
  };

  acquire = (scope: Scope, kind: Lease["kind"], stop: () => Promise<void> | void) => {
    this.authorize(scope);
    this.engine.assertAvailable();
    if (this.leases.has(scope.profile_id)) {
      throw new AdeError(
        "busy",
        "This Viber computer is in use. Finish the current turn or close its terminal first.",
      );
    }

    const releaseActivity = this.engine.trackActivity(
      {
        id: `computer:${scope.profile_id}`,
        kind: kind === "terminal" ? "terminal" : "viber",
        label: "Viber computer is in use",
        stoppable: kind !== "control",
      },
      () => Promise.resolve(stop()),
    );

    const lease: Lease = {
      scope,
      kind,
      release: () => {
        if (this.leases.get(scope.profile_id) === lease) {
          this.leases.delete(scope.profile_id);
          releaseActivity();
        }
      },
    };

    this.leases.set(scope.profile_id, lease);
    return lease.release;
  };

  status = async (scope: Scope): Promise<ComputerStatus> => {
    this.authorize(scope);
    const state = this.states.get(scope.profile_id);
    if (state?.status === "starting" || state?.status === "error") {
      return state;
    }

    if (
      !this.engine.db.all(
        "SELECT profile_id FROM dedicated_viber_computers WHERE profile_id=?",
        scope.profile_id,
      ).length
    ) {
      return this.publish(scope.profile_id, "stopped");
    }

    try {
      const container = await this.inspect(scope.profile_id);
      const lease = this.leases.get(scope.profile_id);
      return this.publish(
        scope.profile_id,
        container?.State.Running
          ? lease && lease.kind !== "control"
            ? "running"
            : "ready"
          : "stopped",
        container?.Config.Labels["dev.vibestar.session"] || null,
      );
    } catch (error) {
      return this.publish(scope.profile_id, "error", null, redact(String(error)));
    }
  };

  control = async (
    scope: Scope,
    action: "start" | "stop" | "restart" | "reset",
    confirmed = false,
    prepare?: () => Promise<string>,
  ) => {
    this.authorize(scope);

    if (action !== "start" && !confirmed) {
      throw new AdeError("confirmation_required", "Confirm this computer action.");
    }

    const lease = this.leases.get(scope.profile_id);
    if (lease && lease.kind !== "control") {
      throw new AdeError("busy", "Stop the Viber turn before controlling its computer.");
    }

    this.publish(scope.profile_id, "starting", scope.session_id || null);

    try {
      if (action === "reset") {
        await this.closeTerminal(scope);
        await this.remove(scope);
        return this.publish(scope.profile_id, "stopped", scope.session_id || null);
      }

      if (["stop", "restart"].includes(action)) {
        await this.closeTerminal(scope);
        await this.stopContainer(scope.profile_id);
        if (action === "stop") {
          return this.publish(scope.profile_id, "stopped", scope.session_id || null);
        }
      }

      await this.ensure(scope, await prepare?.());
      return this.publish(scope.profile_id, "ready", scope.session_id || null);
    } catch (error) {
      this.publish(scope.profile_id, "error", scope.session_id || null, redact(String(error)));
      throw error;
    }
  };

  private stopContainer = async (profile: string) => {
    const inspected = await this.inspect(profile);
    if (inspected?.State.Running) {
      await this.command(["stop", "--time", "2", this.names(profile).container]);
    }
  };

  remove = async (scope: Scope) => {
    this.authorize(scope);
    if (this.leases.has(scope.profile_id)) {
      throw new AdeError("busy", "Stop the Viber before removing its computer.");
    }

    await this.closeTerminal(scope);
    const names = this.names(scope.profile_id);

    try {
      await this.stopContainer(scope.profile_id);
      await this.command(["rm", "--force", names.container]).catch(() => null);

      for (const kind of ["volume", "network"] as const) {
        if (await this.resource(scope.profile_id, kind)) {
          await this.command([kind, "rm", "--force", names[kind]]).catch(() => null);
        }
      }
    } finally {
      this.engine.db.run(
        "DELETE FROM dedicated_viber_computers WHERE profile_id=?",
        scope.profile_id,
      );

      this.states.delete(scope.profile_id);
    }
  };

  providers = async (scope: Scope) => {
    this.authorize(scope);
    await this.ensure(scope);
    return Promise.all([
      new CodexProvider().detect(this.engine.root),
      new AntigravityProvider().detect(this.engine.root),
    ]);
  };

  transform = async (scope: Scope): Promise<ProcessTransform> => {
    await this.socket();
    const name = this.names(scope.profile_id).container;

    return (request) => ({
      ...request,
      program: "docker",
      args: [
        "--host",
        "unix:///var/run/docker.sock",
        "exec",
        "-i",
        name,
        request.program,
        ...request.args,
      ],
      cwd: request.cwd ?? this.engine.root,
    });
  };

  terminalStatus = (scope: Scope): ComputerTerminal | null => {
    this.authorize(scope);
    return this.terminals.get(scope.profile_id)?.snapshot || null;
  };

  finish = async (profileId: string) => {
    if (
      !this.engine.db.all(
        "SELECT profile_id FROM dedicated_viber_computers WHERE profile_id=?",
        profileId,
      ).length
    ) {
      return;
    }

    const container = await this.inspect(profileId);
    if (container?.State.Running) {
      await this.command(["stop", "--time", "2", container.Id]);
    }

    this.publish(profileId, "stopped", container?.Config.Labels["dev.vibestar.session"] || null);
  };

  openTerminal = async (
    scope: Scope,
    prepare?: () => Promise<string>,
    login?: "codex" | "antigravity",
    confirmed = false,
  ) => {
    this.authorize(scope);
    if (login && !confirmed) {
      throw new AdeError("confirmation_required", "Confirm signing in with this Viber.");
    }

    const existing = this.terminals.get(scope.profile_id);
    if (existing) {
      if (login && existing.snapshot.login !== login) {
        throw new AdeError(
          "busy",
          "Close the open terminal before starting another provider login.",
        );
      }

      return existing.snapshot;
    }

    const release = this.acquire(scope, "terminal", () => this.closeTerminal(scope));
    try {
      await this.ensure(scope, await prepare?.());
      const transform = await this.transform(scope);

      const command = transform(
        login === "codex"
          ? { program: "codex", args: ["login", "--device-auth"] }
          : login === "antigravity"
            ? { program: "agy", args: [] }
            : { program: "/bin/bash", args: ["--noprofile", "-i"] },
      );

      const execIndex = command.args.indexOf("exec");
      command.args.splice(execIndex + 1, 0, "-t");

      this.controller.signal.throwIfAborted();

      const pty = spawn(command.program, command.args, {
        cwd: this.engine.root,
        env: cleanEnvironment() as Record<string, string>,
        name: "xterm-256color",
        cols: 100,
        rows: 28,
      });

      const snapshot: ComputerTerminal = {
        id: randomUUID(),
        output: "",
        sequence: 0,
        login: login || null,
        session_id: scope.session_id || null,
      };

      const redactor = new StreamRedactor();
      const budget = new OutputBudget(8 * 1024 * 1024);
      let resolveExit: () => void;

      const exited = new Promise<void>((resolve) => {
        resolveExit = resolve;
      });

      this.terminals.set(scope.profile_id, {
        pty,
        snapshot,
        lease: this.leases.get(scope.profile_id)!,
        exited,
      });

      const publish = (text: string) => {
        if (!text) {
          return;
        }

        snapshot.output = (snapshot.output + text).slice(-65536);
        snapshot.sequence++;

        this.engine.publish({
          event: "computer.terminal.output",
          session_id: snapshot.id,
          text,
          data: { profile_id: scope.profile_id, sequence: snapshot.sequence },
        });
      };

      pty.onData((text) => {
        try {
          budget.consume(text);
          publish(redactor.push(text));
        } catch {
          publish("\r\nTerminal output limit reached. Reopen the terminal.\r\n");
          void this.closeTerminal(scope);
        }
      });

      pty.onExit(() => {
        publish(redactor.finish());

        void this.finish(scope.profile_id)
          .catch((error) =>
            this.publish(
              scope.profile_id,
              "error",
              scope.session_id || null,
              redact(String(error)),
            ),
          )
          .finally(() => {
            this.terminals.delete(scope.profile_id);
            release();

            this.engine.publish({
              event: "computer.terminal.closed",
              session_id: snapshot.id,
              data: { profile_id: scope.profile_id },
            });

            resolveExit();
          });
      });

      return snapshot;
    } catch (error) {
      release();
      throw error;
    }
  };

  terminalInput = (scope: Scope, id: string, text: string) => {
    const terminal = this.terminal(scope, id);
    terminal.pty.write(text);
  };

  terminalResize = (scope: Scope, id: string, cols: number, rows: number) =>
    this.terminal(scope, id).pty.resize(cols, rows);

  private terminal = (scope: Scope, id: string) => {
    this.authorize(scope);
    const terminal = this.terminals.get(scope.profile_id);
    if (!terminal || terminal.snapshot.id !== id) {
      throw new AdeError("ownership", "Terminal does not belong to this Viber.");
    }

    return terminal;
  };

  closeTerminal = async (scope: Scope) => {
    this.authorize(scope);
    const terminal = this.terminals.get(scope.profile_id);
    if (terminal) {
      await this.finish(scope.profile_id);
      terminal.pty.kill();
      await terminal.exited;
    }
  };

  recover = async () => {
    if (!this.engine.db.all("SELECT profile_id FROM dedicated_viber_computers").length) {
      return;
    }

    try {
      const ids = await this.command([
        "ps",
        "-aq",
        "--filter",
        `label=dev.vibestar.owner=${this.owner}`,
      ]);

      for (const id of ids.split(/\s+/).filter(Boolean)) {
        await this.command(["stop", "--time", "2", id]);
      }
    } catch (error) {
      // Docker is optional at app startup; explicit computer operations report the failure.
      this.engine.publish({ event: "computer.unavailable", text: redact(String(error)) });
    }
  };

  close = async () => {
    this.beginShutdown();
    await Promise.allSettled([...this.pending]);
    for (const profile of this.terminals.keys()) {
      await this.closeTerminal({ profile_id: profile });
    }

    await this.recover();
    this.closed = true;
    this.controller.abort();
  };
}
