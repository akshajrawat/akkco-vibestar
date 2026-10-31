// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { AgentTimeline } from "../../src/features/chat/AgentTimeline";
import { AgentResponse } from "../../src/features/chat/AgentResponse";
import { ChatSurface } from "../../src/features/chat/ChatSurface";
import { UserMessageBody } from "../../src/features/chat/UserMessageBody";
import { RunError } from "../../src/features/chat/RunError";
import { TaskWorkspace } from "../../src/features/tasks/TaskWorkspace";
import { agentEntries, toolState } from "../../src/features/chat/output/activity";
import { useConversationEvents } from "../../src/features/chat/output/useConversationEvents";
import { streamingSummary } from "../../src/features/chat/output/response";
import type { AgentEvent, Detail, Message, Run } from "../../src/lib/types";

vi.mock("../../src/components/shared/TaskTerminal", () => ({ TaskTerminal: () => null }));

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

it("keeps Thinking collapsible before tools arrive and preserves a disclosure on a plain completed reply", () => {
  const ui = render(<AgentTimeline compact runs={[run]} events={[]} />);
  const log = ui.container.querySelector<HTMLDetailsElement>(".work-log")!;
  expect(log.querySelector("summary")?.textContent).toBe("Thinking");
  expect(log.querySelector("summary svg")).not.toBeNull();
  expect(log.open).toBe(false);
  expect(log.textContent).toContain("Waiting for agent activity");

  ui.rerender(
    <AgentTimeline
      compact
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
      compact
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

vi.mock("../../src/hooks/useWorkspace", () => ({
  useProviders: () => ({ providers: [], refresh: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const run: Run = {
  id: "chat-run",
  stage: 1,
  purpose: "Read-only conversation",
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

const detail = (): Detail => ({
  task: {
    id: crypto.randomUUID(),
    repo_id: "repo",
    issue_number: 1,
    issue_url: "https://github.com/a/b/issues/1",
    claimed_scope: "scope",
    notes: "",
    issue: {},
    branch_name: "",
    base_branch: "main",
    base_commit_sha: "",
    worktree_path: "",
    created_at: run.started_at,
    updated_at: run.started_at,
    status: "not_started",
    stage: 0,
    error: null,
  },
  runs: [],
  events: [],
  messages: [],
  artifacts: [],
  tests: [],
});

it.each([false, true])(
  "shows a prompt before RPC settles and restores failed drafts without overwriting new typing (%s)",
  async (typeAhead) => {
    let reject!: (error: Error) => void;

    const pending = new Promise((_, fail) => {
      reject = fail;
    });

    const rpc = vi.fn((method: string) =>
      method === "task.chat" ? pending : Promise.resolve(null),
    );

    Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });
    const onError = vi.fn();
    render(<TaskWorkspace detail={detail()} revision={0} onError={onError} back={vi.fn()} />);
    const field = screen.getByLabelText<HTMLTextAreaElement>("Task conversation");
    fireEvent.change(field, { target: { value: "hello" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(screen.getByText("hello")).toBeTruthy();
    expect(field.value).toBe("");
    if (typeAhead) fireEvent.change(field, { target: { value: "new draft" } });
    await act(async () => reject(new Error("Submission refused")));
    expect(field.value).toBe(typeAhead ? "new draft" : "hello");
    expect(onError).toHaveBeenCalledWith("Submission refused");
    expect(document.querySelector(".user-message") !== null).toBe(typeAhead);
  },
);

it("reconciles an event echo before the submit response without duplicate user rows", async () => {
  let resolve!: (value: unknown) => void;

  const pending = new Promise((done) => {
    resolve = done;
  });

  const rpc = vi.fn((method: string) => (method === "task.chat" ? pending : Promise.resolve(null)));
  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });
  const initial = detail();

  const ui = render(
    <TaskWorkspace detail={initial} revision={0} onError={vi.fn()} back={vi.fn()} />,
  );

  fireEvent.change(screen.getByLabelText("Task conversation"), {
    target: { value: "one message" },
  });

  fireEvent.keyDown(screen.getByLabelText("Task conversation"), { key: "Enter" });

  const request = rpc.mock.calls.find(([method]) => method === "task.chat") as unknown as [
    string,
    { request_id: string },
  ];

  const message: Message = {
    id: request[1].request_id,
    content: "one message",
    role: "user",
    created_at: run.started_at,
    purpose: "chat",
    status: "chat_completed",
  };

  const echoed = { ...initial, messages: [message] };
  ui.rerender(<TaskWorkspace detail={echoed} revision={1} onError={vi.fn()} back={vi.fn()} />);
  await act(async () => resolve({ message, disposition: "chat_completed" }));
  expect(screen.getAllByText("one message")).toHaveLength(1);
});

it("streams a structured answer through stable message rows and reconciles the final output", () => {
  const ui = render(
    <AgentTimeline
      runs={[run]}
      events={[event(1, "message", { call_id: "answer", text_delta: '{"summary":"Hel' })]}
    />,
  );

  const row = ui.container.querySelector(".message-event");
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
  expect(ui.container.querySelector(".agent-avatar")).toBeNull();
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

it("reveals a new run error after dismissing an earlier one", () => {
  const ui = render(<RunError error="First error" run={run} />);
  fireEvent.click(screen.getByLabelText("Dismiss run notice"));
  expect(screen.queryByLabelText("Run failure")).toBeNull();
  ui.rerender(<RunError error="Second error" run={{ ...run, id: "next-run" }} />);
  expect(screen.getByLabelText("Run failure")).toBeTruthy();
});

it("keeps changed files with implementation when a later conversation starts", () => {
  const ui = render(
    <AgentTimeline
      runs={[{ ...run, id: "implementation", stage: 3, purpose: "Implementation" }, run]}
      events={[]}
      files={[
        {
          path: "source.ts",
          old_path: null,
          insertions: 1,
          deletions: 0,
          status: "M",
          staged: false,
          unstaged: true,
          binary: false,
        },
      ]}
    />,
  );

  const turns = ui.container.querySelectorAll(".agent-turn");
  expect(turns[0].querySelector(".chat-changes")).toBeTruthy();
  expect(turns[1].querySelector(".chat-changes")).toBeNull();
});

it("follows resizes, preserves history position and returns to latest on request", () => {
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
    activity: null,
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
    activity: null,
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

it.each([1, 2])("keeps stage %s structured plans folded in the conversation", (stage) => {
  const output = JSON.stringify({
    summary: "A concise plan",
    implementationSteps: ["Inspect the full plan in Workflow"],
  });

  const ui = render(
    <AgentTimeline
      expandResults={false}
      runs={[{ ...run, purpose: "Plan", stage, status: "completed", output }]}
      events={[event(1, "message", { call_id: "plan", text: output })]}
    />,
  );

  expect(screen.getByText("A concise plan")).toBeTruthy();

  expect(ui.container.querySelector<HTMLDetailsElement>(".agent-response details")?.open).toBe(
    false,
  );
});

const StreamedConversation = ({ id = "task", events }: { id?: string; events: AgentEvent[] }) => {
  const complete = useConversationEvents(id, "task", events, vi.fn());
  return <AgentTimeline runs={[run]} events={complete} />;
};

it("preserves the answer and its identity when the detail window drops earlier deltas", () => {
  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc: vi.fn() } });

  const ui = render(
    <StreamedConversation
      events={[event(1, "message", { call_id: "answer", text_delta: '{"summary":"First' })]}
    />,
  );

  const row = ui.container.querySelector(".message-event");

  ui.rerender(
    <StreamedConversation
      events={[event(2, "message", { call_id: "answer", text_delta: " and second" })]}
    />,
  );

  expect(screen.getByText("First and second")).toBeTruthy();
  expect(ui.container.querySelector(".message-event")).toBe(row);

  ui.rerender(
    <StreamedConversation
      id="another-task"
      events={[
        event(3, "message", { call_id: "answer", text_delta: '{"summary":"Another answer' }),
      ]}
    />,
  );

  expect(screen.getByText("Another answer")).toBeTruthy();
  expect(screen.queryByText("First and second")).toBeNull();
});

it("recovers a long streaming prefix after refresh through existing owner-checked event pages", async () => {
  const records = [
    event(1, "message", { call_id: "answer", text_delta: '{"summary":"First' }),
    ...Array.from({ length: 2999 }, (_, i) =>
      event(i + 2, "message", { call_id: "answer", text_delta: "x" }),
    ),
  ];

  const rpc = vi.fn(async (_method: string, params: { after: number }) => {
    const rows = records.filter((row) => row.id > params.after);
    return { events: rows.slice(0, 500), more: rows.length > 500 };
  });

  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });
  render(<StreamedConversation events={records.slice(-2000)} />);
  expect(await screen.findByText(`First${"x".repeat(2999)}`)).toBeTruthy();
  expect(rpc).toHaveBeenCalledWith("task.events", { id: "task", run_id: run.id, after: 0 });
  expect(rpc).toHaveBeenCalledTimes(6);
  expect(screen.getAllByText(`First${"x".repeat(2999)}`)).toHaveLength(1);
});

it("holds the visible answer while recovering a burst that outruns the detail window", async () => {
  const records = [
    event(1, "message", { call_id: "answer", text_delta: '{"summary":"First' }),
    ...Array.from({ length: 4999 }, (_, i) =>
      event(i + 2, "message", { call_id: "answer", text_delta: "x" }),
    ),
  ];

  const rpc = vi.fn(async (_method: string, params: { after: number }) => {
    const rows = records.filter((row) => row.id > params.after);
    return { events: rows.slice(0, 500), more: rows.length > 500 };
  });

  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });
  const ui = render(<StreamedConversation events={records.slice(0, 1999)} />);
  const row = ui.container.querySelector(".message-event");
  ui.rerender(<StreamedConversation events={records.slice(-2000)} />);
  expect(screen.getByText(`First${"x".repeat(1998)}`)).toBeTruthy();
  expect(await screen.findByText(`First${"x".repeat(4999)}`)).toBeTruthy();
  expect(ui.container.querySelector(".message-event")).toBe(row);
});

it("restores a sent instruction when the host saves it at an approval boundary", async () => {
  const rpc = vi.fn(async (method: string, params: { content?: string; request_id?: string }) =>
    method === "task.followup"
      ? {
          disposition: "draft",
          message: {
            id: params.request_id,
            role: "user",
            content: params.content,
            status: "draft",
            created_at: run.started_at,
          },
        }
      : null,
  );

  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });
  const value = detail();
  value.task.status = "awaiting_approval";
  value.task.stage = 1;
  render(<TaskWorkspace detail={value} revision={0} onError={vi.fn()} back={vi.fn()} />);
  const field = screen.getByLabelText<HTMLTextAreaElement>("Task conversation");
  fireEvent.change(field, { target: { value: "Keep this instruction pending" } });
  fireEvent.click(screen.getByRole("button", { name: "Send to workflow" }));
  await vi.waitFor(() => expect(field.value).toBe("Keep this instruction pending"));

  expect(rpc).toHaveBeenCalledWith(
    "task.followup",
    expect.objectContaining({ content: "Keep this instruction pending" }),
  );

  expect(screen.getByRole("button", { name: "Instruction saved" })).toBeTruthy();
});

it("shows the idle welcome without duplicating the issue brief", () => {
  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: { rpc: vi.fn(async () => null) },
  });

  const data = detail();

  data.task.issue = {
    title: "Issue title in header",
    body: "Long issue body stays out of the idle transcript",
  };

  data.task.notes = "Scoped notes";
  const ui = render(<TaskWorkspace detail={data} revision={0} onError={vi.fn()} back={vi.fn()} />);
  expect(screen.getByText("Let’s start building.")).toBeTruthy();
  expect(ui.container.querySelector(".context-message")).toBeNull();
  expect(screen.queryByText("Long issue body stays out of the idle transcript")).toBeNull();
});

it("shows workflow briefs as user messages and keeps the complete plan in the reply", () => {
  const output = JSON.stringify({
    summary: "A complete plan",
    implementationSteps: ["Reuse the existing helper", "Run the required regression"],
  });

  const ui = render(
    <AgentTimeline
      compact
      showPrompts
      runs={[
        {
          ...run,
          purpose: "Plan",
          prompt: "This is the issue : Fix the interaction",
          status: "completed",
          ended_at: "2026-10-29T00:00:18Z",
          output,
        },
      ]}
      events={[]}
    />,
  );

  expect(ui.container.querySelector(".user-message")?.textContent).toBe(
    "This is the issue : Fix the interaction",
  );

  expect(screen.getByText("Worked for 18s")).toBeTruthy();
  expect(screen.getByText("Reuse the existing helper")).toBeTruthy();
  expect(screen.getByText("Run the required regression")).toBeTruthy();
  expect(screen.queryByText("View result details")).toBeNull();
  expect(ui.container.querySelector(".turn-outcome")).toBeNull();
});

it("collapses completed work while leaving the answer visible and omits protocol metadata", () => {
  const output = JSON.stringify({ summary: "You’re using Akkco Vibestar." });

  const ui = render(
    <AgentTimeline
      compact
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
  expect(ui.container.textContent).not.toContain("Duration not reported");
  expect(ui.container.textContent).not.toContain("Technical details");
  expect(ui.container.textContent).not.toContain("Copy tool details");
  expect(ui.container.querySelector(".turn-outcome")).toBeNull();
  fireEvent.click(log.querySelector("summary")!);
  expect(log.querySelector(".tool-event")?.textContent).toContain("node --test");
});

it("requests explicit workspace access from the ordinary composer after final review", async () => {
  const rpc = vi.fn(async () => ({ disposition: "chat_pending" }));
  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });
  const data = detail();
  data.task.stage = 6;
  data.task.status = "reviewed_with_gaps";
  render(<TaskWorkspace detail={data} revision={0} onError={vi.fn()} back={vi.fn()} />);
  const field = screen.getByLabelText("Task conversation");
  fireEvent.change(field, { target: { value: "Okay, fix those findings" } });
  fireEvent.keyDown(field, { key: "Enter" });

  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "task.chat",
      expect.objectContaining({
        content: "Okay, fix those findings",
        configuration: expect.objectContaining({ access: "workspace" }),
      }),
    ),
  );
});
