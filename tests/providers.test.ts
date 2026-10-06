import { it, expect } from "vitest";
import { CodexProvider } from "../backend/execution/providers/codex";
import { AntigravityProvider } from "../backend/execution/providers/antigravity";
import {
  verifyFlags,
  validatePlan,
} from "../backend/execution/providers/contracts";
const codex = new CodexProvider();
const agy = new AntigravityProvider();
it("normalizes official Codex JSONL and conversation identity", () => {
  expect(
    codex.normalize({
      type: "item.started",
      item: { type: "command_execution", command: "git status" },
    })[0].kind,
  ).toBe("command.started");
  expect(
    codex.normalize({
      type: "item.completed",
      item: { type: "file_change" },
    })[0].kind,
  ).toBe("file.changed");
  expect(codex.normalize({ type: "turn.failed", error: "quota" })[0].kind).toBe(
    "run.failed",
  );
  expect(codex.conversationId({ thread_id: "thread" })).toBe("thread");
  expect(
    codex.result({
      type: "item.completed",
      item: { type: "agent_message", text: '{"goal":"x"}' },
    }),
  ).toEqual({ goal: "x" });
});
it("normalizes observed Antigravity event envelopes and nested output", () => {
  expect(
    agy.normalize({
      event: "step_update",
      step_update: { step_type: "user_input", state: "DONE" },
    }),
  ).toEqual([]);
  expect(
    agy.normalize({ event: "init", init: { model: "chosen" } })[0].kind,
  ).toBe("run.started");
  expect(
    agy.normalize({
      event: "step_update",
      step_update: { step_type: "agent_response", text_delta: "plan" },
    })[0].kind,
  ).toBe("message");
  const final = {
    event: "result",
    result: {
      status: "SUCCESS",
      conversation_id: "session",
      structured_output: { summary: "plan" },
    },
  };
  expect(agy.result(final)).toEqual({ summary: "plan" });
  expect(agy.normalize(final)[0].kind).toBe("run.completed");
  expect(
    agy.normalize({
      event: "step_update",
      step_update: {
        step_type: "tool",
        tool_name: "run_command",
        step_index: 2,
        state: "ERROR",
        tool_info: {
          parameters: { CommandLine: "ls -la" },
          error: { message: "sandbox connection failed" },
        },
      },
    })[0],
  ).toMatchObject({
    kind: "command.finished",
    data: {
      status: "failed",
      stderr: "sandbox connection failed",
      command: "ls -la",
    },
  });
  expect(agy.conversationId(final)).toBe("session");
  expect(
    agy.normalize({
      event: "result",
      result: { status: "ERROR", error: "quota" },
    })[0].kind,
  ).toBe("run.failed");
});
it("does not disable real Antigravity plan mode or bypass permissions", () => {
  const request = {
    runId: "run",
    cwd: "/worktree",
    stage: 1,
    config: { model: "chosen", effort: "high", timeout_secs: 60 },
    prompt: "plan",
    schemaPath: "/artifact",
    schema: {},
  };
  const invocation = agy.invocation(request);
  expect(invocation.args).toContain("plan");
  expect(invocation.args).not.toContain("--disable-slash-commands");
  expect(invocation.args).not.toContain("--dangerously-skip-permissions");
  const args = codex.invocation({ ...request, stage: 2 }).args;
  expect(args).toContain("read-only");
  expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(codex.invocation({ ...request, stage: 3 }).args).toContain(
    "workspace-write",
  );
});
it("rejects missing flags and malformed plans", () => {
  expect(() => verifyFlags("--json", ["--json", "--sandbox"])).toThrow();
  expect(() => validatePlan(1, { summary: "missing fields" })).toThrow();
});
