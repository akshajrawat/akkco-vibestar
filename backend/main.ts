import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Engine } from "./execution/engine";
import { Rpc } from "./rpc";
import { AdeError } from "./domain";
import { redact } from "./execution/process";
const main = async () => {
  const engine = await Engine.create(
    process.env.VIBESTAR_HOME || join(homedir(), ".akkco-ade"),
  );
  const rpc = new Rpc(engine);
  engine.on("event", (event) =>
    process.stdout.write(`${JSON.stringify(event)}\n`),
  );
  engine.start();
  rpc.scheduler.start();
  rpc.github.start();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    engine.beginShutdown();
    await rpc.close();
    await engine.close();
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
        const result = await rpc.call(request.method, request.params);
        process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      } catch (e) {
        process.stdout.write(
          `${JSON.stringify({ id: request?.id, error: { kind: e instanceof AdeError ? e.kind : "operation_failed", message: redact(e instanceof Error ? e.message : String(e)) } })}\n`,
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
