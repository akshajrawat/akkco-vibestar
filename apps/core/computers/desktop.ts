import type { z } from "zod";
import { AdeError } from "../domain";
import type { ComputerDocker } from "./docker";
import type { DesktopInputSchema } from "./contracts";

type Control = { key: string; socket: string; id: string; expires: number };

export class ComputerDesktop {
  private controller?: Control;

  private acquiring = false;

  private generation = 0;

  private frameRequest?: Promise<string>;

  private inputRequest?: Promise<string>;

  private releasing?: Promise<void>;

  private readonly held = new Set<number>();

  constructor(
    private readonly docker: ComputerDocker,
    private readonly running: () => Promise<{ socket: string; id: string }>,
  ) {}

  acquire = async (key: string) => {
    if (this.acquiring || (this.controller && this.controller.expires > Date.now())) {
      if (this.controller?.key === key) {
        return;
      }

      throw new AdeError("desktop_busy", "Another window is controlling Shared Computer.");
    }

    this.acquiring = true;
    const generation = this.generation;
    try {
      const release = this.controller ? this.close(this.controller.key) : this.releasing;
      await release?.catch(() => undefined);
      const target = await this.running();
      if (generation !== this.generation) {
        throw new AdeError("desktop_disconnected", "Reconnect to the Shared Computer desktop.");
      }

      this.controller = { ...target, key, expires: Date.now() + 15000 };
    } finally {
      this.acquiring = false;
    }
  };

  private owns = (key: string) => {
    if (this.controller?.key !== key || this.controller.expires <= Date.now()) {
      throw new AdeError("desktop_disconnected", "Reconnect to the Shared Computer desktop.");
    }

    this.controller.expires = Date.now() + 15000;
    return this.controller;
  };

  frame = (key: string) => {
    const { socket, id } = this.owns(key);
    if (this.frameRequest) {
      return this.frameRequest;
    }

    this.frameRequest = this.docker
      .command(
        socket,
        [
          "exec",
          id,
          "bash",
          "-o",
          "pipefail",
          "-c",
          "scrot -z -o -F /tmp/vibestar-frame.jpg && base64 -w0 /tmp/vibestar-frame.jpg",
        ],
        { rawStdoutForIntegrity: true, timeoutMs: 5000 },
      )
      .then((value) => {
        if (value.length > 1_000_000 || !/^\/9j\/[A-Za-z0-9+/]+={0,2}$/.test(value)) {
          throw new AdeError("desktop_frame", "The computer returned an invalid desktop frame.");
        }

        return value;
      })
      .finally(() => {
        this.frameRequest = undefined;
      });

    return this.frameRequest;
  };

  input = async (key: string, action: z.output<typeof DesktopInputSchema>) => {
    const { socket, id } = this.owns(key);
    if (this.inputRequest) {
      throw new AdeError("desktop_busy", "Wait for the pending desktop input.");
    }

    let args: string[];
    if (action.type === "text") {
      args = ["type", "--clearmodifiers", "--delay", "0", "--", action.text];
    } else if (action.type === "key") {
      args = ["key", "--clearmodifiers", action.keys];
    } else {
      args = ["mousemove", String(action.x), String(action.y)];
      if (action.phase !== "move") {
        args.push(
          { down: "mousedown", up: "mouseup", click: "click" }[action.phase],
          String(action.button),
        );
      }
    }

    if (action.type === "pointer" && action.phase === "down") {
      this.held.add(action.button);
    }

    this.inputRequest = this.docker.command(socket, ["exec", id, "xdotool", ...args], {
      timeoutMs: 4000,
    });

    try {
      await this.inputRequest;
      if (action.type === "pointer" && action.phase === "up") {
        this.held.delete(action.button);
      }
    } finally {
      this.inputRequest = undefined;
    }
  };

  close = (key?: string): Promise<void> => {
    if (!key) {
      this.generation++;
    }

    const target = this.controller;
    if (!target || (key && target.key !== key)) {
      return this.releasing ?? Promise.resolve();
    }

    this.controller = undefined;

    this.releasing = this.release(target).finally(() => {
      this.releasing = undefined;
    });

    return this.releasing;
  };

  private release = async (target: Control) => {
    await Promise.allSettled([this.inputRequest, this.frameRequest]);
    if (this.held.size) {
      const args = [...this.held].flatMap((button) => ["mouseup", String(button)]);
      this.held.clear();

      await this.docker.command(target.socket, ["exec", target.id, "xdotool", ...args], {
        timeoutMs: 4000,
      });
    }
  };
}
