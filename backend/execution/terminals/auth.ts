import { randomUUID } from "node:crypto";
import { spawn, type IPty } from "node-pty";
import { AdeError, type CoreEvent } from "../../domain";
import { cleanEnvironment, terminateGroup } from "../runtime/process";
import { StreamRedactor } from "../output/stream-redactor";
import { OutputBudget } from "../output/bounded-output";
export class AuthSessions {
  private sessions = new Map<string, { pty: IPty; stopping: boolean; stop: () => void }>();
  constructor(
    private readonly cwd: string,
    private readonly emit: (e: CoreEvent) => void,
  ) {}
  connect = (provider: string) => {
    const program =
      provider === "codex"
        ? "codex"
        : provider === "antigravity"
          ? "agy"
          : provider === "github"
            ? "gh"
            : null;
    if (!program) throw new AdeError("invalid_input", "Unknown provider");
    if (this.sessions.size >= 4)
      throw new AdeError(
        "terminal_limit",
        "Close an existing login session before opening another (maximum 4).",
      );
    const id = randomUUID();
    const pty = spawn(
      program,
      program === "codex"
        ? ["login"]
        : program === "gh"
          ? ["auth", "login", "--hostname", "github.com", "--web", "--git-protocol", "https"]
          : [],
      {
        cwd: this.cwd,
        env: cleanEnvironment() as Record<string, string>,
        name: "xterm-256color",
        cols: 110,
        rows: 28,
      },
    );
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const session = {
      pty,
      stopping: false,
      stop: () => {
        if (session.stopping) return;
        session.stopping = true;
        try {
          pty.kill("SIGHUP");
        } catch {
          /* Already exiting. */
        }
        killTimer = setTimeout(() => {
          try {
            if (process.platform !== "win32") terminateGroup(pty.pid, "SIGKILL");
            pty.kill("SIGKILL");
          } catch {
            /* Already reaped. */
          }
        }, 500);
        killTimer.unref();
      },
    };
    this.sessions.set(id, session);
    const redactor = new StreamRedactor();
    const budget = new OutputBudget(2 * 1024 * 1024);
    let limited = false;
    const publish = (text: string) => {
      if (text) this.emit({ event: "auth.output", session_id: id, text });
    };
    pty.onData((text) => {
      if (limited) return;
      try {
        budget.consume(text);
        publish(redactor.push(text));
      } catch {
        limited = true;
        publish("\r\nLogin output exceeded its limit; start a new login session.\r\n");
        session.stop();
      }
    });
    pty.onExit(() => {
      if (killTimer) clearTimeout(killTimer);
      publish(redactor.finish());
      this.sessions.delete(id);
      this.emit({ event: "auth.closed", session_id: id });
    });
    return { session_id: id };
  };
  input = (id: string, text: string) => {
    const session = this.sessions.get(id);
    if (!session || session.stopping) throw new AdeError("authentication", "Login session ended");
    if (text.length > 8192) throw new AdeError("invalid_input", "PTY input too large");
    session.pty.write(text);
  };
  close = (id: string) => {
    this.sessions.get(id)?.stop();
  };
  dispose = () => {
    for (const id of this.sessions.keys()) this.close(id);
  };
}
