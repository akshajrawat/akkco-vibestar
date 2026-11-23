import { EventEmitter } from "node:events";
import { request } from "node:http";
import { beforeEach, expect, it, vi } from "vitest";

import { EmbeddingInputRejected, localMemoryModels } from "../../apps/core/vibers/memory-local";

vi.mock("node:http", () => ({ request: vi.fn() }));

const responses = new Map<string, unknown>();
const statuses = new Map<string, number>();
const received = new Map<string, unknown>();

beforeEach(() => {
  responses.clear();
  statuses.clear();
  received.clear();
  vi.mocked(request).mockReset();

  vi.mocked(request).mockImplementation((options, callback) => {
    if (typeof options !== "object" || !("path" in options) || typeof options.path !== "string") {
      throw new Error("Expected a loopback HTTP request with a path.");
    }

    const { path } = options;

    const req = Object.assign(new EventEmitter(), {
      end: (body: string | undefined) => {
        received.set(path, body === undefined ? undefined : JSON.parse(body));

        const response = Object.assign(new EventEmitter(), {
          statusCode: statuses.get(path) ?? (responses.has(path) ? 200 : 302),
          destroy: () => {},
          setEncoding: () => {},
        });

        queueMicrotask(() => {
          (callback as (res: unknown) => void)(response);
          response.emit("data", JSON.stringify(responses.get(path) ?? {}));
          response.emit("end");
        });
      },
    });

    return req as ReturnType<typeof request>;
  });
});

it("classifies model context rejection separately from service and request errors", async () => {
  statuses.set("/api/embed", 400);
  responses.set("/api/embed", { error: "the input length exceeds the context length" });

  await expect(localMemoryModels.embed("fixture", ["Long fact"], signal())).rejects.toBeInstanceOf(
    EmbeddingInputRejected,
  );

  responses.set("/api/embed", { error: "invalid options" });

  await expect(localMemoryModels.embed("fixture", ["Valid fact"], signal())).rejects.toThrow(
    "unavailable",
  );

  statuses.set("/api/embed", 503);

  await expect(localMemoryModels.embed("fixture", ["Valid fact"], signal())).rejects.toThrow(
    "unavailable",
  );
});

const signal = () => new AbortController().signal;

it("sends no content until Ollama confirms local-only mode and an installed model", async () => {
  responses.set("/api/status", { cloud: { disabled: false } });
  expect(await localMemoryModels.suggest("fixture", "Private prompt", signal())).toEqual([]);
  expect([...received.keys()]).toEqual(["/api/status"]);
  expect(received.get("/api/status")).toBeUndefined();

  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({ hostname: "127.0.0.1", port: 11434, agent: false }),
    expect.any(Function),
  );

  responses.set("/api/status", { cloud: { disabled: true } });
  responses.set("/api/tags", { models: [{ name: "other:latest", digest: "abc" }] });
  expect(await localMemoryModels.suggest("fixture", "Private prompt", signal())).toEqual([]);
  expect([...received.keys()]).toEqual(["/api/status", "/api/tags"]);
  await expect(localMemoryModels.identify("fixture:cloud", signal())).resolves.toBeNull();
});

it("fails on redirects and accepts schema-validated responses from loopback", async () => {
  await expect(localMemoryModels.identify("fixture", signal())).rejects.toThrow("unavailable");
  expect([...received.keys()]).toEqual(["/api/status"]);

  responses.set("/api/status", { cloud: { disabled: true } });
  responses.set("/api/tags", { models: [{ name: "fixture:latest", digest: "abc" }] });

  const suggestion = {
    action: "save_memory",
    text: "Use Java for DSA.",
    evidence: "Use Java for DSA.",
    topic: "DSA",
  };

  responses.set("/api/chat", {
    message: { content: JSON.stringify({ suggestions: [suggestion] }) },
  });

  expect(await localMemoryModels.suggest("fixture", suggestion.evidence, signal())).toEqual([
    suggestion,
  ]);

  expect(received.get("/api/chat")).toMatchObject({
    model: "fixture",
    stream: false,
    format: { type: "object" },
  });
});
