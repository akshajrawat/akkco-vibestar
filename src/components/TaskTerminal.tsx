import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { TerminalSquare, Square, PanelBottom } from "lucide-react";
import { rpc, subscribe, errorMessage } from "../lib/api";
import { Button } from "./ui/button";
import { terminalTheme } from "../lib/theme";
import type { Task } from "../lib/types";
interface TerminalSnapshot {
  session_id: string;
  output: string;
  sequence: number;
}
export const TaskTerminal = ({
  task,
  onError,
  dock,
}: {
  task: Task;
  onError: (error: string) => void;
  dock?: () => void;
}) => {
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const sessionRef = useRef("");
  const replay = useRef<{ text: string; sequence: number }[] | null>(null);
  const [session, setSession] = useState("");
  const [busy, setBusy] = useState(false);
  const attach = useCallback((snapshot: TerminalSnapshot | null) => {
    terminal.current?.clear();
    if (snapshot) {
      sessionRef.current = snapshot.session_id;
      setSession(snapshot.session_id);
      terminal.current?.write(snapshot.output);
      for (const event of replay.current || [])
        if (event.sequence > snapshot.sequence)
          terminal.current?.write(event.text);
    }
    replay.current = null;
  }, []);
  useEffect(() => {
    const term = new Terminal({
      fontSize: 12,
      fontFamily: "Cascadia Code, Consolas, monospace",
      scrollback: 3000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    if (container.current) {
      term.open(container.current);
      fit.fit();
    }
    terminal.current = term;
    let alive = true;
    replay.current = [];
    const sub = subscribe((event) => {
      if (event.task_id !== task.id) return;
      if (event.event === "terminal.output") {
        const sequence =
          (event.data as { sequence: number } | undefined)?.sequence || 0;
        if (replay.current)
          replay.current.push({ text: event.text || "", sequence });
        else if (event.session_id === sessionRef.current)
          term.write(event.text || "");
      }
      if (
        event.event === "terminal.closed" &&
        event.session_id === sessionRef.current
      ) {
        sessionRef.current = "";
        setSession("");
        term.writeln("\r\n[Task terminal exited]");
      }
    });
    void rpc<TerminalSnapshot | null>("terminal.status", { id: task.id })
      .then((snapshot) => {
        if (alive) attach(snapshot);
      })
      .catch((e) => {
        if (alive) onError(errorMessage(e));
      });
    const input = term.onData((text) => {
      if (sessionRef.current)
        void rpc("terminal.input", {
          id: task.id,
          session_id: sessionRef.current,
          text,
        }).catch((e) => onError(errorMessage(e)));
    });
    let lastSize = "";
    const observer = new ResizeObserver(() => {
      if (!container.current?.clientHeight) return;
      fit.fit();
      const size = `${term.cols}/${term.rows}`;
      if (sessionRef.current && size !== lastSize) {
        lastSize = size;
        void rpc("terminal.resize", {
          id: task.id,
          session_id: sessionRef.current,
          cols: Math.max(20, Math.min(500, term.cols)),
          rows: Math.max(4, Math.min(200, term.rows)),
        }).catch((e) => onError(errorMessage(e)));
      }
    });
    if (container.current) observer.observe(container.current);
    return () => {
      alive = false;
      void sub.then((unlisten) => unlisten());
      observer.disconnect();
      input.dispose();
      term.dispose();
      terminal.current = null;
    };
  }, [task.id, onError, attach]);
  const start = async () => {
    setBusy(true);
    replay.current = [];
    try {
      const snapshot = await rpc<TerminalSnapshot>("terminal.open", {
        id: task.id,
        cols: Math.max(20, terminal.current?.cols || 100),
        rows: Math.max(4, terminal.current?.rows || 20),
      });
      attach(snapshot);
      terminal.current?.focus();
    } catch (e) {
      replay.current = null;
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const close = async () => {
    setBusy(true);
    try {
      await rpc("terminal.close", { id: task.id });
      sessionRef.current = "";
      setSession("");
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="task-terminal">
      <header>
        <TerminalSquare size={13} />
        <strong>Terminal</strong>
        <code title={task.worktree_path}>{task.worktree_path}</code>
        <span className="spacer" />
        {dock && (
          <Button size="sm" variant="ghost" onClick={dock}>
            <PanelBottom size={13} />
            Dock
          </Button>
        )}
        {session ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void close()}
          >
            <Square size={12} />
            Close shell
          </Button>
        ) : (
          <Button size="sm" disabled={busy} onClick={() => void start()}>
            Start task terminal
          </Button>
        )}
      </header>
      <div className="terminal-surface" ref={container} />
      <footer>
        {session
          ? "Task worktree · close this shell before running an agent"
          : "Start a shell inside this task's worktree"}
      </footer>
    </section>
  );
};
