// @vitest-environment jsdom
import { it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { CurrentRun } from "../src/components/CurrentRun";
import { AgentTimeline } from "../src/components/AgentTimeline";
import { UsageView } from "../src/components/UsageView";
import { OpenInEditor } from "../src/components/OpenInEditor";
import { CodeAskAI } from "../src/components/CodeAskAI";
import { defaultSettings } from "../backend/domain";
import type { Detail, Run } from "../src/lib/types";
import type { UsageRecord } from "../backend/execution/usage";
vi.mock("../src/lib/useWorkspace", () => ({
  useProviders: () => ({
    providers: [
      {
        provider: "antigravity",
        models: [
          {
            id: "gemini-test",
            isDefault: true,
            supportedEfforts: ["medium", "high"],
          },
        ],
        efforts: ["medium", "high"],
      },
    ],
    refresh: vi.fn(),
    loading: false,
  }),
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const task = {
  id: "task-id",
  repo_id: "repo",
  issue_number: 1,
  issue_url: "https://github.com/a/b/issues/1",
  claimed_scope: "file.ts",
  notes: "",
  issue: {},
  branch_name: "akkco/test",
  base_branch: "main",
  base_commit_sha: "abc",
  worktree_path: "/isolated/task",
  created_at: "2026-10-07T10:00:00Z",
  updated_at: "2026-10-07T10:00:00Z",
  status: "planning_antigravity",
  stage: 1,
  error: null,
};
const run: Run = {
  id: "run-1",
  provider: "antigravity",
  model: "gemini-3.8-flash-high",
  effort: "high",
  purpose: "Antigravity Plan",
  stage: 1,
  status: "running",
  started_at: "2026-10-07T10:00:00Z",
  ended_at: null,
  exit_code: null,
  pid: 100,
  conversation_id: null,
  prompt: "",
  output: null,
  error: null,
};
const record = (
  id: string,
  provider: string,
  status = "completed",
): UsageRecord => ({
  id,
  task_id: "task-id",
  job_id: null,
  repository: "a/b",
  purpose: "Code Review Ask AI",
  provider,
  model: provider === "codex" ? "gpt-test" : "gemini-test",
  effort: "high",
  started_at: "2026-10-07T10:00:00Z",
  ended_at: "2026-10-07T10:01:00Z",
  duration_ms: 60000,
  status,
  input_tokens: null,
  cached_input_tokens: null,
  output_tokens: null,
  reasoning_tokens: null,
  total_tokens: null,
  subscription_limits: null,
  subscription_limits_after: null,
  provider_session_id: null,
  error: null,
});
it("shows real provider/model/stage/activity and elapsed time, changes stages and clears cancelled execution", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-07T10:01:42Z"));
  const detail: Detail = {
    task,
    runs: [run],
    events: [
      {
        id: 1,
        task_id: task.id,
        run_id: run.id,
        timestamp: run.started_at,
        kind: "file.read",
        data: JSON.stringify({ path: "patterns.ts" }),
        raw: "",
        stream: "stdout",
      },
    ],
    messages: [],
    artifacts: [],
    tests: [],
  };
  const stop = vi.fn(),
    output = vi.fn();
  const ui = render(<CurrentRun detail={detail} stop={stop} output={output} />);
  expect(screen.getByText("Antigravity")).toBeTruthy();
  expect(
    screen.getByText(/Planning · gemini-3.8-flash-high · high/),
  ).toBeTruthy();
  expect(screen.getByText(/1m 42s/)).toBeTruthy();
  expect(screen.getByText("Reading: patterns.ts")).toBeTruthy();
  ui.rerender(
    <CurrentRun
      detail={{
        ...detail,
        events: [
          ...detail.events,
          {
            ...detail.events[0],
            id: 2,
            kind: "message",
            data: JSON.stringify({ text_delta: "Checking selected code…" }),
          },
          {
            ...detail.events[0],
            id: 3,
            kind: "analysis.status",
            data: JSON.stringify({ status: "RUNNING" }),
          },
        ],
        usage: [
          {
            ...record(run.id, "antigravity", "running"),
            input_tokens: 42,
            output_tokens: 7,
          },
        ],
      }}
      stop={stop}
      output={output}
    />,
  );
  expect(screen.getByText("Checking selected code…")).toBeTruthy();
  expect(screen.getByText("Input: 42 · Output: 7")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(stop).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Agent Output" }));
  expect(output).toHaveBeenCalled();
  ui.rerender(
    <CurrentRun
      detail={{
        ...detail,
        task: { ...task, status: "planning_codex" },
        runs: [
          { ...run, status: "completed" },
          {
            ...run,
            id: "run-2",
            provider: "codex",
            stage: 2,
            model: "gpt-test",
            started_at: "2026-10-07T10:01:00Z",
          },
        ],
      }}
      stop={stop}
      output={output}
    />,
  );
  expect(screen.getByText("Codex")).toBeTruthy();
  expect(screen.getByText(/Reviewing plan · gpt-test/)).toBeTruthy();
  expect(screen.getByText(/42s/)).toBeTruthy();
  expect(screen.queryByText("Reading: patterns.ts")).toBeNull();
  ui.rerender(
    <CurrentRun
      detail={{
        ...detail,
        task: { ...task, status: "cancelled" },
        runs: [{ ...run, status: "cancelled" }],
      }}
      stop={stop}
      output={output}
    />,
  );
  expect(screen.queryByLabelText("Current agent run")).toBeNull();
});
it("keeps failed/cancelled runs visible, sums reported fields only and exposes official matching-window deltas", async () => {
  const before = {
    reportedAt: run.started_at,
    planType: "plus",
    windows: [
      { usedPercent: 31, windowDurationMins: 300, resetsAt: 2000000000 },
    ],
  };
  const rows = [
    {
      ...record("one", "codex", "failed"),
      input_tokens: 100,
      output_tokens: 12,
      subscription_limits: JSON.stringify(before),
      subscription_limits_after: JSON.stringify({
        ...before,
        windows: [{ ...before.windows[0], usedPercent: 37 }],
      }),
    },
    record("two", "antigravity", "cancelled"),
  ];
  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: {
      rpc: vi.fn(async () => ({ database: "/data/state/vibestar.sqlite" })),
      subscribe: () => () => {},
    },
  });
  const ui = render(<UsageView taskId={task.id} records={rows} />);
  expect(screen.getByText("Task usage")).toBeTruthy();
  expect(screen.getByText("failed")).toBeTruthy();
  expect(screen.getByText("cancelled")).toBeTruthy();
  expect(ui.container.querySelector(".usage-tokens")?.textContent).toContain(
    "input100",
  );
  expect(ui.container.querySelector(".usage-tokens")?.textContent).toContain(
    "totalUnavailable",
  );
  expect(
    screen.getByText(/Subscription window usage delta.*\+6 percentage points/),
  ).toBeTruthy();
  expect(
    await screen.findByText(/Database: \/data\/state\/vibestar.sqlite/),
  ).toBeTruthy();
});
it("refreshes global usage on local events and filters provider/model/purpose/repository/task", async () => {
  let rows: UsageRecord[] = [];
  let listener: (event: { event: string }) => void = () => {};
  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: {
      rpc: vi.fn(async (method: string) =>
        method === "usage.list"
          ? rows
          : { database: "/data/state/vibestar.sqlite" },
      ),
      subscribe: (callback: typeof listener) => {
        listener = callback;
        return () => {};
      },
    },
  });
  const ui = render(<UsageView />);
  expect(
    await screen.findByText("No AI usage recorded in this data root yet."),
  ).toBeTruthy();
  rows = [record("one", "codex"), record("two", "antigravity", "cancelled")];
  listener({ event: "usage.changed" });
  expect(await screen.findByText("cancelled")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Usage provider filter"), {
    target: { value: "codex" },
  });
  expect(screen.queryByText("cancelled")).toBeNull();
  expect(ui.container.querySelectorAll(".usage-run")).toHaveLength(1);
  expect(screen.getByLabelText("Usage model filter")).toBeTruthy();
  expect(screen.getByLabelText("Usage purpose filter")).toBeTruthy();
  expect(screen.getByLabelText("Usage repository filter")).toBeTruthy();
  expect(screen.getByLabelText("Usage task_id filter")).toBeTruthy();
});
it("offers useful editor fallback and passes the task target instead of a source checkout", async () => {
  const rpc = vi.fn(async () => ({ editors: [], default: "" }));
  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: { rpc },
  });
  render(<OpenInEditor id={task.id} kind="task" path={task.worktree_path} />);
  fireEvent.click(screen.getByRole("button", { name: "Open in VS Code" }));
  expect(
    await screen.findByText(/No supported editor CLI detected/),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open folder" }));
  expect(rpc).toHaveBeenCalledWith("open.directory", {
    id: task.id,
    kind: "task",
  });
  expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
});
it("opens VS Code directly on the task target and keeps an editor chooser", async () => {
  const rpc = vi.fn(async (method: string) =>
    method === "editors.list"
      ? { editors: [{ id: "code", label: "VS Code" }], default: "" }
      : null,
  );
  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: { rpc },
  });
  render(<OpenInEditor id={task.id} kind="task" path={task.worktree_path} />);
  fireEvent.click(screen.getByRole("button", { name: "Open in VS Code" }));
  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("editors.open", {
      id: task.id,
      kind: "task",
      editor: "code",
    }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Choose task editor" }),
  ).toBeTruthy();
});
it("does not mark skipped provider tests as passed and explains sandbox command failures", () => {
  const ui = render(
    <AgentTimeline
      runs={[{ ...run, status: "completed" }]}
      events={[
        {
          id: 1,
          run_id: run.id,
          task_id: task.id,
          timestamp: task.created_at,
          kind: "test.result",
          data: JSON.stringify({ status: "skipped", text: "Missing package" }),
          raw: "",
          stream: "stdout",
        },
        {
          id: 2,
          run_id: run.id,
          task_id: task.id,
          timestamp: task.created_at,
          kind: "command.finished",
          data: JSON.stringify({
            command: "git status",
            exit_code: 1,
            stderr: "connecting to sandbox server: connection reset by peer",
          }),
          raw: "",
          stream: "stdout",
        },
      ]}
    />,
  );
  expect(ui.container.querySelector(".tool-skipped .success")).toBeNull();
  expect(ui.container.querySelector(".tool-skipped .warning")).toBeTruthy();
  expect(screen.getByText(/command sandbox connection dropped/)).toBeTruthy();
});
it("sends selected side/range and chosen configuration, links answers into Chat and requires explicit request change", async () => {
  const rpc = vi.fn(async (method: string) =>
    method === "snapshot"
      ? { settings: defaultSettings }
      : method === "review.questions"
        ? []
        : {},
  );
  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: { rpc },
  });
  const ui = render(
    <CodeAskAI
      task={task}
      path="file.ts"
      selection={{ start: 42, end: 48, side: "base" }}
      revision={0}
    />,
  );
  expect(screen.getByText("Ask AI · read-only")).toBeTruthy();
  fireEvent.submit(ui.container.querySelector("form")!);
  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "review.ask",
      expect.objectContaining({
        id: task.id,
        path: "file.ts",
        side: "base",
        line_start: 42,
        line_end: 48,
        question: "Why was this changed?",
        configuration: expect.objectContaining({
          provider: "antigravity",
          effort: "medium",
        }),
      }),
    ),
  );
  expect(rpc.mock.calls.some(([method]) => method === "task.followup")).toBe(
    false,
  );
});
