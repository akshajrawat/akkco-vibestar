import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { z } from "zod";
import { Engine } from "./execution/engine";
import { Rpc } from "./rpc";
import { AdeError, defaultSettings } from "./domain";
import { dataRootChoice, chooseDataRoot } from "./storage/bootstrap";
import { redact } from "./execution/process";
const main = async () => {
  const build = createHash("sha256")
    .update(await readFile(__filename))
    .digest("hex");
  const bootstrap = await dataRootChoice();
  let engine: Engine | undefined;
  let rpc: Rpc | undefined;
  let initializing: Promise<void> | undefined;
  let choosing = false;
  const start = (root: string) => {
    if (initializing) return initializing;
    initializing = (async () => {
      engine = await Engine.create(root);
      rpc = new Rpc(engine);
      engine.on("event", (event) =>
        process.stdout.write(`${JSON.stringify(event)}\n`),
      );
      engine.start();
      rpc.scheduler.start();
    })().finally(() => {
      initializing = undefined;
    });
    return initializing;
  };
  if (!bootstrap.migration) await start(bootstrap.root);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    engine?.beginShutdown();
    await rpc?.close();
    await engine?.close();
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => void stop());
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const requestSchema = z.object({
    id: z.string().uuid(),
    method: z.string().max(100),
    params: z.unknown(),
  });
  lines.on("line", (line) => {
    if (line.length > 1024 * 1024) return;
    void (async () => {
      let request: z.infer<typeof requestSchema> | undefined;
      try {
        request = requestSchema.parse(JSON.parse(line));
        let result: unknown;
        if (request.method === "core.info")
          result = {
            build,
            protocol: 3,
            pipeline_approvals: true,
            manual_pr_analysis: true,
          };
        else if (!rpc && request.method === "snapshot")
          result = {
            repositories: [],
            tasks: [],
            settings: defaultSettings,
            root: bootstrap.root,
            migration: bootstrap.migration,
          };
        else if (
          !rpc &&
          request.method === "storage.chooseRoot" &&
          bootstrap.migration
        ) {
          if (initializing || choosing)
            throw new AdeError(
              "busy",
              "Data initialization is already in progress",
            );
          const choice = z
            .object({ choice: z.enum(["migrate", "old", "fresh"]) })
            .parse(request.params).choice;
          choosing = true;
          try {
            const root = await chooseDataRoot(bootstrap.migration, choice);
            await start(root);
            result = { root };
          } finally {
            choosing = false;
          }
        } else {
          if (!rpc)
            throw new AdeError(
              "migration",
              "Choose how to use the existing Vibestar data first",
            );
          result = await rpc.call(request.method, request.params);
        }
        process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      } catch (e) {
        process.stdout.write(
          `${JSON.stringify({ id: request?.id, error: { kind: e instanceof AdeError ? e.kind : "operation_failed", context: e instanceof AdeError ? e.context : undefined, message: redact(e instanceof Error ? e.message : String(e)), technical: redact(e instanceof Error ? e.stack || e.message : String(e)) } })}\n`,
        );
      }
    })();
  });
  lines.on("close", () => void stop());
};
void main().catch((e) => {
  process.stderr.write(`${redact(String(e))}\n`);
  process.exit(1);
});
