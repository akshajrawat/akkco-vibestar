import { randomUUID } from "node:crypto";
import { spawn, type IPty } from "node-pty";
import { AdeError, type CoreEvent } from "../domain";
import { cleanEnvironment, redact } from "./process";
export class AuthSessions {
  private sessions = new Map<string, IPty>();
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
    const id = randomUUID();
    const pty = spawn(
      program,
      program === "codex"
        ? ["login"]
        : program === "gh"
          ? [
              "auth",
              "login",
              "--hostname",
              "github.com",
              "--web",
              "--git-protocol",
              "https",
            ]
          : [],
      {
        cwd: this.cwd,
        env: cleanEnvironment() as Record<string, string>,
        name: "xterm-256color",
        cols: 110,
        rows: 28,
      },
    );
    this.sessions.set(id, pty);
    pty.onData((text) =>
      this.emit({ event: "auth.output", session_id: id, text: redact(text) }),
    );
    pty.onExit(() => {
      this.sessions.delete(id);
      this.emit({ event: "auth.closed", session_id: id });
    });
    return { session_id: id };
  };
  input = (id: string, text: string) => {
    const session = this.sessions.get(id);
    if (!session) throw new AdeError("authentication", "Login session ended");
    if (text.length > 8192)
      throw new AdeError("invalid_input", "PTY input too large");
    session.write(text);
  };
  close = (id: string) => {
    this.sessions.get(id)?.kill();
    this.sessions.delete(id);
  };
  dispose = () => {
    for (const id of this.sessions.keys()) this.close(id);
  };
}
