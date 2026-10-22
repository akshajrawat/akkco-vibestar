import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { cleanEnvironment, terminateGroup } from "../process";
import { OutputBudget } from "../bounded-output";
import { object, type ProviderDetection } from "./contracts";

// Official app-server model/list is discovery only: no thread or model turn is started.
export const discoverCodexModels = (cwd: string, signal?: AbortSignal) =>
  new Promise<Pick<ProviderDetection, "models" | "subscriptionLimits">>(
    (resolve, reject) => {
      const child = spawn(
        "codex",
        ["--no-daemon", "app-server", "-c", "analytics.enabled=false"],
        {
          cwd,
          env: cleanEnvironment(),
          stdio: "pipe",
          shell: false,
          detached: process.platform !== "win32",
        },
      );
      const models: ProviderDetection["models"] = [];
      let subscriptionLimits: ProviderDetection["subscriptionLimits"];
      const decoder = new StringDecoder("utf8");
      const budget = new OutputBudget(2 * 1024 * 1024);
      const cursors = new Set<string>();
      let buffered = "";
      let finishing = false;
      let error: Error | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        if (process.platform === "win32") child.kill(signal);
        else terminateGroup(child.pid, signal);
      };
      const finish = (failure?: Error) => {
        if (finishing) return;
        finishing = true;
        error = failure;
        clearTimeout(timer);
        child.stdin.end();
        stop("SIGTERM");
        killTimer = setTimeout(() => stop("SIGKILL"), 500);
        killTimer.unref();
      };
      const abort = () => {
        error = new Error("Model discovery cancelled");
        finish(error);
        stop("SIGKILL");
      };
      const timer = setTimeout(
        () =>
          finish(
            models.length
              ? undefined
              : new Error("Codex model discovery timed out"),
          ),
        15000,
      );
      timer.unref();
      signal?.addEventListener("abort", abort, { once: true });
      const send = (value: unknown) =>
        child.stdin.write(JSON.stringify(value) + "\n");
      child.stdin.on("error", () => {});
      child.stderr.on("data", (chunk: Buffer) => {
        if (finishing) return;
        try {
          budget.consume(chunk);
        } catch (failure) {
          finish(failure as Error);
        }
      });
      child.on("error", finish);
      child.on("close", () => {
        if (!finishing)
          error = models.length
            ? undefined
            : new Error("Codex model discovery stopped");
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener("abort", abort);
        // A successful response is not settled until descendants are stopped.
        stop("SIGKILL");
        if (signal?.aborted) error = new Error("Model discovery cancelled");
        if (error) reject(error);
        else resolve({ models, subscriptionLimits });
      });
      const line = (line: string) => {
        if (finishing) return;
        try {
          const response = object(JSON.parse(line));
          if (response.id === 2) {
            if (!response.error) {
              const limits = object(object(response.result).rateLimits);
              const windows = [limits.primary, limits.secondary]
                .map(object)
                .filter(
                  (w) =>
                    typeof w.usedPercent === "number" &&
                    typeof w.windowDurationMins === "number" &&
                    typeof w.resetsAt === "number",
                )
                .map((w) => ({
                  usedPercent: w.usedPercent as number,
                  windowDurationMins: w.windowDurationMins as number,
                  resetsAt: w.resetsAt as number,
                }));
              if (windows.length)
                subscriptionLimits = {
                  reportedAt: new Date().toISOString(),
                  ...(typeof limits.planType === "string"
                    ? { planType: limits.planType }
                    : {}),
                  windows,
                };
            }
            finish();
            return;
          }
          if (response.error)
            return finish(
              new Error(
                String(
                  object(response.error).message || "Model discovery failed",
                ),
              ),
            );
          if (response.id === 0) {
            send({ method: "initialized", params: {} });
            send({
              id: 1,
              method: "model/list",
              params: { limit: 100, includeHidden: false },
            });
          } else if (response.id === 1) {
            const result = object(response.result);
            for (const value of Array.isArray(result.data) ? result.data : []) {
              const m = object(value);
              models.push({
                id: String(m.model || m.id),
                label: String(m.displayName || m.id),
                isDefault: m.isDefault === true,
                supportedEfforts: (Array.isArray(m.supportedReasoningEfforts)
                  ? m.supportedReasoningEfforts
                  : []
                ).map((e) => String(object(e).reasoningEffort)),
              });
            }
            if (models.length > 1000)
              return finish(
                new Error("Codex model discovery exceeded its model limit"),
              );
            if (result.nextCursor) {
              const cursor = String(result.nextCursor);
              if (cursors.has(cursor) || models.length >= 1000)
                return finish(
                  new Error(
                    "Codex model discovery pagination exceeded its limit",
                  ),
                );
              cursors.add(cursor);
              send({
                id: 1,
                method: "model/list",
                params: {
                  limit: 100,
                  cursor: result.nextCursor,
                  includeHidden: false,
                },
              });
            } else if (models.length)
              send({ id: 2, method: "account/rateLimits/read", params: {} });
            else finish(new Error("Codex returned no models"));
          }
        } catch {
          finish(new Error("Invalid Codex model discovery response"));
        }
      };
      child.stdout.on("data", (chunk: Buffer) => {
        if (finishing) return;
        try {
          budget.consume(chunk);
          buffered += decoder.write(chunk);
          let index;
          while ((index = buffered.indexOf("\n")) >= 0) {
            if (index > 256 * 1024)
              throw new Error(
                "Codex discovery response exceeded its line limit",
              );
            line(buffered.slice(0, index));
            buffered = buffered.slice(index + 1);
          }
          if (buffered.length > 256 * 1024)
            throw new Error("Codex discovery response exceeded its line limit");
        } catch (failure) {
          finish(failure as Error);
        }
      });
      send({
        id: 0,
        method: "initialize",
        params: {
          clientInfo: { name: "vibestar", title: "Vibestar", version: "0.1.0" },
        },
      });
      if (signal?.aborted) abort();
    },
  );
