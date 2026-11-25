import { randomUUID } from "node:crypto";
import { spawn, type IPty } from "node-pty";

import { AdeError } from "../domain";
import type { Engine } from "../execution/engine";
import { cleanEnvironment } from "../execution/runtime/process";
import { StreamRedactor } from "../execution/output/stream-redactor";
import { OutputBudget } from "../execution/output/bounded-output";
import type { ComputerDocker } from "./docker";
import type { ComputerTerminal } from "./contracts";

export class ComputerTerminalSession {
  private current?: { pty: IPty; snapshot: ComputerTerminal; exited: Promise<void> };

  private opening?: Promise<ComputerTerminal>;

  constructor(
    private readonly engine: Pick<Engine, "root" | "publish">,
    private readonly docker: ComputerDocker,
    private readonly running: () => Promise<{ socket: string; id: string }>,
  ) {}

  status = () => this.current?.snapshot ?? null;

  open = () =>
    (this.opening ??= this.start().finally(() => {
      this.opening = undefined;
    }));

  private start = async () => {
    if (this.current) {
      return this.current.snapshot;
    }

    const { socket, id } = await this.running();

    const pty = spawn(
      "docker",
      this.docker.args(socket, ["exec", "-it", "-e", "TERM=xterm-256color", id, "/bin/bash", "-i"]),
      {
        cwd: this.engine.root,
        env: cleanEnvironment() as Record<string, string>,
        name: "xterm-256color",
        cols: 100,
        rows: 28,
      },
    );

    const snapshot: ComputerTerminal = { id: randomUUID(), output: "", sequence: 0 };
    const budget = new OutputBudget(8 * 1024 * 1024);
    const redactor = new StreamRedactor();

    const publish = (text: string) => {
      if (text) {
        snapshot.output = (snapshot.output + text).slice(-65536);

        this.engine.publish({
          event: "computer.terminal.output",
          session_id: snapshot.id,
          text,
          data: { sequence: ++snapshot.sequence },
        });
      }
    };

    const exited = new Promise<void>((resolve) => {
      pty.onExit(() => {
        publish(redactor.finish());
        this.current = undefined;
        this.engine.publish({ event: "computer.terminal.closed", session_id: snapshot.id });
        resolve();
      });
    });

    this.current = { pty, snapshot, exited };
    this.engine.publish({ event: "computer.terminal.opened", session_id: snapshot.id });

    let limited = false;

    pty.onData((text) => {
      if (limited) {
        return;
      }

      try {
        budget.consume(text);
        publish(redactor.push(text));
      } catch {
        limited = true;
        publish("\r\nTerminal output limit reached. Open a new shell.\r\n");

        void this.close(snapshot.id).catch(() => {
          this.engine.publish({ event: "computer.terminal.closed", session_id: snapshot.id });
        });
      }
    });

    return snapshot;
  };

  private terminal = (id: string) => {
    if (this.current?.snapshot.id !== id) {
      throw new AdeError("terminal_closed", "This Shared Computer shell has closed.");
    }

    return this.current;
  };

  input = (id: string, text: string) => this.terminal(id).pty.write(text);

  resize = (id: string, cols: number, rows: number) => this.terminal(id).pty.resize(cols, rows);

  close = async (id?: string) => {
    await this.opening?.catch(() => undefined);
    const terminal = this.current;
    if (terminal && (!id || terminal.snapshot.id === id)) {
      try {
        terminal.pty.kill("SIGKILL");
      } finally {
        await terminal.exited;
      }
    }
  };
}
