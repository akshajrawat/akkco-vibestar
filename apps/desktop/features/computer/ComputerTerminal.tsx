import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import type { ComputerTerminal as Snapshot } from "../../../core/computers/contracts";
import { computerRpc, subscribe, errorMessage } from "../../lib/api";

export const ComputerTerminal = ({
  profileId,
  sessionId,
  active,
  report,
}: {
  profileId: string;
  sessionId?: string;
  active: boolean;
  report: (message: string) => void;
}) => {
  const surface = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>(null);
  const fit = useRef<FitAddon>(null);
  const reportRef = useRef(report);
  reportRef.current = report;

  useEffect(() => {
    let alive = true;
    let snapshot: Snapshot | null = null;
    let loading = false;
    let generation = 0;
    let pending: { id: string; sequence: number; text: string }[] = [];

    const term = new Terminal({
      theme: { background: "#0b1220", foreground: "#d3deef" },
      fontFamily: "var(--font-mono, monospace)",
      fontSize: 12,
      scrollback: 3000,
      convertEol: true,
    });

    const fitter = new FitAddon();
    term.loadAddon(fitter);
    term.open(surface.current!);
    terminal.current = term;
    fit.current = fitter;

    const fail = (error: unknown) => {
      if (alive) {
        reportRef.current(errorMessage(error));
      }
    };

    const append = (event: { id: string; sequence: number; text: string }) => {
      if (snapshot && event.id === snapshot.id && event.sequence > snapshot.sequence) {
        term.write(event.text);
        snapshot.sequence = event.sequence;
      }
    };

    const load = async () => {
      if (loading) {
        return;
      }

      loading = true;
      const request = generation;
      try {
        const next = await computerRpc("computer.terminal.status", { profile_id: profileId });
        if (alive && generation === request) {
          snapshot = next;
          term.reset();
          if (snapshot) {
            term.write(snapshot.output);
          }

          for (const event of pending) {
            append(event);
          }

          pending = [];
        }
      } finally {
        loading = false;
      }
    };

    const subscription = subscribe((event) => {
      if (!alive) {
        return;
      }

      if (event.event === "utility.event" && sessionId && event.session_id === sessionId) {
        const command = event.data as
          { command?: string; stdout?: string; stdout_delta?: string; stderr?: string } | undefined;

        if (event.kind === "command.started" && command?.command) {
          term.write(`\r\n$ ${command.command}\r\n`);
        }

        if (event.kind === "command.output" || event.kind === "command.finished") {
          const output = command?.stdout_delta || command?.stdout || command?.stderr;
          if (output) {
            term.write(output);
          }
        }

        return;
      }

      const data = event.data as { profile_id?: string; sequence?: number } | undefined;
      if (data?.profile_id !== profileId) {
        return;
      }

      if (event.event === "computer.terminal.output") {
        const output = { id: event.session_id!, sequence: data.sequence!, text: event.text || "" };
        if (snapshot?.id === output.id) {
          append(output);
        } else {
          pending.push(output);
          if (pending.length > 1000) {
            pending.shift();
          }

          void load().catch(fail);
        }
      } else if (event.event === "computer.terminal.closed") {
        generation++;
        snapshot = null;
        term.write("\r\n[Terminal closed]\r\n");
      }
    });

    void subscription.then(() => load()).catch(fail);

    const input = term.onData((text) => {
      if (snapshot) {
        void computerRpc("computer.terminal.input", {
          profile_id: profileId,
          terminal_id: snapshot.id,
          text,
        }).catch(fail);
      }
    });

    const observer = new ResizeObserver(() => {
      if (surface.current?.offsetWidth) {
        fitter.fit();
        if (snapshot) {
          void computerRpc("computer.terminal.resize", {
            profile_id: profileId,
            terminal_id: snapshot.id,
            cols: Math.max(10, term.cols),
            rows: Math.max(4, term.rows),
          }).catch(fail);
        }
      }
    });

    observer.observe(surface.current!);
    return () => {
      alive = false;
      void subscription.then((unsubscribe) => unsubscribe());
      observer.disconnect();
      input.dispose();
      term.dispose();
      terminal.current = null;
      fit.current = null;
    };
  }, [profileId, sessionId]);

  useEffect(() => {
    if (active && surface.current?.offsetWidth) {
      fit.current?.fit();
      terminal.current?.focus();
    }
  }, [active]);

  return <div className="computer-terminal" aria-label="Computer terminal" ref={surface} />;
};
