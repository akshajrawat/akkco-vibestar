import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { spawn, type IPty } from "node-pty";

import { AdeError } from "../domain";
import type { Engine } from "../execution/engine";
import {
  execute,
  cleanEnvironment,
  redact,
  type ProcessRequest,
  type ProcessTransform,
} from "../execution/runtime/process";
import { StreamRedactor } from "../execution/output/stream-redactor";
import { OutputBudget } from "../execution/output/bounded-output";
import { CodexProvider } from "../execution/providers/codex";
import { AntigravityProvider } from "../execution/providers/antigravity";
import { ViberSessionStore } from "../vibers/store";
import type { ComputerStatus, ComputerTerminal } from "./contracts";
import { computerImage } from "./image";

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
    profile: string,
    status: ComputerStatus["status"],
    session: string | null = null,
    error: string | null = null,
  ) => {
    const value: ComputerStatus = { profile_id: profile, status, session_id: session, error };
    this.states.set(profile, value);
    this.engine.publish({ event: "computer.changed", data: value });
    return value;
  };

  status = async (scope: Scope) => {
    this.authorize(scope);
    const state = this.states.get(scope.profile_id);
    if (state?.status === "starting" || state?.status === "error") {
      return state;
    }

    if (
      !this.engine.db.all(
        "SELECT profile_id FROM viber_computers WHERE profile_id=?",
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

  acquire = (scope: Scope, kind: Lease["kind"], stop: () => Promise<void>) => {
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
      stop,
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

  private ensureImage = () =>
    (this.imageReady ??= (async () => {
      const uid = process.getuid?.();
      const gid = process.getgid?.();
      if (!uid || gid === undefined) {
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
    }));

  private image = () => `vibestar-computer:1-${process.getuid?.()}-${process.getgid?.()}`;

  private resource = async (profile: string, kind: "volume" | "network") => {
    const name = this.names(profile)[kind];

    const inspected = await execute({
      program: "docker",
      args: ["--host", await this.socket(), kind, "inspect", name],
      cwd: this.engine.root,
      signal: this.controller.signal,
    });

    if (inspected.code === 0) {
      const labels = JSON.parse(inspected.stdout)[0].Labels;
      if (
        labels?.["dev.vibestar.owner"] !== this.owner ||
        labels?.["dev.vibestar.profile"] !== profile
      ) {
        throw new AdeError("ownership", `The computer ${kind} has another owner.`);
      }

      return true;
    }

    if (!/No such (volume|network)/i.test(inspected.stderr)) {
      throw new AdeError("docker", `Cannot inspect computer ${kind}: ${inspected.stderr}`);
    }

    return false;
  };

  ensure = async (scope: Scope, cwd?: string, readOnly = false, signal?: AbortSignal) => {
    this.authorize(scope);
    const lease = this.leases.get(scope.profile_id);
    if (!lease || lease.scope.session_id !== scope.session_id) {
      throw new AdeError("isolation", "Computer access requires its current session lease.");
    }

    if (scope.session_id) {
      const assignment = new ViberSessionStore(this.engine.db).workspace(scope.session_id);
      if (cwd !== (await this.engine.git.assertOwnedTask(assignment))) {
        throw new AdeError("ownership", "Computer workspace does not match its session.");
      }
    } else if (cwd) {
      throw new AdeError("isolation", "A workspace requires an owned session.");
    }

    this.publish(scope.profile_id, "starting", scope.session_id || null);
    try {
      await this.ensureImage();
      this.controller.signal.throwIfAborted();
      signal?.throwIfAborted();

      this.engine.db.run(
        "INSERT OR IGNORE INTO viber_computers(profile_id) VALUES(?)",
        scope.profile_id,
      );

      const names = this.names(scope.profile_id);
      let container = await this.inspect(scope.profile_id);
      if (
        container &&
        (container.Config.Labels["dev.vibestar.workspace"] !== (cwd || "") ||
          container.Config.Labels["dev.vibestar.readonly"] !== String(readOnly))
      ) {
        await this.command(["rm", "--force", container.Id]);
        container = null;
      }

      if (container?.State.Running) {
        await this.command(["stop", "--time", "2", container.Id]);
      }

      if (!container) {
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
          throw new AdeError("isolation", "Docker workspace paths cannot contain commas.");
        }

        await this.command([
          "create",
          "--name",
          names.container,
          "--label",
          `dev.vibestar.owner=${this.owner}`,
          "--label",
          `dev.vibestar.profile=${scope.profile_id}`,
          "--label",
          `dev.vibestar.session=${scope.session_id || ""}`,
          "--label",
          `dev.vibestar.workspace=${cwd || ""}`,
          "--label",
          `dev.vibestar.readonly=${readOnly}`,
          "--user",
          `${process.getuid?.()}:${process.getgid?.()}`,
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges=true",
          "--read-only",
          "--cpus",
          "2",
          "--memory",
          "2g",
          "--memory-swap",
          "2g",
          "--pids-limit",
          "256",
          "--ulimit",
          "nofile=4096:4096",
          "--restart",
          "no",
          "--log-driver",
          "none",
          "--network",
          names.network,
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,size=512m,mode=1777",
          "--mount",
          `type=volume,src=${names.volume},dst=/home/viber`,
          ...(cwd
            ? [
                "--mount",
                `type=bind,src=${cwd},dst=${cwd},bind-recursive=disabled${readOnly ? ",readonly" : ""}`,
                "--workdir",
                cwd,
              ]
            : []),
          ...(cwd && new ViberSessionStore(this.engine.db).workspace(scope.session_id!).repo_id
            ? ["--mount", `type=bind,src=${join(cwd, ".git")},dst=${join(cwd, ".git")},readonly`]
            : []),
          this.image(),
        ]);
      }

      await this.command(["start", names.container], { signal });

      this.publish(
        scope.profile_id,
        lease.kind === "control" ? "ready" : "running",
        scope.session_id || null,
      );
    } catch (error) {
      this.publish(scope.profile_id, "error", scope.session_id || null, redact(String(error)));
      throw error;
    }
  };

  transform = async (scope: Scope): Promise<ProcessTransform> => {
    this.authorize(scope);
    const lease = this.leases.get(scope.profile_id);
    const container = await this.inspect(scope.profile_id);
    if (
      !lease ||
      lease.scope.session_id !== scope.session_id ||
      !container?.State.Running ||
      container.Config.Labels["dev.vibestar.session"] !== (scope.session_id || "")
    ) {
      throw new AdeError("isolation", "Computer invocation requires its running, leased session.");
    }

    const socket = await this.socket();
    return (invocation) => ({
      program: "docker",
      args: [
        "--host",
        socket,
        "exec",
        "-i",
        "--workdir",
        container.Config.Labels["dev.vibestar.workspace"] || "/home/viber",
        container.Id,
        invocation.program,
        ...invocation.args,
      ],
    });
  };

  finish = async (profile: string) => {
    if (
      !this.engine.db.all("SELECT profile_id FROM viber_computers WHERE profile_id=?", profile)
        .length
    ) {
      return;
    }

    const container = await this.inspect(profile);
    if (container?.State.Running) {
      await this.command(["stop", "--time", "2", container.Id]);
    }

    this.publish(profile, "stopped", container?.Config.Labels["dev.vibestar.session"] || null);
  };

  control = (...args: Parameters<Computers["controlComputer"]>) =>
    this.track(() => this.controlComputer(...args));

  private controlComputer = async (
    scope: Scope,
    action: "start" | "stop" | "restart" | "reset",
    confirmed?: boolean,
    prepare?: () => Promise<string>,
  ) => {
    this.authorize(scope);
    if (action !== "start" && !confirmed) {
      throw new AdeError(
        "confirmation",
        "Confirm stopping the computer or deleting its home and installed dependencies.",
      );
    }

    if (this.leases.get(scope.profile_id)?.kind === "agent") {
      throw new AdeError("busy", "Stop the Viber turn before changing its computer.");
    }

    await this.closeTerminal(scope);
    const release = this.acquire(scope, "control", async () => {});
    try {
      if (action !== "start") {
        await this.finish(scope.profile_id);
      }

      if (action === "reset") {
        await this.removeResources(scope.profile_id);

        this.engine.db.run(
          "UPDATE viber_sessions SET thread=NULL WHERE profile_id=?",
          scope.profile_id,
        );
      } else if (action === "start" || action === "restart") {
        await this.ensure(scope, await prepare?.());
      }

      return await this.status(scope);
    } catch (error) {
      this.publish(scope.profile_id, "error", scope.session_id || null, redact(String(error)));
      throw error;
    } finally {
      release();
    }
  };

  private removeResources = async (profile: string) => {
    if (
      !this.engine.db.all("SELECT profile_id FROM viber_computers WHERE profile_id=?", profile)
        .length
    ) {
      return;
    }

    const container = await this.inspect(profile);
    if (container) {
      await this.command(["rm", "--force", container.Id]);
    }

    for (const kind of ["volume", "network"] as const) {
      if (await this.resource(profile, kind)) {
        await this.command([kind, "rm", this.names(profile)[kind]]);
      }
    }
  };

  remove = async (scope: Scope) => {
    this.authorize(scope);
    if (this.leases.has(scope.profile_id)) {
      throw new AdeError("busy", "Stop the Viber and close its terminal before deleting it.");
    }

    await this.removeResources(scope.profile_id);
    this.engine.db.run("DELETE FROM viber_computers WHERE profile_id=?", scope.profile_id);
    this.states.delete(scope.profile_id);
  };

  providers = (scope: Scope) => this.track(() => this.detectProviders(scope));

  private detectProviders = async (scope: Scope) => {
    const release = this.acquire(scope, "control", async () => {});
    try {
      const container = await this.inspect(scope.profile_id);

      const activeScope = {
        ...scope,
        session_id: container?.Config.Labels["dev.vibestar.session"] || undefined,
      };

      const lease = this.leases.get(scope.profile_id)!;
      lease.scope = activeScope;
      const transform = await this.transform(activeScope);

      const providers = await Promise.all([
        new CodexProvider(transform).detect(this.engine.root),
        new AntigravityProvider(transform).detect(this.engine.root),
      ]);

      this.engine.publish({
        event: "computer.providers",
        data: { profile_id: scope.profile_id, providers },
      });

      return providers;
    } finally {
      release();
    }
  };

  terminalStatus = (scope: Scope) => {
    this.authorize(scope);
    return this.terminals.get(scope.profile_id)?.snapshot || null;
  };

  openTerminal = (...args: Parameters<Computers["startTerminal"]>) =>
    this.track(() => this.startTerminal(...args));

  private startTerminal = async (
    scope: Scope,
    prepare?: () => Promise<string>,
    login?: "codex" | "antigravity",
    confirmed?: boolean,
  ) => {
    this.authorize(scope);
    if (login && !confirmed) {
      throw new AdeError(
        "confirmation",
        "Confirm signing into this Viber's private computer. Host credentials are never copied.",
      );
    }

    const existing = this.terminals.get(scope.profile_id);
    if (existing) {
      if (
        existing.snapshot.session_id !== (scope.session_id || null) ||
        existing.snapshot.login !== (login || null)
      ) {
        throw new AdeError("busy", "Close the existing computer terminal first.");
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
    if (!this.engine.db.all("SELECT profile_id FROM viber_computers").length) {
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
