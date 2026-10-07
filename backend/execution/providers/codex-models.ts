import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { cleanEnvironment } from "../process";
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
        },
      );
      const models: ProviderDetection["models"] = [];
      let subscriptionLimits: ProviderDetection["subscriptionLimits"];
      const lines = createInterface({ input: child.stdout });
      let done = false;
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        lines.close();
        child.stdin.end();
        child.kill();
        if (error) reject(error);
        else resolve({ models, subscriptionLimits });
      };
      const abort = () => finish(new Error("Model discovery cancelled"));
      const timer = setTimeout(
        () =>
          finish(
            models.length
              ? undefined
              : new Error("Codex model discovery timed out"),
          ),
        15000,
      );
      signal?.addEventListener("abort", abort, { once: true });
      const send = (value: unknown) =>
        child.stdin.write(JSON.stringify(value) + "\n");
      child.stdin.on("error", () => {});
      child.stderr.resume();
      child.on("error", finish);
      child.on("close", () => {
        if (!done)
          finish(
            models.length
              ? undefined
              : new Error("Codex model discovery stopped"),
          );
      });
      lines.on("line", (line) => {
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
            if (result.nextCursor && models.length < 1000)
              send({
                id: 1,
                method: "model/list",
                params: {
                  limit: 100,
                  cursor: result.nextCursor,
                  includeHidden: false,
                },
              });
            else if (models.length)
              send({ id: 2, method: "account/rateLimits/read", params: {} });
            else finish(new Error("Codex returned no models"));
          }
        } catch {
          finish(new Error("Invalid Codex model discovery response"));
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
