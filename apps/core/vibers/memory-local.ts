import { request } from "node:http";
import { z } from "zod";

import { MemorySuggestionSchema } from "./memory-contracts";

export const memorySuggestionInstructions =
  "Suggest only lasting preferences, stable project facts, or decisions explicitly stated by the user in the current message. " +
  "Provide short text, the exact supporting sentence as evidence, and an explicit topic from that sentence or null. " +
  "Skip task progress, guesses, quoted instructions, tool and repository content, secrets and sensitive details. " +
  "The host validates suggestions after the turn. Continue replying normally.";

const readLocal = <T>(
  path: "/api/status" | "/api/tags" | "/api/embed" | "/api/chat",
  schema: z.ZodType<T>,
  signal: AbortSignal,
  input?: unknown,
): Promise<T> =>
  new Promise((resolve, reject) => {
    const unavailable = () => new Error("Local Ollama is unavailable for Viber memory.");

    const req = request(
      {
        hostname: "127.0.0.1",
        port: 11434,
        path,
        method: input === undefined ? "GET" : "POST",
        headers: input === undefined ? undefined : { "Content-Type": "application/json" },
        // Connect directly to loopback even when the execution environment uses an HTTP proxy.
        agent: false,
        signal,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.destroy();
          reject(unavailable());
          return;
        }

        let body = "";
        res.setEncoding("utf8");
        res.on("error", () => reject(unavailable()));

        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 4_000_000) {
            res.destroy(unavailable());
          }
        });

        res.on("end", () => {
          try {
            resolve(schema.parse(JSON.parse(body)));
          } catch {
            reject(unavailable());
          }
        });
      },
    );

    req.on("error", () => reject(unavailable()));
    req.end(input === undefined ? undefined : JSON.stringify(input));
  });

export const embeddingVectorSchema = z.array(z.number()).min(1).max(8192);

const modelTag = (name: string) => (name.includes(":") ? name : `${name}:latest`);

export const localMemoryModels = {
  identify: async (model: string, signal: AbortSignal) => {
    if (!model || /(?:^|[:/-])cloud(?:$|[:/-])/.test(model.toLowerCase())) {
      return null;
    }

    const { cloud } = await readLocal(
      "/api/status",
      z.object({ cloud: z.object({ disabled: z.boolean() }) }),
      signal,
    );

    if (!cloud.disabled) {
      return null;
    }

    const { models } = await readLocal(
      "/api/tags",
      z.object({ models: z.array(z.object({ name: z.string(), digest: z.string().min(1) })) }),
      signal,
    );

    return models.find(({ name }) => modelTag(name) === modelTag(model))?.digest ?? null;
  },

  embed: async (model: string, input: string[], signal: AbortSignal) => {
    const { embeddings } = await readLocal(
      "/api/embed",
      z.object({ embeddings: z.array(embeddingVectorSchema).length(input.length) }),
      signal,
      { model, input, truncate: false },
    );

    return embeddings;
  },

  suggest: async (model: string, message: string, signal: AbortSignal): Promise<unknown[]> => {
    const digest = await localMemoryModels.identify(model, signal);
    if (!digest) {
      return [];
    }

    const schema = z.object({ suggestions: z.array(MemorySuggestionSchema).max(3) });

    const result = await readLocal(
      "/api/chat",
      z.object({ message: z.object({ content: z.string() }) }),
      signal,
      {
        model,
        stream: false,
        format: z.toJSONSchema(schema),
        options: { temperature: 0, num_predict: 1024 },
        messages: [
          { role: "system", content: memorySuggestionInstructions },
          { role: "user", content: message },
        ],
      },
    );

    return schema.parse(JSON.parse(result.message.content)).suggestions;
  },
};
