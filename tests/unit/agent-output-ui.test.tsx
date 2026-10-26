// @vitest-environment jsdom
import { it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, act } from "@testing-library/react";

import { LogView } from "../../src/features/chat/LogView";
import { AgentTimeline } from "../../src/features/chat/AgentTimeline";
import { AgentResponse } from "../../src/features/chat/AgentResponse";
import { CurrentRun } from "../../src/features/chat/CurrentRun";
import { TaskWorkspace } from "../../src/features/tasks/TaskWorkspace";
import { updateTaskView } from "../../src/lib/taskView";
import type { AgentEvent, Detail, Run } from "../../src/lib/types";

vi.mock("../../src/hooks/useWorkspace", () => ({
  useProviders: () => ({ providers: [], refresh: vi.fn() }),
}));

vi.mock("../../src/components/shared/TaskTerminal", () => ({
  TaskTerminal: () => <p>Fixture terminal</p>,
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const run: Run = {
  id: "run",
  stage: 3,
  provider: "codex",
  model: "actual-model",
  effort: "xhigh",
  prompt: "Exact saved prompt\nWith a second line",
  status: "running",
  started_at: "2026-10-14T10:00:00Z",
  ended_at: null,
  exit_code: null,
  pid: 42,
  conversation_id: "session",
  output: null,
  error: null,
};

const event = (id: number, kind: string, data: unknown, stream = "stdout"): AgentEvent => ({
  id,
  kind,
  data: JSON.stringify(data),
  stream,
  run_id: run.id,
  task_id: "task",
  timestamp: run.started_at,
  raw: JSON.stringify(data),
});

const detail = (id: string): Detail => ({
  task: {
    id,
    repo_id: "repo",
    issue_number: 1,
    issue_url: "https://github.com/a/b/issues/1",
    claimed_scope: "file.ts",
    notes: "",
    issue: {},
    branch_name: "owned",
    base_branch: "main",
    base_commit_sha: "abc",
    worktree_path: "",
    created_at: run.started_at,
    updated_at: run.started_at,
    stage: 3,
    status: "implementing",
    error: null,
  },
  runs: [run],
  events: [],
  messages: [],
  artifacts: [],
  tests: [],
});

it.each([
  ["npm install --save-dev @playwright/test", 130, "interrupted"],
  ["npm ci", 1, "blocked"],
  ["npm run lint", 1, "failed"],
  ["node --test", 130, "failed"],
  ["npm install && npm test", 130, "failed"],
])(
  "keeps command cards consistent with conservative setup classification: %s",
  (command, exit_code, state) => {
    const ui = render(
      <AgentTimeline
        events={[
          event(1, "command.finished", {
            command,
            exit_code,
            status: "failed",
          }),
        ]}
        runs={[run]}
      />,
    );

    const card = ui.container.querySelector(`.tool-event[data-state="${state}"]`);
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain(`Exit ${exit_code}`);
    expect(card?.textContent).toContain('"status": "failed"');
    expect(card?.querySelector(".success")).toBeNull();
  },
);

const bridge = (
  handler: (
    method: string,
    params: {
      id?: string;
      search?: string;
      before?: number;
      stream?: string;
      content?: string;
    },
  ) => Promise<unknown> = async () => null,
) => {
  const rpc = vi.fn(handler);

  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: { rpc },
  });

  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });

  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  });

  return rpc;
};

it("renders streamed messages, tool arguments and separate live streams, and never succeeds unfinished or explicitly interrupted tools", () => {
  bridge();

  const initial = [
    event(1, "message", { call_id: "message", text_delta: "Inspecting " }),
    event(2, "command.started", {
      call_id: "command",
      tool: "Bash",
      command: "npm test",
      arguments: { cwd: "src", timeout: 20 },
      status: "RUNNING",
    }),
  ];

  const ui = render(<AgentTimeline runs={[run]} events={initial} />);
  expect(screen.getByText("Inspecting")).toBeTruthy();
  expect(ui.container.querySelector("[data-state=running]")).toBeTruthy();

  ui.rerender(
    <AgentTimeline
      runs={[run]}
      events={[
        ...initial,
        event(3, "message", {
          call_id: "message",
          text_delta: "the repository.",
        }),
        event(4, "command.output", {
          call_id: "command",
          stdout: "one check passed",
          stderr: "compiler warning",
        }),
        event(5, "command.output", { stderr: "provider diagnostic" }, "stderr"),
      ]}
    />,
  );

  expect(screen.getByText("Inspecting the repository.")).toBeTruthy();
  expect(screen.getByText("one check passed")).toBeTruthy();
  expect(screen.getByText("compiler warning")).toBeTruthy();
  expect(screen.getByText("provider diagnostic")).toBeTruthy();
  expect(ui.container.querySelector(".tool-facts")?.textContent).toContain('"timeout": 20');
  ui.rerender(<AgentTimeline runs={[{ ...run, status: "cancelled" }]} events={initial} />);
  expect(ui.container.querySelector(".tool-event[data-state=interrupted]")).toBeTruthy();
  expect(ui.container.querySelector(".tool-event .success")).toBeNull();

  ui.rerender(
    <AgentTimeline
      runs={[{ ...run, status: "completed" }]}
      events={[
        ...initial,
        event(6, "command.finished", {
          call_id: "command",
          status: "interrupted",
          exit_code: 0,
        }),
      ]}
    />,
  );

  expect(ui.container.querySelector(".tool-event[data-state=interrupted]")).toBeTruthy();
  expect(ui.container.querySelector(".tool-event .success")).toBeNull();

  ui.rerender(
    <AgentTimeline
      runs={[run]}
      events={[
        event(7, "command.finished", {
          command: "npm test",
          call_id: "failed",
          exit_code: 1,
          duration_ms: 2500,
        }),
      ]}
    />,
  );

  expect(ui.container.querySelector(".tool-event[data-state=failed]")).toBeTruthy();
  expect(screen.getByText("Exit 1")).toBeTruthy();
  expect(screen.getByText("3s")).toBeTruthy();
});

it("shows actual execution independently from follow-up selection and keeps the status strip across task tabs", () => {
  bridge();
  const data = detail("status-strip");

  updateTaskView(data.task.id, {
    followupModel: "composer-model",
    followupProvider: "antigravity",
    followupEffort: "low",
  });

  const ui = render(<TaskWorkspace detail={data} revision={0} onError={vi.fn()} back={vi.fn()} />);
  const current = screen.getByLabelText("Current agent run");
  expect(current.textContent).toContain("actual-model");
  expect(current.textContent).toContain("xhigh");
  expect(current.textContent).not.toContain("composer-model");
  expect(screen.queryByRole("tab", { name: "Chat" })).toBeNull();
  fireEvent.click(screen.getByLabelText("Toggle secondary workspace"));
  const pipeline = screen.getByRole("tab", { name: "Workflow" });
  pipeline.focus();
  fireEvent.keyDown(pipeline, { key: "ArrowRight" });
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Plans" }));
  expect(screen.getByRole("tab", { name: "Plans" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByLabelText("Current agent run")).toBe(current);
  expect(ui.container.querySelector("aside")?.contains(current)).toBe(false);
  fireEvent.click(screen.getByLabelText("Collapse secondary workspace"));
  expect(screen.getByLabelText("Current agent run")).toBe(current);

  ui.rerender(
    <TaskWorkspace
      detail={{
        ...data,
        task: { ...data.task, status: "awaiting_approval" },
        runs: [{ ...run, status: "completed" }],
      }}
      revision={1}
      onError={vi.fn()}
      back={vi.fn()}
    />,
  );

  expect(screen.getByLabelText("Current agent run").textContent).toContain("completed");
  expect(screen.getByLabelText("Current agent run").textContent).not.toContain("running");
});

it("shows provider-emitted failures and status text while the CLI is still running without synthesizing progress", () => {
  bridge();

  render(
    <AgentTimeline
      runs={[run]}
      filter="errors"
      events={[
        event(1, "analysis.status", { text: "Provider emitted status" }),
        event(2, "run.failed", {
          error: { message: "Official provider quota error" },
        }),
      ]}
    />,
  );

  expect(screen.getByText("Provider error")).toBeTruthy();
  expect(screen.getByText("Official provider quota error")).toBeTruthy();
  expect(screen.queryByText("Provider emitted status")).toBeNull();
});

it("pages historical tools with completion context, searches saved events, filters and copies exact saved prompts", async () => {
  const id = "historical-output";

  const start = event(1, "command.started", {
    call_id: "old",
    command: "old command",
    arguments: { file: "old.ts" },
    status: "running",
  });

  const finish = event(800, "command.finished", {
    call_id: "old",
    exit_code: 0,
    status: "completed",
  });

  start.raw = JSON.stringify({
    type: "item.started",
    item: { arguments: { unknownParameter: "needle in retained raw fields" } },
  });

  const rpc = bridge(
    vi.fn(async (method, params) =>
      method === "task.events"
        ? params.search
          ? { events: [start], context: [start, finish], more: false }
          : params.before
            ? { events: [start], context: [finish], more: false }
            : { events: [finish], context: [start, finish], more: true }
        : null,
    ),
  );

  const ui = render(<LogView taskId={id} runs={[{ ...run, status: "completed" }]} events={[]} />);
  expect(await screen.findByText("Load earlier output")).toBeTruthy();
  expect(ui.container.querySelector(".tool-event[data-state=completed]")).toBeTruthy();
  fireEvent.click(screen.getByText("Load earlier output"));

  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("task.events", expect.objectContaining({ before: 800 })),
  );

  const search = screen.getByLabelText("Search saved output");
  search.focus();
  fireEvent.change(search, { target: { value: "needle" } });
  expect(document.activeElement).toBe(search);

  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("task.events", expect.objectContaining({ search: "needle" })),
  );

  expect(ui.container.querySelector(".tool-event[data-state=completed]")).toBeTruthy();

  fireEvent.change(screen.getByLabelText("Output filter"), {
    target: { value: "messages" },
  });

  expect(ui.container.querySelector(".tool-event")).toBeNull();
  fireEvent.keyDown(search, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Saved prompt" }));
  expect(screen.getByLabelText("Agent output transcript").textContent).toContain(run.prompt);
  fireEvent.click(screen.getByRole("button", { name: "Copy output" }));
  await vi.waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(run.prompt));
});

it("keeps raw stdout/stderr distinct, follows streamed updates, rejects late data after task switching and persists per-task output preferences", async () => {
  let release!: (value: unknown) => void;

  const pending = new Promise((resolve) => {
    release = resolve;
  });

  const rpc = bridge(
    vi.fn(async (method, params) =>
      method === "task.logs"
        ? params.id === "switch-a" && params.stream === "stdout"
          ? pending
          : {
              text: `${params.id} ${params.stream}`,
              truncated: false,
              start: 0,
              end: 20,
              size: 20,
            }
        : { events: [], more: false },
    ),
  );

  updateTaskView("switch-a", {
    outputView: "raw",
    outputStream: "stdout",
    outputFollow: true,
  });

  const ui = render(<LogView taskId="switch-a" runs={[run]} events={[]} />);

  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("task.logs", expect.objectContaining({ stream: "stdout" })),
  );

  ui.rerender(<LogView taskId="switch-b" runs={[{ ...run, id: "run-b" }]} events={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "Raw" }));

  fireEvent.change(screen.getByLabelText("Raw output stream"), {
    target: { value: "stderr" },
  });

  expect(await screen.findByText("switch-b stderr")).toBeTruthy();

  release({
    text: "stale task a",
    start: 0,
    end: 12,
    size: 12,
    truncated: false,
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByText("stale task a")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Pause scrolling" }));
  const transcript = screen.getByLabelText("Agent output transcript");
  fireEvent.keyDown(transcript, { key: "f", ctrlKey: true });
  expect(document.activeElement).toBe(screen.getByLabelText("Search saved output"));
  fireEvent.keyDown(transcript, { key: "End", ctrlKey: true });
  expect(screen.getByRole("button", { name: "Pause scrolling" })).toBeTruthy();
  const saved = JSON.parse(localStorage.getItem("vibestar.layout.switch-b")!);

  expect(saved).toMatchObject({
    outputView: "raw",
    outputStream: "stderr",
    outputFollow: true,
  });

  ui.rerender(<LogView taskId="switch-a" runs={[run]} events={[]} />);
  expect((screen.getByLabelText("Raw output stream") as HTMLSelectElement).value).toBe("stdout");
  ui.rerender(<LogView taskId="switch-b" runs={[{ ...run, id: "run-b" }]} events={[]} />);
  expect((screen.getByLabelText("Raw output stream") as HTMLSelectElement).value).toBe("stderr");
});

it("continues capturing raw output while scrolling is paused and drains event bursts after run completion", async () => {
  vi.useFakeTimers();
  const id = "live-stream-paused";
  updateTaskView(id, { outputView: "raw", outputStream: "stdout" });
  let calls = 0;

  const rpc = bridge(async (method) =>
    method === "task.logs"
      ? ++calls === 1
        ? {
            text: "first line\n",
            start: 0,
            end: 11,
            size: 11,
            truncated: false,
          }
        : {
            text: "live second line\n",
            start: 11,
            end: 28,
            size: 28,
            truncated: false,
          }
      : { events: [], more: false },
  );

  const ui = render(<LogView taskId={id} runs={[run]} events={[]} />);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });

  expect(screen.getByText("first line")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Pause scrolling" }));
  vi.mocked(HTMLElement.prototype.scrollTo).mockClear();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });

  expect(screen.getByLabelText("Agent output transcript").textContent).toContain(
    "live second line",
  );

  expect(HTMLElement.prototype.scrollTo).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledWith("task.logs", expect.objectContaining({ after: 11 }));
  fireEvent.click(screen.getByRole("button", { name: "Follow output" }));
  expect(HTMLElement.prototype.scrollTo).toHaveBeenCalled();
  cleanup();
  let pages = 0;

  const burstRpc = bridge(async () =>
    ++pages === 1
      ? {
          events: [event(1, "message", { text: "initial message" })],
          more: false,
        }
      : pages === 2
        ? {
            events: [event(2, "message", { text: "burst first page" })],
            more: true,
          }
        : {
            events: [event(3, "message", { text: "burst final page" })],
            more: false,
          },
  );

  const burst = render(<LogView taskId="completed-burst" runs={[run]} events={[]} />);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });

  burst.rerender(
    <LogView taskId="completed-burst" runs={[{ ...run, status: "completed" }]} events={[]} />,
  );

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });

  expect(screen.getByText("burst final page")).toBeTruthy();
  expect(burstRpc).toHaveBeenCalledWith("task.events", expect.objectContaining({ after: 2 }));
  ui.unmount();
});

it("restores persisted layouts and contains prompt dialog focus while preserving composer IME and newline behavior", async () => {
  const id = "persisted-layout";

  localStorage.setItem(
    `vibestar.layout.${id}`,
    JSON.stringify({
      contextPane: "pipeline",
      terminalDock: true,
      dockTab: "Agent Output",
      outputView: "raw",
      outputStream: "stderr",
      outputFollow: false,
    }),
  );

  const rpc = bridge(
    vi.fn(async (method, params) =>
      method === "task.chat"
        ? {
            message: {
              id: "saved",
              content: params.content,
              status: "queued",
              created_at: run.started_at,
            },
          }
        : method === "task.logs"
          ? {
              text: "saved stderr",
              start: 0,
              end: 12,
              size: 12,
              truncated: false,
            }
          : null,
    ),
  );

  render(<TaskWorkspace detail={detail(id)} revision={0} onError={vi.fn()} back={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Follow output" })).toBeTruthy();
  expect((screen.getByLabelText("Raw output stream") as HTMLSelectElement).value).toBe("stderr");
  fireEvent.click(screen.getByRole("tab", { name: "Run details" }));
  const opener = screen.getByRole("button", { name: "View sent prompts" });
  opener.focus();
  fireEvent.click(opener);
  const dialog = screen.getByRole("dialog", { name: "Agent prompts" });
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));
  fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
  expect(document.activeElement?.tagName).toBe("SUMMARY");
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Agent prompts" })).toBeNull();
  expect(document.activeElement).toBe(opener);
  const input = screen.getByLabelText("Task conversation");
  fireEvent.change(input, { target: { value: "saved instruction" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(rpc.mock.calls.filter(([method]) => method === "task.chat")).toHaveLength(0);
  fireEvent.keyDown(input, { key: "Enter" });

  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "task.chat",
      expect.objectContaining({ content: "saved instruction" }),
    ),
  );
});

it("renders nested results and unknown fields as readable content and treats completed activity as completed in the status strip", () => {
  bridge();

  render(
    <AgentResponse
      expanded
      text={JSON.stringify({
        observations: [
          {
            file: "src/a.ts",
            message: "**Review this file**",
            extraField: "emitted detail",
          },
        ],
      })}
    />,
  );

  expect(screen.getByText("Review this file")).toBeTruthy();
  expect(screen.getByText("emitted detail")).toBeTruthy();
  expect(screen.queryByText("[object Object]")).toBeNull();
  cleanup();

  render(
    <CurrentRun
      detail={{
        ...detail("completed-activity"),
        events: [
          event(1, "command.finished", {
            command: "npm test",
            call_id: 1,
            exit_code: 0,
          }),
        ],
      }}
      stop={vi.fn()}
      output={vi.fn()}
    />,
  );

  expect(screen.getByText("completed · npm test")).toBeTruthy();
});
