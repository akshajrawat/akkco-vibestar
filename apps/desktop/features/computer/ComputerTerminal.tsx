import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import type { ComputerTerminal as Snapshot } from "../../../core/computers/contracts";
import { computerRpc, subscribe, errorMessage } from "../../lib/api";

export const ComputerTerminal = ({ report }: { report: (message: string) => void }) => {
  const surface = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = surface.current!;
    const terminal = new Terminal({ fontFamily: "monospace", fontSize: 12, scrollback: 1000 });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    let active = true;
    let generation = 0;
    let loading = false;
    let snapshot: Snapshot | null = null;
    let pending: { id: string; sequence: number; text: string }[] = [];

    const fail = (error: unknown) => {
      if (active) {
        report(errorMessage(error));
      }
    };

    const resize = () => {
      fit.fit();
      if (snapshot) {
        void computerRpc("computer.terminal.resize", {
          terminal_id: snapshot.id,
          cols: Math.max(10, Math.min(500, terminal.cols)),
          rows: Math.max(4, Math.min(200, terminal.rows)),
        }).catch(fail);
      }
    };

    const append = (event: (typeof pending)[number]) => {
      if (snapshot?.id === event.id && snapshot.sequence < event.sequence) {
        terminal.write(event.text);
        snapshot.sequence = event.sequence;
      }
    };

    const load = async () => {
      if (loading || !active) {
        return;
      }

      loading = true;
      const requested = generation;
      try {
        const next = await computerRpc("computer.terminal.status", {});
        if (active && requested === generation) {
          snapshot = next;
          terminal.reset();
          if (next) {
            terminal.write(next.output);
          }

          pending.forEach(append);
          pending = [];
          resize();
        }
      } finally {
        loading = false;
        if (requested !== generation) {
          void load().catch(fail);
        }
      }
    };

    const subscription = subscribe((event) => {
      if (!active) {
        return;
      }

      if (event.event === "computer.terminal.output" && event.session_id) {
        const output = {
          id: event.session_id,
          sequence: (event.data as { sequence: number }).sequence,
          text: event.text || "",
        };

        if (!loading && snapshot?.id === output.id) {
          append(output);
        } else {
          pending.push(output);
          if (pending.length > 1000) {
            pending.shift();
          }

          void load().catch(fail);
        }
      } else if (
        event.event === "computer.terminal.opened" ||
        event.event === "computer.terminal.closed"
      ) {
        generation++;
        void load().catch(fail);
      } else if (event.event === "runtime.status") {
        snapshot = null;
        generation++;
        if ((event.data as { phase?: string })?.phase === "ready") {
          void load().catch(fail);
        }
      }
    });

    void subscription.then(load).catch(fail);

    const input = terminal.onData((text) => {
      const id = snapshot?.id;
      if (id) {
        for (let offset = 0; offset < text.length; offset += 8192) {
          void computerRpc("computer.terminal.input", {
            terminal_id: id,
            text: text.slice(offset, offset + 8192),
          }).catch(fail);
        }
      }
    });

    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => {
      active = false;
      void subscription.then((unsubscribe) => unsubscribe()).catch(() => undefined);
      observer.disconnect();
      input.dispose();
      terminal.dispose();
    };
  }, [report]);

  return (
    <div
      className="min-h-[220px] flex-1 overflow-hidden rounded-xl bg-[#0b1220] p-2 [&_.xterm]:h-full"
      aria-label="Computer terminal"
      ref={surface}
    />
  );
};
