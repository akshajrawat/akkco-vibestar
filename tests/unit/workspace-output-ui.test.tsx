// @vitest-environment jsdom
import { selectValue } from "../helpers/select";
import { it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";

import { TaskWorkspace } from "../../src/features/tasks/TaskWorkspace";
import { TestsView } from "../../src/features/verification/TestsView";
import { LogView } from "../../src/features/chat/LogView";
import { TaskCleanup } from "../../src/features/tasks/TaskCleanup";
import type { Detail } from "../../src/lib/types";

const terminal = vi.hoisted(() => ({ mounts: 0 }));

vi.mock("../../src/components/shared/TaskTerminal", async () => {
  const { useEffect } = await import("react");
  return {
    TaskTerminal: () => {
      useEffect(() => {
        terminal.mounts++;
      }, []);

      return <div>Attached terminal session</div>;
    },
  };
});

vi.mock("../../src/hooks/useWorkspace", () => ({
  useProviders: () => ({ providers: [], refresh: vi.fn() }),
}));

afterEach(cleanup);

const detail: Detail = {
  task: {
    id: "workspace-output",
    repo_id: "repo",
    issue_number: 1,
    issue_url: "https://github.com/a/b/issues/1",
    claimed_scope: "source.ts",
    notes: "",
    issue: { title: "Migration" },
    branch_name: "migrate-test",
    base_branch: "main",
    base_commit_sha: "abcdef",
    worktree_path: "/tasks/worktree",
    created_at: "2026-10-09T00:00:00Z",
    updated_at: "2026-10-09T00:00:00Z",
    status: "implementing",
    stage: 3,
    error: null,
  },
  runs: [
    {
      id: "implement",
      stage: 3,
      provider: "codex",
      purpose: "Codex Implementation",
      model: "gpt-test",
      effort: "high",
      prompt: "Exact instructions",
      status: "running",
      started_at: "2026-10-09T00:00:00Z",
      ended_at: null,
      exit_code: null,
      pid: 1,
      conversation_id: null,
      output: null,
      error: null,
    },
  ],
  events: [],
  messages: [],
  artifacts: [],
  tests: [],
};

const bridge = () => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    value: () => {},
    configurable: true,
  });

  const rpc = vi.fn(async (method: string) =>
    method === "task.diff"
      ? {
          files: [
            {
              path: "source.ts",
              old_path: null,
              status: "M",
              staged: false,
              unstaged: true,
              insertions: 1,
              deletions: 1,
              binary: false,
            },
          ],
          base: "abcdef",
          insertions: 1,
          deletions: 1,
        }
      : method === "task.file"
        ? {
            original: "old",
            modified: "new",
            unified: "--- source.ts\n+++ source.ts\n@@ -1 +1 @@\n-old\n+new\n",
            binary: false,
          }
        : method === "editors.list"
          ? { editors: [] }
          : null,
  );

  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: { rpc },
  });

  return rpc;
};

it("removes task history while preserving work through a distinct explicit choice", async () => {
  const rpc = bridge();
  const done = vi.fn();
  render(<TaskCleanup id="owned-task" close={vi.fn()} done={done} />);
  expect(screen.getAllByRole("radio")).toHaveLength(3);
  expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  expect(rpc).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("radio", { name: /^Remove task history, preserve work/ }));
  fireEvent.click(screen.getByRole("button", { name: "Remove history and preserve work" }));
  await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());

  expect(rpc).toHaveBeenCalledWith("task.disposal.preserve", {
    id: "owned-task",
    confirmed: true,
  });
});

it("keeps active execution visible with the right sidebar closed and restores the dock without restarting its terminal", async () => {
  bridge();
  terminal.mounts = 0;

  const ui = render(
    <TaskWorkspace detail={detail} revision={0} onError={vi.fn()} back={vi.fn()} />,
  );

  expect(screen.getByLabelText("Current agent run")).toBeTruthy();
  expect(screen.queryByText("View sent prompts")).toBeNull();
  expect(screen.getAllByLabelText("Stop agent").length).toBeGreaterThan(0);
  fireEvent.click(screen.getByLabelText("Toggle secondary workspace"));
  const sidebar = ui.container.querySelector("aside.context-pane")!;
  expect(sidebar.contains(screen.getByLabelText("Current agent run"))).toBe(false);
  fireEvent.click(screen.getByRole("tab", { name: "Run details" }));
  expect(sidebar.contains(screen.getByText("View sent prompts"))).toBe(true);
  fireEvent.click(screen.getByLabelText("Collapse secondary workspace"));
  fireEvent.click(screen.getByLabelText("Toggle utility dock"));
  expect(await screen.findByText("Attached terminal session")).toBeTruthy();
  const height = ui.container.querySelector<HTMLElement>(".utility-dock")!.style.height;
  fireEvent.click(screen.getByLabelText("Maximize utility dock"));
  expect(ui.container.querySelector(".workspace.dock-maximized")).toBeTruthy();
  expect(ui.container.querySelector<HTMLElement>(".utility-dock")!.style.height).toBe("");
  expect(terminal.mounts).toBe(1);

  fireEvent.keyDown(screen.getByLabelText("Restore utility dock"), {
    key: "Escape",
  });

  expect(ui.container.querySelector(".workspace.dock-maximized")).toBeNull();
  expect(ui.container.querySelector<HTMLElement>(".utility-dock")!.style.height).toBe(height);
  expect(terminal.mounts).toBe(1);
  fireEvent.click(screen.getByLabelText("Toggle secondary workspace"));
  fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
  fireEvent.click(screen.getByRole("button", { name: "Open full diff review" }));
  await screen.findByText("new");

  expect(
    ui.container.querySelector('.diff-code[data-side="working"][data-line="1"]')?.textContent,
  ).toBe("new");

  expect(
    ui.container.querySelector('.diff-code[data-side="base"][data-line="1"]')?.textContent,
  ).toBe("old");

  expect(ui.container.querySelector(".secondary-expanded")).toBeTruthy();
  fireEvent.click(screen.getByLabelText("Return to chat"));
  expect(terminal.mounts).toBe(1);
});

it("separates command transcripts by attempt and stage, highlights failures, keeps both streams and updates live output", () => {
  bridge();

  const tests = [
    {
      id: "first",
      run_id: "implement",
      command: "npm test",
      status: "passed",
      started_at: detail.task.created_at,
      ended_at: detail.task.updated_at,
      exit_code: 0,
      stdout: "desktop passed",
      stderr: "warning from desktop",
    },
    {
      id: "second",
      run_id: "review",
      command: "npm test -- --mobile",
      status: "failed",
      started_at: detail.task.created_at,
      ended_at: detail.task.updated_at,
      exit_code: 1,
      stdout: "mobile started",
      stderr: "mobile assertion failed",
    },
    {
      id: "third",
      run_id: "implement",
      command: "npm run lint",
      status: "running",
      started_at: detail.task.created_at,
      ended_at: null,
      exit_code: null,
      stdout: "linting",
      stderr: "",
    },
  ];

  const props = {
    ...detail,
    tests,
    runs: [
      detail.runs[0],
      {
        ...detail.runs[0],
        id: "review",
        provider: "antigravity",
        purpose: "Antigravity Final Review",
        stage: 5,
        status: "completed",
      },
    ],
  };

  const ui = render(<TestsView detail={props} onError={vi.fn()} />);
  expect(screen.getByLabelText("Selected command output").textContent).toContain("linting");

  selectValue(screen.getByLabelText("Command stage"), "5");

  expect(screen.getByLabelText("Selected command output").textContent).toContain(
    "mobile assertion failed",
  );

  expect(screen.getByLabelText("Selected command output").textContent).toContain("mobile started");
  expect(within(screen.getByLabelText("Recorded commands")).getAllByRole("button")).toHaveLength(1);
  expect(ui.container.querySelector(".command-failed[aria-current='true']")).toBeTruthy();

  selectValue(screen.getByLabelText("Command stage"), "all");

  fireEvent.click(within(screen.getByLabelText("Recorded commands")).getAllByRole("button")[0]);
  expect(screen.getByLabelText("Selected command output").textContent).toContain("desktop passed");

  expect(screen.getByLabelText("Selected command output").textContent).toContain(
    "warning from desktop",
  );

  fireEvent.change(screen.getByLabelText("Search commands"), {
    target: { value: "lint" },
  });

  ui.rerender(
    <TestsView
      detail={{
        ...props,
        tests: [tests[0], tests[1], { ...tests[2], stdout: "linting\nchecked 4 files" }],
      }}
      onError={vi.fn()}
    />,
  );

  expect(screen.getByLabelText("Selected command output").textContent).toContain("checked 4 files");
});

it("opens readable agent output with expanded results and both command streams, while retaining raw inspection", async () => {
  bridge();

  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: {
      rpc: vi.fn(async () => ({
        text: '{"raw":"provider envelope"}',
        truncated: false,
      })),
    },
  });

  render(
    <LogView
      taskId={detail.task.id}
      liveOutput
      runs={[
        {
          ...detail.runs[0],
          status: "completed",
          output: JSON.stringify({
            summary: "Implemented the migration",
            testsPassed: ["desktop check"],
            testsSkipped: ["remote stress run"],
          }),
        },
      ]}
      events={[
        {
          id: 1,
          task_id: detail.task.id,
          run_id: "implement",
          kind: "command.finished",
          timestamp: detail.task.created_at,
          stream: "stdout",
          raw: "",
          data: JSON.stringify({
            command: "npm test",
            call_id: 1,
            stdout: "actual stdout",
            stderr: "actual stderr",
            exit_code: 0,
          }),
        },
      ]}
    />,
  );

  expect(screen.getByText("Implemented the migration")).toBeTruthy();
  expect(screen.getByText("remote stress run")).toBeTruthy();
  expect(screen.getByText("actual stdout")).toBeTruthy();
  expect(screen.getByText("actual stderr")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Raw" }));
  expect(await screen.findByText('{"raw":"provider envelope"}')).toBeTruthy();
});
