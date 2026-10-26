import { it, expect, vi, beforeEach } from "vitest";
import { AntigravityProvider } from "../../backend/execution/providers/antigravity";
import { CodexProvider } from "../../backend/execution/providers/codex";
import { capture, checked } from "../../backend/execution/runtime/process";
import { configurationError } from "../../backend/execution/providers/contracts";
vi.mock("../../backend/execution/runtime/process", () => ({
  capture: vi.fn(),
  checked: vi.fn(),
}));
vi.mock("../../backend/execution/providers/codex-models", () => ({
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
          : "--mode --sandbox --effort --output-format --json-schema",
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
    stdout: "--mode --sandbox --effort --output-format --json-schema",
    stderr: "Sign in required",
  }));
  expect(await new AntigravityProvider().detect("/tmp")).toMatchObject({
    installed: true,
    connected: false,
    models: [],
    error: "Sign in required",
  });
});
it("requires explicit capabilities for newly discovered unsuffixed Antigravity models", async () => {
  vi.mocked(capture).mockImplementation(async (_program, args) => ({
    duration_ms: 1,
    code: 0,
    stdout:
      args[0] === "models"
        ? "future-model\tFuture model\n"
        : "--mode --sandbox --effort --output-format --json-schema",
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
