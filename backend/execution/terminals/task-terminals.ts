import { spawn, type IPty } from "node-pty";

import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { basename, join } from "node:path";
import { userInfo } from "node:os";

import { AdeError, now, type WorkspaceAssignment } from "../../domain";
import type { Engine } from "../engine";
import { redact, processIdentity } from "../runtime/process";
import { StreamRedactor } from "../output/stream-redactor";
import { BoundedWriter, OutputBudget } from "../output/bounded-output";
import { gitChecked } from "../../workspace/git-command";

export interface TaskTerminalSnapshot {
  session_id: string;
  output: string;
  sequence: number;
  cwd?: string;
  shell?: string;
  branch?: string;
}

export class TaskTerminals {
  private readonly sessions = new Map<
    string,
    {
      id: string;
      pty: IPty;
      output: string;
      sequence: number;
      cwd: string;
      shell: string;
      branch: string;
      stop: () => Promise<void>;
    }
  >();

  private readonly opening = new Map<string, Promise<TaskTerminalSnapshot>>();

  private closed = false;

  constructor(
    private readonly engine: Engine,
    private readonly repair?: {
      assignment: (id: string) => WorkspaceAssignment;
      acquire: (id: string) => Promise<() => Promise<void>>;
    },
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  open = async (id: string, cols: number, rows: number) => {
    if (this.closed) throw new AdeError("closed", "Terminals are shutting down.");
    const existing = this.current(id);
    if (existing) return existing;
    const pending = this.opening.get(id);
    if (pending) return pending;
    if (this.sessions.size + this.opening.size >= 4)
      throw new AdeError(
        "terminal_limit",
        "Close an existing task terminal before opening another (maximum 4)",
      );

    const started = this.start(id, cols, rows).finally(() => this.opening.delete(id));
    this.opening.set(id, started);
    return started;
  };

  /** Adds only a missing alias in an owned managed clone; user-owned remotes stay untouched. */
  private directory = (task: WorkspaceAssignment) =>
    this.engine.git.withLock(task.repo_id, async () => {
      const cwd = await this.engine.git.assertTask(task);
      const repository = this.engine.db.repository(task.repo_id);
      if (repository.source !== "imported") {
        const remotes = (await gitChecked(["remote"], cwd)).split("\n");
        if (!remotes.includes("origin"))
          await gitChecked(
            ["remote", "add", "--", "origin", repository.origin_url || repository.upstream_url],
            cwd,
          );
      }

      return cwd;
    });

  private start = async (id: string, cols: number, rows: number): Promise<TaskTerminalSnapshot> => {
    const releaseLease = this.repair
      ? await this.repair.acquire(id)
      : this.engine.acquireTerminal(id);

    const task = this.repair ? this.repair.assignment(id) : this.engine.db.task(id);
    const owner = this.repair ? { repair_id: id } : { task_id: id };
    let releaseActivity = () => {};

    const release = async () => {
      await releaseLease();
      releaseActivity();
    };

    const sessionId = randomUUID();
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const cwd = await this.directory(task);

      const dir = join(this.engine.root, "logs", id);
      await mkdir(dir, { recursive: true });
      handle = await open(join(dir, `${sessionId}.terminal.log`), "a", 0o600);

      this.engine.db.run(
        `INSERT INTO terminal_sessions(id,${this.repair ? "repair_id" : "task_id"},status,started_at) VALUES(?,?,'running',?)`,
        sessionId,
        id,
        now(),
      );

      // Explicit user terminals share the user's shell, Git config and authentication.
      // Agent and verification commands continue through the separate sandbox path.
      const shell = this.environment.SHELL || userInfo().shell || "/bin/bash";

      const pty = spawn(shell, ["-i"], {
        cwd,
        cols,
        rows,
        name: "xterm-256color",
        env: {
          ...this.environment,
          PWD: cwd,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        } as Record<string, string>,
      });

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
        cwd,
        shell: basename(shell),
        branch: task.branch_name,
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

      const redactor = new StreamRedactor();
      const budget = new OutputBudget();
      let outputFailure = false;

      const failOutput = (error: unknown) => {
        if (outputFailure) return;
        outputFailure = true;

        this.engine.publish({
          event: "core.error",
          ...owner,
          text: `Task terminal output stopped: ${redact(String(error))}`,
        });

        void session.stop();
      };

      const writes = new BoundedWriter(failOutput);
      this.sessions.set(id, session);
      if (this.repair)
        releaseActivity = this.engine.trackActivity(
          {
            id: `repair-terminal:${id}`,
            kind: "terminal",
            label: "PR repair terminal is open",
            stoppable: true,
          },
          () => this.close(id),
        );

      void processIdentity(pty.pid).then((identity) => {
        if (this.sessions.has(id))
          this.engine.db.run(
            "UPDATE terminal_sessions SET pid=?,process_identity=? WHERE id=?",
            pty.pid,
            identity,
            sessionId,
          );
      });

      const publish = (text: string) => {
        if (!text || outputFailure) return;
        writes.write(text, (value) => handle!.write(value));
        session.output = (session.output + text).slice(-65536);
        session.sequence++;

        this.engine.publish({
          event: "terminal.output",
          ...owner,
          session_id: sessionId,
          text,
          data: { sequence: session.sequence },
        });
      };

      pty.onData((raw) => {
        if (outputFailure) return;
        try {
          budget.consume(raw);
          publish(redactor.push(raw));
        } catch (error) {
          failOutput(error);
        }
      });

      pty.onExit(({ exitCode }) => {
        stopping = true;
        if (timer) clearTimeout(timer);
        try {
          publish(redactor.finish());
        } catch (error) {
          failOutput(error);
        }

        void writes
          .drain()
          .catch(failOutput)
          .then(async () => {
            try {
              await handle!.close();
            } catch (error) {
              this.engine.publish({
                event: "core.error",
                ...owner,
                text: `Task terminal log could not be closed: ${redact(String(error))}`,
              });
            } finally {
              this.engine.db.run(
                "UPDATE terminal_sessions SET status=?,ended_at=?,exit_code=? WHERE id=?",
                outputFailure ? "failed" : "closed",
                now(),
                exitCode,
                sessionId,
              );

              this.engine.publish({
                event: "terminal.closed",
                ...owner,
                session_id: sessionId,
              });

              this.sessions.delete(id);
              await release();
              resolveExit();
            }
          });
      });

      return {
        session_id: sessionId,
        output: session.output,
        sequence: session.sequence,
        cwd: session.cwd,
        shell: session.shell,
        branch: session.branch,
      };
    } catch (e) {
      try {
        await handle?.close();
      } catch (error) {
        this.engine.publish({
          event: "core.error",
          ...owner,
          text: `Terminal log cleanup failed: ${redact(String(error))}`,
        });
      } finally {
        await release();
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
          cwd: session.cwd,
          shell: session.shell,
          branch: session.branch,
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
    await this.opening.get(taskId)?.catch(() => {});
    await this.sessions.get(taskId)?.stop();
  };

  dispose = async () => {
    this.closed = true;
    const ids = new Set([...this.sessions.keys(), ...this.opening.keys()]);
    await Promise.allSettled([...ids].map((id) => this.close(id)));
  };
}
