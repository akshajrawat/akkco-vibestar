import { spawn } from "node:child_process";
import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Duplex, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { cleanEnvironment } from "../execution/runtime/process";
import type { ComputerDocker } from "./docker";

const headersFor = (headers: IncomingHttpHeaders) => {
  const hops = new Set([
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authorization",
    "proxy-authenticate",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
    ...(headers.connection ?? "").toLowerCase().split(/\s*,\s*/),
  ]);

  return Object.fromEntries(Object.entries(headers).filter(([name]) => !hops.has(name)));
};

const forward = async (
  incoming: IncomingMessage,
  response: ServerResponse,
  root: string,
  docker: ComputerDocker,
  target: { socket: string; id: string },
  signal: AbortSignal,
) => {
  const host = /^(?:localhost|127\.0\.0\.1):([0-9]{1,5})$/i.exec(incoming.headers.host ?? "");
  const port = Number(host?.[1]);
  if (
    !(port > 0 && port <= 65535) ||
    !incoming.url?.startsWith("/") ||
    !/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(incoming.method ?? "")
  ) {
    response.writeHead(400).end();
    return;
  }

  const timeout = AbortSignal.any([signal, AbortSignal.timeout(30000)]);

  const child = spawn(
    "docker",
    docker.args(target.socket, [
      "exec",
      "-i",
      target.id,
      "socat",
      "STDIO",
      `TCP4:127.0.0.1:${port},connect-timeout=3`,
    ]),
    { cwd: root, env: cleanEnvironment(), stdio: ["pipe", "pipe", "ignore"] },
  );

  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const socket = Duplex.from({ readable: child.stdout, writable: child.stdin });

  const upstream = request({
    host: "127.0.0.1",
    port,
    method: incoming.method,
    path: incoming.url,
    headers: { ...headersFor(incoming.headers), connection: "close" },
    createConnection: () => socket,
    signal: timeout,
  });

  child.on("error", (error) => upstream.destroy(error));
  const abort = () => upstream.destroy();
  response.once("close", abort);

  const limit = (maximum: number) => {
    let bytes = 0;
    return new Transform({
      transform(chunk: Buffer, _encoding, finish) {
        bytes += chunk.length;
        if (bytes > maximum) {
          finish(new Error("Shared Computer service body exceeds its limit."));
        } else {
          finish(null, chunk);
        }
      },
    });
  };

  try {
    const answer = new Promise<IncomingMessage>((resolve, reject) => {
      upstream.once("response", resolve);
      upstream.once("error", reject);
    });

    const sending = pipeline(incoming, limit(2 * 1024 * 1024), upstream, { signal: timeout });

    const receiving = answer.then((reply) => {
      response.writeHead(reply.statusCode ?? 502, headersFor(reply.headers));
      return pipeline(reply, limit(8 * 1024 * 1024), response, { signal: timeout });
    });

    await Promise.all([sending, receiving]);
  } catch {
    if (!response.headersSent && !response.destroyed) {
      response.writeHead(502).end();
    } else if (!response.writableFinished) {
      response.destroy();
    }
  } finally {
    response.removeListener("close", abort);
    upstream.destroy();
    child.kill("SIGKILL");
    await closed;
  }
};

// Only this opted-in sandboxed turn receives the filesystem socket. No HTTP ports are published.
export const openComputerServices = async (
  root: string,
  docker: ComputerDocker,
  target: { socket: string; id: string },
  signal: AbortSignal,
) => {
  const directory = await mkdtemp("/tmp/vibestar-services-");
  const socket = join(directory, "http.sock");
  const active = new Set<Promise<void>>();
  const controller = new AbortController();
  const lifetime = AbortSignal.any([signal, controller.signal]);

  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 30000, headersTimeout: 10000 },
    (incoming, response) => {
      if (active.size >= 8 || lifetime.aborted) {
        response.writeHead(503).end();
        return;
      }

      const task = forward(incoming, response, root, docker, target, lifetime)
        .catch(() => {
          response.destroy();
        })
        .finally(() => active.delete(task));

      active.add(task);
    },
  );

  server.maxConnections = 8;

  const close = async () => {
    controller.abort();
    try {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });

      await Promise.allSettled([...active]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });

    signal.throwIfAborted();
    return { socket, close };
  } catch (error) {
    await close();
    throw error;
  }
};
