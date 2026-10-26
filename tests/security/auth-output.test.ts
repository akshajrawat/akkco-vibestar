import { afterEach, expect, it, vi } from "vitest";
import type { IPty, IPtyForkOptions } from "node-pty";

import { tmpdir } from "node:os";

import { AuthSessions } from "../../backend/execution/terminals/auth";
import type { CoreEvent } from "../../backend/domain";

const fixture = vi.hoisted(() => ({ script: "", sessions: [] as IPty[] }));

vi.mock("node-pty", async (original) => {
  const module = await original<typeof import("node-pty")>();
  return {
    ...module,
    spawn: (program: string, args: string[], options: IPtyForkOptions) => {
      expect(program).toBe("codex");
      expect(args).toEqual(["login"]);
      const pty = module.spawn(process.execPath, ["-e", fixture.script], options);
      fixture.sessions.push(pty);
      return pty;
    },
  };
});

afterEach(() => {
  for (const pty of fixture.sessions.splice(0)) {
    try {
      pty.kill();
    } catch {
      /* Settled. */
    }
  }
});

it("redacts split credentials through the real auth PTY and emits a live prompt without a newline", async () => {
  fixture.script = `process.stdin.setRawMode(true);process.stdout.write('Login: ');process.stdin.once('data',()=>{process.stdout.write('ghp_abc');setTimeout(()=>{process.stdout.write('defghijklmnopqrstuvwxyz123456\\r\\n');setTimeout(()=>process.exit(0),20);},20);});`;
  const events: CoreEvent[] = [];
  let resolve!: () => void;

  const closed = new Promise<void>((done) => {
    resolve = done;
  });

  const auth = new AuthSessions(tmpdir(), (event) => {
    events.push(event);
    if (event.event === "auth.output" && event.text === "Login: ")
      auth.input(event.session_id!, "go");
    if (event.event === "auth.closed") resolve();
  });

  const session = auth.connect("codex");
  try {
    await closed;
    const text = events.map((event) => event.text || "").join("");
    expect(text).toContain("Login: ");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toMatch(/ghp_|abcdefghijklmnopqrstuvwxyz|defghijk/);
    expect(events.at(-1)?.event).toBe("auth.closed");
    expect(() => auth.input(session.session_id, "x")).toThrow("ended");
  } finally {
    auth.dispose();
  }
});

it("flushes an ambiguous tail safely before auth.closed", async () => {
  fixture.script = "process.stdout.write('ready sk');setInterval(()=>{},1000);";
  const events: CoreEvent[] = [];
  let resolve!: () => void;

  const closed = new Promise<void>((done) => {
    resolve = done;
  });

  const auth = new AuthSessions(tmpdir(), (event) => {
    events.push(event);
    if (event.event === "auth.output" && event.text?.includes("ready "))
      auth.close(event.session_id!);
    if (event.event === "auth.closed") resolve();
  });

  auth.connect("codex");
  try {
    await closed;
    expect(events.slice(-2).map((event) => event.event)).toEqual(["auth.output", "auth.closed"]);
    expect(events.at(-2)?.text).toBe("[REDACTED]");
    expect(events.map((event) => event.text || "").join("")).not.toContain("sk");
  } finally {
    auth.dispose();
  }
});

it("holds login slots until a SIGHUP-resistant process is killed and settled", async () => {
  fixture.script =
    "process.on('SIGHUP',()=>{});process.stdout.write('Ready: ');setInterval(()=>{},1000);";

  const ids: string[] = [];
  let ready = 0,
    ended = 0;
  let resolve!: () => void;

  const closed = new Promise<void>((done) => {
    resolve = done;
  });

  const auth = new AuthSessions(tmpdir(), (event) => {
    if (event.event === "auth.output" && event.text?.includes("Ready: ")) {
      ready++;
      if (ready === 4) {
        for (const id of ids) auth.close(id);
        expect(() => auth.connect("codex")).toThrow("maximum 4");
      }
    }

    if (event.event === "auth.closed" && ++ended === 4) resolve();
  });

  for (let i = 0; i < 4; i++) ids.push(auth.connect("codex").session_id);
  try {
    await closed;
    expect(ended).toBe(4);
    expect(() => auth.input(ids[0], "x")).toThrow("ended");
  } finally {
    auth.dispose();
  }
});

it("kills a login that ignores SIGHUP after exceeding its raw output budget", async () => {
  fixture.script =
    "process.on('SIGHUP',()=>{});process.stdout.write('sk-'+ 'z'.repeat(3*1024*1024));setInterval(()=>{},1000);";

  const events: CoreEvent[] = [];
  let resolve!: () => void;

  const closed = new Promise<void>((done) => {
    resolve = done;
  });

  const auth = new AuthSessions(tmpdir(), (event) => {
    events.push(event);
    if (event.event === "auth.closed") resolve();
  });

  auth.connect("codex");
  try {
    await closed;
    const text = events.map((event) => event.text || "").join("");
    expect(text).toContain("exceeded its limit");
    expect(text).not.toContain("zzzzzz");
    expect(events.at(-1)?.event).toBe("auth.closed");
  } finally {
    auth.dispose();
  }
});
