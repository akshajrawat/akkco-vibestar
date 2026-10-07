import { spawn, type IPty } from "node-pty";
import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { AdeError, now } from "../domain";
import type { Engine } from "./engine";
import { sandboxInvocation } from "./sandbox";
import { cleanEnvironment, redact, processIdentity } from "./process";
export class TaskTerminals {
  private readonly sessions = new Map<
    string,
    {
      id: string;
      pty: IPty;
      output: string;
      sequence: number;
      stop: () => Promise<void>;
    }
  >();
  constructor(private readonly engine: Engine) {}
  open = async (id: string, cols: number, rows: number) => {
    const existing = this.sessions.get(id);
    if (existing)
      return {
        session_id: existing.id,
        output: existing.output,
        sequence: existing.sequence,
      };
    if (this.sessions.size >= 4)
      throw new AdeError(
        "terminal_limit",
        "Close an existing task terminal before opening another (maximum 4)",
      );
    const release = this.engine.acquireTerminal(id);
    const task = this.engine.db.task(id);
    const sessionId = randomUUID();
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const cwd = await this.engine.git.assertTask(task);
      const invocation = await sandboxInvocation(
        this.engine.root,
        this.engine.db,
        task,
        { program: "bash", args: ["--noprofile", "--norc", "-i"] },
        false,
      );
      const dir = join(this.engine.root, "logs", id);
      await mkdir(dir, { recursive: true });
      handle = await open(join(dir, `${sessionId}.terminal.log`), "a", 0o600);
      this.engine.db.run(
        "INSERT INTO terminal_sessions(id,task_id,status,started_at) VALUES(?,?,'running',?)",
        sessionId,
        id,
        now(),
      );
      const pty = spawn(invocation.program, invocation.args, {
        cwd,
        cols,
        rows,
        name: "xterm-256color",
        env: {
          ...cleanEnvironment(),
          TERM: "xterm-256color",
          PS1: "\\[\\e[38;5;110m\\]vibestar \\w\\[\\e[0m\\] $ ",
        } as Record<string, string>,
      });
      let writes = Promise.resolve();
      let resolveExit!: () => void;
      const exited = new Promise<void>((resolve) => {
        resolveExit = resolve;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopping = false;
      const session = {
        id: sessionId,
        pty,
        output: "",
        sequence: 0,
        stop: async () => {
          if (stopping) return exited;
          stopping = true;
          try {
            pty.write("\x03");
            pty.kill("SIGHUP");
          } catch {
            /* The process may already be exiting. */
          }
          timer = setTimeout(() => {
            try {
              pty.kill("SIGKILL");
            } catch {
              /* Already reaped. */
            }
          }, 3000);
          timer.unref();
          await exited;
        },
      };
      this.sessions.set(id, session);
      void processIdentity(pty.pid).then((identity) => {
        if (this.sessions.has(id))
          this.engine.db.run(
            "UPDATE terminal_sessions SET pid=?,process_identity=? WHERE id=?",
            pty.pid,
            identity,
            sessionId,
          );
      });
      pty.onData((raw) => {
        const text = redact(raw);
        session.output = (session.output + text).slice(-65536);
        session.sequence++;
        writes = writes
          .then(async () => {
            await handle!.write(text);
          })
          .catch((error: unknown) => {
            this.engine.publish({
              event: "core.error",
              task_id: id,
              text: `Task terminal log could not be saved: ${redact(String(error))}`,
            });
          });
        this.engine.publish({
          event: "terminal.output",
          task_id: id,
          session_id: sessionId,
          text,
          data: { sequence: session.sequence },
        });
      });
      pty.onExit(({ exitCode }) => {
        stopping = true;
        if (timer) clearTimeout(timer);
        this.engine.db.run(
          "UPDATE terminal_sessions SET status='closed',ended_at=?,exit_code=? WHERE id=?",
          now(),
          exitCode,
          sessionId,
        );
        this.engine.publish({
          event: "terminal.closed",
          task_id: id,
          session_id: sessionId,
        });
        void writes.then(async () => {
          try {
            await handle!.close();
          } catch (error) {
            this.engine.publish({
              event: "core.error",
              task_id: id,
              text: `Task terminal log could not be closed: ${redact(String(error))}`,
            });
          } finally {
            this.sessions.delete(id);
            release();
            resolveExit();
          }
        });
      });
      return {
        session_id: sessionId,
        output: session.output,
        sequence: session.sequence,
      };
    } catch (e) {
      try {
        await handle?.close();
      } catch (error) {
        this.engine.publish({
          event: "core.error",
          task_id: id,
          text: `Terminal log cleanup failed: ${redact(String(error))}`,
        });
      } finally {
        release();
      }
      this.engine.db.run(
        "UPDATE terminal_sessions SET status='failed',ended_at=? WHERE id=?",
        now(),
        sessionId,
      );
      throw e;
    }
  };
  current = (id: string) => {
    const session = this.sessions.get(id);
    return session
      ? {
          session_id: session.id,
          output: session.output,
          sequence: session.sequence,
        }
      : null;
  };
  input = (taskId: string, sessionId: string, text: string) => {
    const session = this.sessions.get(taskId);
    if (!session || session.id !== sessionId)
      throw new AdeError("terminal", "Task terminal has ended");
    session.pty.write(text);
  };
  resize = (taskId: string, sessionId: string, cols: number, rows: number) => {
    const session = this.sessions.get(taskId);
    if (session?.id === sessionId) session.pty.resize(cols, rows);
  };
  close = async (taskId: string) => {
    await this.sessions.get(taskId)?.stop();
  };
  dispose = async () => {
    await Promise.allSettled(
      [...this.sessions.keys()].map((id) => this.close(id)),
    );
  };
}
