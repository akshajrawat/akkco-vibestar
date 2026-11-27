import { spawn } from "node:child_process";
import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Duplex, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { cleanEnvironment } from "../execution/runtime/process";
import { sharedCommandUrl } from "./contracts";
import type { ComputerDocker } from "./docker";
import { guestCommandTimeoutMs } from "./image";

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

const maxUploadBytes = 2 * 1024 * 1024;
const maxCommandBytes = 32 * 1024;
const commandUrl = new URL(sharedCommandUrl);
export const verifiedBootFile = "/tmp/vibestar-verified-boot";

type Target = { socket: string; id: string; bootToken: string };

type Verify = () => Promise<boolean>;

// Check inside the exec as well, since Docker can restart between inspect and exec.
const guestExec = (target: Target, args: string[]) => [
  "exec",
  "-i",
  target.id,
  "sh",
  "-c",
  'set -e; read -r boot < "$1"; test "$boot" = "$2"; shift 2; exec "$@"',
  "verify-boot",
  verifiedBootFile,
  target.bootToken,
  ...args,
];

const runCommand = async (
  incoming: IncomingMessage,
  response: ServerResponse,
  docker: ComputerDocker,
  target: Target,
  signal: AbortSignal,
  verify: Verify,
) => {
  if (incoming.method !== "POST" || incoming.url !== commandUrl.pathname) {
    response.writeHead(400).end();
    return;
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  response.once("close", abort);
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of incoming.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length;
      if (bytes > maxCommandBytes) {
        response.writeHead(413, { connection: "close" }).end();
        return;
      }

      chunks.push(chunk);
    }

    const script = Buffer.concat(chunks).toString("utf8");
    if (!script.trim() || script.includes("\0")) {
      response.writeHead(400).end();
      return;
    }

    const result = await docker.run(
      target.socket,
      guestExec(target, ["/usr/local/bin/vibestar-exec", script]),
      {
        signal: AbortSignal.any([signal, controller.signal]),
        timeoutMs: guestCommandTimeoutMs + 5000,
        inputProtocol: { start: () => {}, receive: () => {} },
      },
    );

    if (result.code !== 0 && !(await verify())) {
      response.writeHead(503, { connection: "close" }).end();
    } else {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    }
  } catch {
    if (!response.headersSent && !response.destroyed) {
      const status = (await verify()) ? 502 : 503;
      response.writeHead(status, { connection: "close" }).end();
    }
  } finally {
    response.removeListener("close", abort);
  }
};

const forward = async (
  incoming: IncomingMessage,
  response: ServerResponse,
  root: string,
  docker: ComputerDocker,
  target: Target,
  signal: AbortSignal,
  verify: Verify,
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

  if (Number(incoming.headers["content-length"]) > maxUploadBytes) {
    response.writeHead(413, { connection: "close" }).end();
    return;
  }

  const headers: OutgoingHttpHeaders = { ...headersFor(incoming.headers), connection: "close" };
  // Node has already validated and decoded the incoming request's framing.
  const contentLength = incoming.headers["content-length"];
  if (contentLength !== undefined) {
    headers["content-length"] = contentLength;
  } else if (incoming.headers["transfer-encoding"] !== undefined) {
    headers["transfer-encoding"] = "chunked";
  }

  const timeout = AbortSignal.any([signal, AbortSignal.timeout(30000)]);

  const child = spawn(
    "docker",
    docker.args(
      target.socket,
      guestExec(target, ["socat", "STDIO", `TCP4:127.0.0.1:${port},connect-timeout=3`]),
    ),
    { cwd: root, env: cleanEnvironment(), stdio: ["pipe", "pipe", "ignore"] },
  );

  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const socket = Duplex.from({ readable: child.stdout, writable: child.stdin });

  const upstream = request({
    host: "127.0.0.1",
    port,
    method: incoming.method,
    path: incoming.url,
    headers,
    createConnection: () => socket,
    signal: timeout,
  });

  child.on("error", (error) => upstream.destroy(error));
  const abort = () => upstream.destroy();
  response.once("close", abort);

  const oversized = new Error("Shared Computer service upload exceeds its limit.");

  const limit = (maximum: number, failure: Error) => {
    let bytes = 0;
    return new Transform({
      transform(chunk: Buffer, _encoding, finish) {
        bytes += chunk.length;
        if (bytes > maximum) {
          finish(failure);
        } else {
          finish(null, chunk);
        }
      },
    });
  };

  // Keep the client request out of the pipeline so upstream failures leave its HTTP socket writable.
  const upload = limit(maxUploadBytes, oversized);
  const abortUpload = (error: Error) => upload.destroy(error);
  incoming.once("error", abortUpload);

  try {
    const answer = new Promise<IncomingMessage>((resolve, reject) => {
      upstream.once("response", resolve);
      upstream.once("error", reject);
    });

    const sending = pipeline(upload, upstream, { signal: timeout });
    incoming.pipe(upload);

    const receiving = answer.then((reply) => {
      response.writeHead(reply.statusCode ?? 502, headersFor(reply.headers));
      return pipeline(
        reply,
        limit(8 * 1024 * 1024, new Error("Shared Computer service response exceeds its limit.")),
        response,
        { signal: timeout },
      );
    });

    await Promise.all([sending, receiving]);
  } catch (error) {
    if (!response.headersSent && !response.destroyed) {
      const status = error === oversized ? 413 : (await verify()) ? 502 : 503;
      response.writeHead(status, { connection: "close" }).end();
    } else if (!response.writableFinished) {
      response.destroy();
    }
  } finally {
    incoming.unpipe(upload);
    incoming.removeListener("error", abortUpload);
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
  target: Target,
  signal: AbortSignal,
  verify: Verify,
) => {
  const directory = await mkdtemp("/tmp/vibestar-services-");
  const socket = join(directory, "http.sock");
  const active = new Set<Promise<void>>();
  const controller = new AbortController();
  const lifetime = AbortSignal.any([signal, controller.signal]);

  const stillVerified = async () => {
    if (!lifetime.aborted && !(await verify())) {
      controller.abort();
    }

    return !lifetime.aborted;
  };

  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 30000, headersTimeout: 10000 },
    (incoming, response) => {
      if (active.size >= 8 || lifetime.aborted) {
        response.writeHead(503).end();
        return;
      }

      const task = (async () => {
        if (!(await stillVerified())) {
          response.writeHead(503, { connection: "close" }).end();
          return;
        }

        if (incoming.headers.host === commandUrl.host) {
          await runCommand(incoming, response, docker, target, lifetime, stillVerified);
        } else {
          await forward(incoming, response, root, docker, target, lifetime, stillVerified);
        }
      })()
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
