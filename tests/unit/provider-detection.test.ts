import { it, expect, vi, beforeEach } from "vitest";

import { AntigravityProvider } from "../../apps/core/execution/providers/antigravity";
import { CodexProvider } from "../../apps/core/execution/providers/codex";
import { capture, checked } from "../../apps/core/execution/runtime/process";
import { configurationError } from "../../apps/core/execution/providers/contracts";

vi.mock("../../apps/core/execution/runtime/process", () => ({
  capture: vi.fn(),
  checked: vi.fn(),
}));

vi.mock("../../apps/core/execution/providers/codex-models", () => ({
  discoverCodexModels: vi.fn(async () => ({
    models: [
      {
        id: "current-model",
        isDefault: true,
        supportedEfforts: ["low", "high", "max"],
      },
    ],
  })),
}));

beforeEach(() => {
  vi.mocked(checked).mockImplementation(async (_program, args) =>
    args.includes("--version")
      ? "official CLI"
      : "--no-daemon --json --sandbox --output-schema --ignore-user-config --ignore-rules --skip-git-repo-check",
  );

  vi.mocked(capture).mockImplementation(async (_program, args) => ({
    duration_ms: 1,
    code: 0,
    stdout:
      args[0] === "models"
        ? "gemini-3.8-flash-high\tGemini 3.8 Flash High\nclaude-sonnet-4-6\tClaude Sonnet\n"
        : args[0] === "login"
          ? "Logged in using ChatGPT"
          : "--mode --sandbox --effort --input-format --output-format --json-schema --conversation",
    stderr: "",
  }));
});

it("marks authenticated Antigravity connected from official model discovery", async () => {
  const d = await new AntigravityProvider().detect("/tmp");
  expect(d).toMatchObject({ installed: true, connected: true, error: null });

  expect(d.models[0]).toMatchObject({
    id: "gemini-3.8-flash-high",
    supportedEfforts: ["high"],
  });

  expect(
    configurationError(d, {
      model: d.models[0].id,
      effort: "low",
      timeout_secs: 30,
    }),
  ).toContain("does not support");
});

it("shows unavailable Antigravity authentication without fabricating an account", async () => {
  vi.mocked(capture).mockImplementation(async (_program, args) => ({
    duration_ms: 1,
    code: args[0] === "models" ? 1 : 0,
    stdout: "--mode --sandbox --effort --input-format --output-format --json-schema --conversation",
    stderr: "Sign in required",
  }));

  expect(await new AntigravityProvider().detect("/tmp")).toMatchObject({
    installed: true,
    connected: false,
    models: [],
    error: "Sign in required",
  });
});

it("rejects Antigravity versions without streamed stdin support before execution", async () => {
  vi.mocked(capture).mockClear();

  vi.mocked(capture).mockResolvedValue({
    duration_ms: 1,
    code: 0,
    stdout: "--mode --sandbox --effort --output-format --json-schema --conversation",
    stderr: "",
  });

  const detection = await new AntigravityProvider().detect("/tmp");
  expect(detection.connected).toBe(false);
  expect(detection.capabilities).toEqual([]);
  expect(detection.error).toContain("Installed CLI lacks --input-format");
  expect(capture).toHaveBeenCalledTimes(1);
});

it("requires explicit capabilities for newly discovered unsuffixed Antigravity models", async () => {
  vi.mocked(capture).mockImplementation(async (_program, args) => ({
    duration_ms: 1,
    code: 0,
    stdout:
      args[0] === "models"
        ? "future-model\tFuture model\n"
        : "--mode --sandbox --effort --input-format --output-format --json-schema --conversation",
    stderr: "",
  }));

  const d = await new AntigravityProvider().detect("/tmp");
  expect(d.connected).toBe(true);

  expect(
    configurationError(d, {
      model: "future-model",
      effort: "high",
      timeout_secs: 30,
    }),
  ).toContain("capabilities unavailable");
});

it("uses discovered Codex model efforts, including newer supported levels", async () => {
  const d = await new CodexProvider().detect("/tmp");
  expect(d.connected).toBe(true);

  expect(
    configurationError(d, {
      model: "current-model",
      effort: "max",
      timeout_secs: 30,
    }),
  ).toBeNull();

  expect(
    configurationError(d, {
      model: "current-model",
      effort: "xhigh",
      timeout_secs: 30,
    }),
  ).toContain("does not support");

  expect(
    configurationError(d, {
      model: "unknown",
      effort: "high",
      timeout_secs: 30,
    }),
  ).toContain("not available");
});

it("uses automatic reasoning for Antigravity Claude models and never sends an unsupported effort flag", async () => {
  vi.mocked(capture).mockImplementation(async (_program, args) => ({
    duration_ms: 1,
    code: 0,
    stderr: "",
    stdout:
      args[0] === "models"
        ? "claude-opus-4-6-thinking\tClaude Opus\nclaude-sonnet-4-6\tClaude Sonnet\n"
        : "--mode --sandbox --effort --input-format --output-format --json-schema --conversation",
  }));

  const provider = new AntigravityProvider();
  const detection = await provider.detect("/tmp");
  for (const model of detection.models) {
    expect(model.supportedEfforts).toEqual(["default"]);

    expect(
      configurationError(detection, { model: model.id, effort: "high", timeout_secs: 30 }),
    ).toContain("does not support");

    expect(
      configurationError(detection, { model: model.id, effort: "default", timeout_secs: 30 }),
    ).toBeNull();

    const invocation = provider.invocation({
      runId: "test",
      cwd: "/tmp",
      stage: 0,
      access: "workspace-write",
      config: { model: model.id, effort: "default", timeout_secs: 30 },
      prompt: "Hello",
      schemaPath: "",
      schema: {},
      conversation: {},
    });

    expect(invocation.args).not.toContain("--effort");
  }
});
