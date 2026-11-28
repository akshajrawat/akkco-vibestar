import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ComputerDocker } from "../../apps/core/computers/docker";
import { openComputerServices } from "../../apps/core/computers/services";

const listen = (server: Server) =>
  new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

it("streams uploads to the guest, returns 502 on guest failure and 413 for both upload limits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibestar-service-test-"));
  const target = { socket: "/fixture.sock", id: "desktop-id", bootToken: "verified-boot" };
  let firstChunk: ((text: string) => void) | undefined;
  let currentBoot = true;

  const guest = createServer((incoming, response) => {
    if (incoming.url === "/failed") {
      incoming.socket.destroy();
      return;
    }

    let bytes = 0;

    incoming.on("data", (chunk: Buffer) => {
      if (incoming.url === "/stream") {
        firstChunk?.(chunk.toString());
      }

      bytes += chunk.length;
    });

    incoming.on("end", () => response.end(String(bytes)));
  });

  let sharing: Awaited<ReturnType<typeof openComputerServices>> | undefined;
  try {
    const port = await listen(guest);

    // The fixture replaces docker exec + socat with a byte-for-byte stdio relay.
    await writeFile(
      join(directory, "docker"),
      `#!${process.execPath}
const address = /^TCP4:127\\.0\\.0\\.1:(\\d+),connect-timeout=3$/.exec(process.argv.at(-1));
if (!address || process.argv[2] !== "--host" || process.argv[3] !== "unix:///fixture.sock") process.exit(2);
const socket = require("node:net").connect(Number(address[1]), "127.0.0.1");
process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.on("error", () => process.exit(3));
`,
      { mode: 0o700 },
    );

    vi.stubEnv("PATH", `${directory}:${process.env.PATH}`);

    const docker = new ComputerDocker(directory);

    sharing = await openComputerServices(
      directory,
      docker,
      target,
      new AbortController().signal,
      async () => currentBoot,
    );

    const upload = (
      path: string,
      headers: Record<string, string | number> = {},
      method = "POST",
    ) => {
      const client = request({
        socketPath: sharing!.socket,
        method,
        path,
        headers: { host: `localhost:${port}`, ...headers },
      });

      const reply = new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        client.on("error", reject);

        client.on("response", (result) => {
          result.setEncoding("utf8");
          let body = "";

          result.on("data", (chunk: string) => {
            body += chunk;
          });

          result.on("end", () => resolve({ status: result.statusCode, body }));
          result.on("error", reject);
        });
      });

      return { client, reply };
    };

    for (const [method, headers] of [
      ["POST", {}],
      ["DELETE", { "transfer-encoding": "chunked" }],
      ["OPTIONS", { "transfer-encoding": "chunked" }],
      ["OPTIONS", { "content-length": 11, connection: "content-length" }],
    ] as const) {
      let timeout: ReturnType<typeof setTimeout>;

      const chunk = new Promise<string>((resolve, reject) => {
        firstChunk = resolve;
        timeout = setTimeout(() => reject(new Error("No guest chunk arrived.")), 1000);
      });

      const streaming = upload("/stream", headers, method);

      const prematureReply = streaming.reply.then(() => {
        throw new Error("Upload received a reply before its first guest chunk.");
      });

      try {
        streaming.client.write("hello");
        expect(await Promise.race([chunk, prematureReply])).toBe("hello");
        streaming.client.end(" there");
        await expect(streaming.reply).resolves.toEqual({ status: 200, body: "11" });
      } finally {
        clearTimeout(timeout!);
        streaming.client.destroy();
      }
    }

    const failed = upload("/failed", { "transfer-encoding": "chunked" }, "DELETE");
    failed.client.write("hello");
    await expect(failed.reply).resolves.toEqual({ status: 502, body: "" });
    failed.client.end();

    const maximum = 2 * 1024 * 1024;
    const declared = upload("/oversized", { "content-length": maximum + 1 });
    declared.client.flushHeaders();
    await expect(declared.reply).resolves.toEqual({ status: 413, body: "" });
    declared.client.end();

    const chunked = upload("/oversized", { "transfer-encoding": "chunked" }, "OPTIONS");
    chunked.client.end(Buffer.alloc(maximum + 1));
    await expect(chunked.reply).resolves.toEqual({ status: 413, body: "" });

    const exec = vi.spyOn(docker, "run").mockImplementationOnce(async () => {
      currentBoot = false;
      return { code: 1, stdout: "", stderr: "", duration_ms: 0 };
    });

    const stale = upload("/exec", { host: "computer" });
    stale.client.end("printf stale");
    await expect(stale.reply).resolves.toEqual({ status: 503, body: "" });
    expect(exec).toHaveBeenCalledOnce();

    currentBoot = true;
    const invalidated = upload("/stream");
    invalidated.client.end("still stale");
    await expect(invalidated.reply).resolves.toEqual({ status: 503, body: "" });
  } finally {
    vi.unstubAllEnvs();
    await sharing?.close();

    await new Promise<void>((resolve) => {
      guest.close(() => resolve());
      guest.closeAllConnections();
    });

    await rm(directory, { recursive: true, force: true });
  }
});
