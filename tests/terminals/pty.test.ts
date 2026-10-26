import { it, expect } from "vitest";
import { spawn } from "node-pty";

import { tmpdir } from "node:os";

it("streams official-login style PTY output and accepts keyboard input", async () => {
  const output = await new Promise<string>((resolve, reject) => {
    const pty = spawn(
      process.execPath,
      [
        "-e",
        "process.stdout.write('PTY ready\\n');process.stdin.once('data',data=>{process.stdout.write('received:'+data);process.exit(0)});",
      ],
      {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: tmpdir(),
        env: process.env as Record<string, string>,
      },
    );

    let text = "";
    let sent = false;

    const timer = setTimeout(() => {
      pty.kill();
      reject(new Error("PTY deadline exceeded"));
    }, 5000);

    pty.onData((data) => {
      text += data;
      if (text.includes("PTY ready") && !sent) {
        sent = true;
        pty.write("hello\r");
      }
    });

    pty.onExit(() => {
      clearTimeout(timer);
      resolve(text);
    });
  });

  expect(output).toContain("received:hello");
});
