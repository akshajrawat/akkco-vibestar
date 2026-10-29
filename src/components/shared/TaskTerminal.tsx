import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { TerminalSquare, Trash2, Plus, PanelBottom } from "lucide-react";

import type { TaskTerminalSnapshot } from "../../../backend/execution/terminals/task-terminals";
import { rpc, subscribe, errorMessage } from "../../lib/api";
import { Button } from "../ui/button";
import { terminalTheme } from "../../lib/theme";
import type { Task } from "../../lib/types";

export const TaskTerminal = ({
  task,
  onError,
  dock,
  owner = "task",
  active = true,
  focusRequest = 0,
}: {
  task: Pick<Task, "id" | "worktree_path">;
  owner?: "task" | "repair";
  onError: (error: string) => void;
  dock?: () => void;
  active?: boolean;
  focusRequest?: number;
}) => {
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fitter = useRef<FitAddon | null>(null);
  const sessionRef = useRef("");
  const opening = useRef<Terminal | null>(null);
  const activeRef = useRef(active);
  const errorRef = useRef(onError);
  activeRef.current = active;
  errorRef.current = onError;
  const replay = useRef<{ text: string; sequence: number; session_id?: string }[] | null>(null);
  const [snapshot, setSnapshot] = useState<TaskTerminalSnapshot | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const prefix = owner === "repair" ? "repair.terminal" : "terminal";

  const attach = useCallback((value: TaskTerminalSnapshot | null) => {
    terminal.current?.reset();
    sessionRef.current = value?.session_id || "";
    setSnapshot(value);
    if (value) {
      terminal.current?.write(value.output);
      for (const event of replay.current || [])
        if (event.session_id === value.session_id && event.sequence > value.sequence)
          terminal.current?.write(event.text);
    }

    replay.current = null;
  }, []);

  const start = useCallback(async () => {
    const target = terminal.current;
    if (!target || opening.current === target) return;
    opening.current = target;
    setBusy(true);
    replay.current = [];
    try {
      fitter.current?.fit();

      const value = await rpc<TaskTerminalSnapshot>(`${prefix}.open`, {
        id: task.id,
        cols: Math.max(20, Math.min(500, target.cols)),
        rows: Math.max(4, Math.min(200, target.rows)),
      });

      if (terminal.current !== target) return;
      attach(value);
      if (activeRef.current) target.focus();
    } catch (error) {
      if (terminal.current === target) {
        replay.current = null;
        errorRef.current(errorMessage(error));
      }
    } finally {
      if (opening.current === target) opening.current = null;
      if (terminal.current === target) setBusy(false);
    }
  }, [task.id, prefix, attach]);

  useEffect(() => {
    setReady(false);
    setBusy(false);
    setSnapshot(null);
    sessionRef.current = "";
    const theme = terminalTheme();

    const term = new Terminal({
      fontSize: 13,
      lineHeight: 1.2,
      fontFamily: theme.fontFamily,
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: 5000,
      theme,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    if (container.current) term.open(container.current);
    terminal.current = term;
    fitter.current = fit;

    term.attachCustomKeyEventHandler(
      (event) =>
        !(
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          (event.code === "Backquote" || event.key.toLowerCase() === "j")
        ),
    );

    let alive = true;
    replay.current = [];

    const sub = subscribe((event) => {
      if ((owner === "repair" ? event.repair_id : event.task_id) !== task.id) return;
      if (event.event === "terminal.output") {
        const sequence = (event.data as { sequence: number } | undefined)?.sequence || 0;
        if (replay.current)
          replay.current.push({ text: event.text || "", sequence, session_id: event.session_id });
        else if (event.session_id === sessionRef.current) term.write(event.text || "");
      }

      if (event.event === "terminal.closed" && event.session_id === sessionRef.current) {
        sessionRef.current = "";
        setSnapshot(null);
        term.writeln("\r\n[Shell exited]");
      }
    });

    void rpc<TaskTerminalSnapshot | null>(`${prefix}.status`, { id: task.id })
      .then((value) => {
        if (!alive) return;
        attach(value);
        setReady(true);
      })
      .catch((error) => {
        if (alive) {
          setReady(true);
          errorRef.current(errorMessage(error));
        }
      });

    const input = term.onData((text) => {
      if (sessionRef.current)
        void rpc(`${prefix}.input`, { id: task.id, session_id: sessionRef.current, text }).catch(
          (error) => errorRef.current(errorMessage(error)),
        );
    });

    let lastSize = "";

    const resize = () => {
      if (!container.current?.clientHeight || !container.current.clientWidth) return;
      fit.fit();
      const size = `${term.cols}/${term.rows}`;
      if (sessionRef.current && size !== lastSize) {
        lastSize = size;

        void rpc(`${prefix}.resize`, {
          id: task.id,
          session_id: sessionRef.current,
          cols: Math.max(20, Math.min(500, term.cols)),
          rows: Math.max(4, Math.min(200, term.rows)),
        }).catch((error) => errorRef.current(errorMessage(error)));
      }
    };

    const observer = new ResizeObserver(resize);
    if (container.current) observer.observe(container.current);
    return () => {
      alive = false;
      void sub.then((unlisten) => unlisten());
      observer.disconnect();
      input.dispose();
      term.dispose();
      terminal.current = null;
      fitter.current = null;
    };
  }, [task.id, owner, prefix, attach]);

  // Showing the terminal is the user's shell-open action; hide/reopen retains the PTY.
  useEffect(() => {
    if (!active || !ready) return;

    const frame = requestAnimationFrame(() => {
      fitter.current?.fit();
      terminal.current?.focus();
      if (!sessionRef.current && task.worktree_path) void start();
    });

    return () => cancelAnimationFrame(frame);
  }, [active, ready, start, task.worktree_path, focusRequest]);

  const close = async () => {
    const target = terminal.current;
    setBusy(true);
    if (activeRef.current) target?.focus();
    try {
      await rpc(`${prefix}.close`, { id: task.id });
      if (terminal.current !== target) return;
      sessionRef.current = "";
      setSnapshot(null);
    } catch (error) {
      if (terminal.current === target) errorRef.current(errorMessage(error));
    } finally {
      if (terminal.current === target) setBusy(false);
    }
  };

  const cwd = snapshot?.cwd || task.worktree_path;
  return (
    <section className="task-terminal" aria-label="Integrated terminal">
      <header>
        <TerminalSquare size={14} />
        <strong>{snapshot?.shell || "Shell"}</strong>
        <code title={cwd}>{cwd?.split("/").at(-1)}</code>
        {snapshot?.branch && (
          <span className="terminal-branch" title={snapshot.branch}>
            {snapshot.branch}
          </span>
        )}
        <span className="spacer" />
        {dock && (
          <Button
            size="icon"
            variant="ghost"
            aria-label="Dock terminal"
            title="Dock terminal"
            onClick={dock}
          >
            <PanelBottom size={14} />
          </Button>
        )}
        {snapshot ? (
          <Button
            size="icon"
            variant="ghost"
            disabled={busy}
            aria-label="Close shell"
            title="Kill terminal"
            onClick={() => void close()}
          >
            <Trash2 size={14} />
          </Button>
        ) : (
          <Button
            size="icon"
            variant="ghost"
            disabled={busy || !ready || !task.worktree_path}
            aria-label="Start terminal"
            title="New terminal"
            onClick={() => void start()}
          >
            <Plus size={14} />
          </Button>
        )}
      </header>
      <div className="terminal-surface" ref={container} />
      {!snapshot && (
        <div className="terminal-placeholder" role="status">
          {busy || !ready
            ? "Starting shell…"
            : task.worktree_path
              ? "Shell closed"
              : "Prepare this task's workspace to open a terminal."}
        </div>
      )}
    </section>
  );
};
