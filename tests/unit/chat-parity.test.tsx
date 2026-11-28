// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { AgentTimeline } from "../../apps/desktop/features/chat/AgentTimeline";
import { AgentResponse } from "../../apps/desktop/features/chat/AgentResponse";
import { ChatSurface } from "../../apps/desktop/features/chat/ChatSurface";
import { UserMessageBody } from "../../apps/desktop/features/chat/UserMessageBody";
import { RunError } from "../../apps/desktop/features/chat/RunError";
import { agentEntries, toolState } from "../../apps/desktop/features/chat/output/activity";
import { streamingSummary } from "../../apps/desktop/features/chat/output/response";
import type { AgentEvent, Run } from "../../apps/desktop/lib/types";

it("keeps a long prompt compact and lets the user expand and collapse its complete text", () => {
  let resized: ResizeObserverCallback = () => {};

  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resized = callback;
      }

      observe() {}

      disconnect() {}
    },
  );

  const ui = render(
    <UserMessageBody>
      <p>{"A long issue with comments. ".repeat(100)}</p>
    </UserMessageBody>,
  );

  const body = ui.container.querySelector<HTMLElement>(".user-message-body")!;
  Object.defineProperties(body, { scrollHeight: { value: 1000 }, clientHeight: { value: 240 } });
  act(() => resized([], {} as ResizeObserver));
  const more = screen.getByRole("button", { name: "Show more" });
  expect(more.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(more);
  expect(body.classList.contains("expanded")).toBe(true);

  expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe(
    "true",
  );

  fireEvent.click(screen.getByRole("button", { name: "Show less" }));
  expect(body.classList.contains("expanded")).toBe(false);
});

it("keeps the working indicator collapsible before tools arrive and preserves a disclosure on a plain completed reply", () => {
  const ui = render(<AgentTimeline runs={[run]} events={[]} />);
  const log = ui.container.querySelector<HTMLDetailsElement>(".work-log")!;
  expect(log.querySelector("summary")?.textContent).toBe("Working…");
  expect(log.querySelector("summary svg")).not.toBeNull();
  expect(log.open).toBe(false);
  expect(log.textContent).toContain("Waiting for agent activity");

  ui.rerender(
    <AgentTimeline
      runs={[run]}
      events={[
        event(1, "message", {
          call_id: "update",
          phase: "commentary",
          text: "I’m checking the workspace.",
        }),
      ]}
    />,
  );

  expect(screen.getByText("I’m checking the workspace.").closest(".work-log")).toBe(log);
  expect(log.open).toBe(true);

  ui.rerender(
    <AgentTimeline
      runs={[
        {
          ...run,
          status: "completed",
          ended_at: "2026-10-29T00:00:18Z",
          output: "Ready to build.",
        },
      ]}
      events={[]}
    />,
  );

  expect(log.open).toBe(false);
  expect(log.querySelector("summary")?.textContent).toBe("Worked for 18s");
  expect(screen.getByText("Ready to build.").closest(".work-log")).toBeNull();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const run: Run = {
  id: "chat-run",
  stage: 0,
  provider: "codex",
  model: "fixture",
  effort: "low",
  prompt: "INTERNAL_PROMPT",
  status: "running",
  started_at: "2026-10-29T00:00:00Z",
  ended_at: null,
  exit_code: null,
  pid: null,
  conversation_id: null,
  output: null,
  error: null,
};

const event = (id: number, kind: string, data: unknown): AgentEvent => ({
  id,
  kind,
  data: JSON.stringify(data),
  raw: JSON.stringify(data),
  stream: "stdout",
  run_id: run.id,
  task_id: "task",
  timestamp: run.started_at,
});

it("streams a structured answer through stable message rows and reconciles the final output", () => {
  const ui = render(
    <AgentTimeline
      runs={[run]}
      events={[event(1, "message", { call_id: "answer", text_delta: '{"summary":"Hel' })]}
    />,
  );

  const row = screen.getByText("Hel").closest(".message-event");
  expect(screen.getByText("Hel")).toBeTruthy();

  ui.rerender(
    <AgentTimeline
      runs={[run]}
      events={[
        event(1, "message", { call_id: "answer", text_delta: '{"summary":"Hel' }),
        event(2, "message", { call_id: "answer", text_delta: 'lo"}' }),
      ]}
    />,
  );

  expect(ui.container.querySelector(".message-event")).toBe(row);
  const output = JSON.stringify({ summary: "Hello" });

  ui.rerender(
    <AgentTimeline
      runs={[{ ...run, status: "completed", output }]}
      events={[event(2, "message", { call_id: "answer", text: output })]}
    />,
  );

  expect(screen.getAllByText("Hello")).toHaveLength(1);
  expect(screen.queryByText("INTERNAL_PROMPT")).toBeNull();
});

it("retains saved assistant answers on recovery when a matching run has no message output", () => {
  render(
    <AgentTimeline
      runs={[{ ...run, status: "cancelled" }]}
      events={[]}
      messages={[
        {
          id: "saved-answer",
          role: "assistant",
          run_id: run.id,
          content: "Recovered answer",
          created_at: run.started_at,
        },
      ]}
    />,
  );

  expect(screen.getByText("Recovered answer")).toBeTruthy();
});

it("orders paged tool events and preserves terminal status when late output arrives", () => {
  const start = event(1, "command.started", {
    call_id: "command",
    command: "npm test",
    status: "running",
  });

  const finish = event(3, "command.finished", {
    call_id: "command",
    exit_code: 1,
    status: "failed",
  });

  const output = event(4, "command.output", {
    call_id: "command",
    stdout: "assertion failed",
    status: "running",
  });

  const rows = agentEntries([finish, start, output, start]);
  expect(rows).toHaveLength(1);
  expect(rows[0].key).toBe("chat-run/command");
  expect(rows[0].data.stdout).toBe("assertion failed");
  expect(toolState(rows[0].event, rows[0].data, run)).toBe("failed");
  const ui = render(<AgentTimeline runs={[{ ...run, status: "cancelled" }]} events={[start]} />);
  expect(ui.container.querySelector('[data-state="interrupted"]')).toBeTruthy();
});

it("shows a pending command before execution starts", () => {
  const pending = event(1, "command.output", {
    call_id: "command",
    command: "npm test",
    status: "pending",
  });

  const running = event(2, "command.started", { call_id: "command", status: "in_progress" });
  const view = render(<AgentTimeline runs={[run]} events={[pending]} />);

  expect(screen.getByText("Command pending")).toBeTruthy();
  view.rerender(<AgentTimeline runs={[run]} events={[pending, running]} />);
  expect(screen.getByText("Running command")).toBeTruthy();
});

it("keeps the current run error visible and updates when the error changes", () => {
  const ui = render(<RunError error="First error" run={run} />);
  expect(screen.getByText("First error")).toBeTruthy();
  expect(screen.queryByLabelText("Dismiss run notice")).toBeNull();
  ui.rerender(<RunError error="Second error" run={run} />);
  expect(screen.queryByText("First error")).toBeNull();
  expect(screen.getByText("Second error")).toBeTruthy();
});

it("guides users to /clear when native thread recovery fails", () => {
  const error = "Native thread not found after an interrupted connection";
  const ui = render(<RunError error={error} run={{ ...run, status: "failed" }} />);
  expect(screen.getByText(/send \/clear to start a new thread/i)).toBeTruthy();
  expect(screen.getByLabelText("Run failure")).toBeTruthy();

  ui.rerender(<RunError error={error} run={{ ...run, status: "cancelled" }} />);
  expect(screen.getByText("Response stopped.")).toBeTruthy();
  expect(screen.getByLabelText("Cancelled run")).toBeTruthy();
});

it("recognizes interruption text when there is no specific recovery guidance", () => {
  render(<RunError error="The response was interrupted" />);
  expect(screen.getByText("Response stopped.")).toBeTruthy();
});

it("keeps scroll position while reading older messages and jumps to the latest on request", () => {
  let resized: ResizeObserverCallback = () => {};

  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resized = callback;
      }

      observe() {}

      disconnect() {}
    },
  );

  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });

  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const id = crypto.randomUUID();

  const props = {
    id,
    conversation: <p>First chunk</p>,
    composer: <textarea />,
    revision: 0,
  };

  const ui = render(<ChatSurface {...props} />);
  const scroller = screen.getByLabelText("Conversation");
  let height = 1000;

  Object.defineProperties(scroller, {
    scrollHeight: { get: () => height },
    clientHeight: { value: 300 },
  });

  act(() => resized([], {} as ResizeObserver));
  expect(scroller.scrollTop).toBe(1000);
  scroller.scrollTop = 100;
  fireEvent.scroll(scroller);
  height = 1200;
  ui.rerender(<ChatSurface {...props} revision={1} conversation={<p>Next chunk</p>} />);
  act(() => resized([], {} as ResizeObserver));
  expect(scroller.scrollTop).toBe(100);
  fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
  expect(scroller.scrollTop).toBe(1200);
});

it("decodes streaming escapes without leaking fragments or hiding ordinary braces", () => {
  expect(streamingSummary('{"summary":"hello\\nwor')).toBe("hello\nwor");
  expect(streamingSummary('{"summary":"hello\\u00')).toBe("hello");
  render(<AgentResponse text="{example} is literal text" />);
  expect(screen.getByText("{example} is literal text")).toBeTruthy();
});

it("keeps a new prompt and its response in the natural document flow without a spacer", () => {
  let resized: ResizeObserverCallback = () => {};

  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resized = callback;
      }

      observe() {}

      disconnect() {}
    },
  );

  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });

  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const id = crypto.randomUUID();

  const props = {
    id,
    conversation: <article data-message-id="next">A new prompt</article>,
    composer: <textarea />,
    revision: 0,
  };

  const ui = render(<ChatSurface {...props} />);
  const scroller = screen.getByLabelText("Conversation");
  const content = ui.container.querySelector<HTMLElement>(".timeline-content")!;
  let bodyHeight = 600;

  Object.defineProperties(scroller, {
    clientHeight: { value: 300 },
    scrollHeight: { get: () => bodyHeight },
  });

  ui.rerender(<ChatSurface {...props} revision={1} />);
  expect(scroller.scrollTop).toBe(600);
  expect(content.nextElementSibling).toBeNull();
  bodyHeight = 1000;
  act(() => resized([], {} as ResizeObserver));
  expect(scroller.scrollTop).toBe(1000);
});

it("does not repeat a final answer when the provider emits prose and a separate structured result", () => {
  const output = JSON.stringify({ summary: "One final answer" });

  render(
    <AgentTimeline
      runs={[{ ...run, status: "completed", output }]}
      events={[
        event(1, "message", { call_id: "prose", text: "One final answer" }),
        event(2, "message", { call_id: "structured", text: output }),
      ]}
    />,
  );

  expect(screen.getAllByText("One final answer")).toHaveLength(1);
});

it("keeps structured result details visible in a completed reply", () => {
  const output = JSON.stringify({
    summary: "A complete plan",
    implementationSteps: ["Reuse the existing helper", "Run the required regression"],
  });

  render(
    <AgentTimeline
      runs={[
        {
          ...run,
          status: "completed",
          ended_at: "2026-10-29T00:00:18Z",
          output,
        },
      ]}
      events={[]}
    />,
  );

  expect(screen.getByText("Worked for 18s")).toBeTruthy();
  expect(screen.getByText("Reuse the existing helper")).toBeTruthy();
  expect(screen.getByText("Run the required regression")).toBeTruthy();
  expect(screen.queryByText("View result details")).toBeNull();
});

it("collapses completed work while leaving the answer visible and omits protocol metadata", () => {
  const output = JSON.stringify({ summary: "You’re using Akkco Vibestar." });

  const ui = render(
    <AgentTimeline
      runs={[{ ...run, status: "completed", ended_at: "2026-10-29T00:00:18Z", output }]}
      events={[
        event(1, "analysis.status", { tool: "userMessage", status: "completed" }),
        event(2, "command.finished", {
          call_id: "command",
          command: "node --test",
          status: "completed",
          exit_code: 0,
        }),
        event(3, "message", { call_id: "final", text: output }),
      ]}
    />,
  );

  const log = ui.container.querySelector<HTMLDetailsElement>(".work-log")!;
  expect(log.open).toBe(false);
  expect(log.querySelector("summary")?.textContent).toBe("Worked for 18s");
  expect(screen.getByText("You’re using Akkco Vibestar.").closest(".work-log")).toBeNull();
  expect(ui.container.textContent).not.toContain("userMessage");
  fireEvent.click(log.querySelector("summary")!);
  expect(log.querySelector(".tool-event")?.textContent).toContain("node --test");
});

it("keeps streamed reasoning together across usage updates and splits it around tool activity", () => {
  const ui = render(
    <AgentTimeline
      runs={[run]}
      events={[
        event(1, "analysis.status", { text_delta: "The user" }),
        event(2, "analysis.status", { usage: { sessionUpdate: "usage_update", outputTokens: 7 } }),
        event(3, "analysis.status", { text_delta: " " }),
        event(4, "analysis.status", { text_delta: "wants to open the desktop." }),
        event(5, "command.finished", { command: "ls", exit_code: 0 }),
        event(6, "analysis.status", { text_delta: "The workspace is ready." }),
      ]}
    />,
  );

  const thoughts = ui.container.querySelectorAll<HTMLDetailsElement>(".reasoning-event");

  expect(
    Array.from(thoughts, (entry) => entry.querySelector("summary")?.textContent?.trim()),
  ).toEqual(["The user wants to open the desktop.", "The workspace is ready."]);

  expect(thoughts[0].nextElementSibling?.classList.contains("tool-event")).toBe(true);
  expect(thoughts[0].open).toBe(false);
});
