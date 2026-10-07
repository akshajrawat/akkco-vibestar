// @vitest-environment jsdom
import { it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { StageSettings } from "../src/components/StageSettings";
import { PlanView } from "../src/components/PlanView";
import { NewTask } from "../src/components/NewTask";
import { parseArgv, eventText } from "../src/lib/api";
import { defaultSettings } from "../backend/domain";
afterEach(cleanup);
it("shows an agent's actual structured summary without dumping JSON into the conversation", async () => {
  const { AgentResponse } = await import("../src/components/AgentResponse");
  render(
    <AgentResponse
      text={JSON.stringify({
        summary: "Inspect the claimed spec",
        relevantFiles: ["scope.spec.ts"],
      })}
    />,
  );
  expect(screen.getByText("Inspect the claimed spec")).toBeTruthy();
  expect(screen.getByText("View result details")).toBeTruthy();
  expect(screen.getByText(/relevant Files/)).toBeTruthy();
});
it("keeps implementation config independent of planning", () => {
  const changed = vi.fn();
  render(<StageSettings settings={defaultSettings} onChange={changed} />);
  const models = screen.getAllByPlaceholderText("Official CLI default");
  fireEvent.change(models[1], { target: { value: "requested-plan-model" } });
  const settings = changed.mock.calls[0][0];
  expect(settings.codex_plan.model).toBe("requested-plan-model");
  expect(settings.codex_implementation.model).toBe("");
  expect(screen.getAllByText("max", { exact: true })).toHaveLength(1);
});
it("shows both locally persisted plans", () => {
  render(
    <PlanView
      artifacts={[
        {
          id: "a",
          stage: 1,
          kind: "plan",
          content: '{"summary":"original proposal"}',
          created_at: new Date().toISOString(),
        },
        {
          id: "b",
          stage: 2,
          kind: "plan",
          content: '{"goal":"independent refinement"}',
          created_at: new Date().toISOString(),
        },
      ]}
    />,
  );
  expect(screen.getByText("original proposal")).toBeTruthy();
  expect(screen.getByText("independent refinement")).toBeTruthy();
});
it("resolves a pasted issue and sends distinct whole/partial scope semantics", async () => {
  const created = vi.fn();
  const preview = {
    reference: { owner: "oppia", repo: "oppia", number: 26831 },
    issue: {
      title: "Migrate tests",
      body: "All checklist items",
      comments: [],
    },
    repository: null,
    resolved: {
      repository: {},
      upstream_url: "https://github.com/oppia/oppia.git",
      origin_url: "https://github.com/akshajrawat/oppia.git",
      base_branch: "develop",
    },
  };
  const rpc = vi
    .fn()
    .mockImplementation((method: string) =>
      Promise.resolve(
        method === "snapshot"
          ? { settings: defaultSettings }
          : method === "task.create"
            ? { id: "task" }
            : preview,
      ),
    );
  Object.defineProperty(window, "vibestar", {
    value: { rpc },
    configurable: true,
  });
  render(<NewTask close={() => {}} created={created} />);
  fireEvent.change(screen.getByLabelText("Issue URL"), {
    target: { value: "https://github.com/oppia/oppia/issues/26831" },
  });
  expect(await screen.findByText("Migrate tests")).toBeTruthy();
  expect(
    (screen.getByLabelText("Entire issue") as HTMLInputElement).checked,
  ).toBe(true);
  fireEvent.click(screen.getByText("Start task"));
  await vi.waitFor(() => expect(created).toHaveBeenCalledWith("task"));
  expect(rpc).toHaveBeenCalledWith(
    "task.create",
    expect.objectContaining({ scope_mode: "whole_issue", claimed_scope: "" }),
  );
  fireEvent.click(screen.getByLabelText("Specific part / claimed subtask"));
  fireEvent.change(screen.getByLabelText("Claimed scope"), {
    target: { value: "check-improvements-tab.spec.ts" },
  });
  fireEvent.click(screen.getByText("Start task"));
  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "task.create",
      expect.objectContaining({
        scope_mode: "partial",
        claimed_scope: "check-improvements-tab.spec.ts",
      }),
    ),
  );
});
it("validates argv input and renders structured text", () => {
  expect(parseArgv('["git","status"]')).toEqual(["git", "status"]);
  expect(() => parseArgv('"git status"')).toThrow();
  expect(eventText('{"text_delta":"thinking"}')).toBe("thinking");
});
it("uses typed preload window controls and reflects maximize state", async () => {
  const { TitleBar } = await import("../src/components/TitleBar");
  const controls = {
    minimize: vi.fn().mockResolvedValue(undefined),
    maximize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getState: vi
      .fn()
      .mockResolvedValue({ maximized: false, fullscreen: false }),
    fullscreen: vi.fn().mockResolvedValue(undefined),
    onStateChanged: vi.fn().mockReturnValue(() => {}),
    isMaximized: vi.fn().mockResolvedValue(false),
    onMaximizedChanged: vi.fn().mockReturnValue(() => {}),
  };
  Object.defineProperty(window, "electronWindow", {
    value: controls,
    configurable: true,
  });
  render(<TitleBar />);
  expect(screen.getByText("akkco vibestar")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Minimize window" }));
  fireEvent.click(screen.getByRole("button", { name: "Maximize window" }));
  fireEvent.click(screen.getByRole("button", { name: "Close window" }));
  expect(controls.minimize).toHaveBeenCalledOnce();
  expect(controls.maximize).toHaveBeenCalledOnce();
  expect(controls.close).toHaveBeenCalledOnce();
});
it("renders a searchable directory diff tree with per-file statistics", async () => {
  const { DiffFileTree } = await import("../src/components/DiffFileTree");
  const select = vi.fn();
  render(
    <DiffFileTree
      files={[
        {
          path: "src/new.ts",
          old_path: null,
          status: "A",
          staged: false,
          unstaged: true,
          insertions: 4,
          deletions: 0,
          binary: false,
        },
        {
          path: "tests/old.ts",
          old_path: "tests/original.ts",
          status: "R",
          staged: true,
          unstaged: false,
          insertions: 1,
          deletions: 1,
          binary: false,
        },
      ]}
      selected="src/new.ts"
      onSelect={select}
    />,
  );
  expect(screen.getByText("+4")).toBeTruthy();
  fireEvent.click(screen.getByText("new.ts"));
  expect(select.mock.calls[0][0].path).toBe("src/new.ts");
  fireEvent.change(screen.getByLabelText("Filter changed files"), {
    target: { value: "tests" },
  });
  expect(screen.queryByText("new.ts")).toBeNull();
  expect(screen.getByText("old.ts")).toBeTruthy();
});
it("preserves task-specific drafts and view preferences when switching tasks", async () => {
  const { useTaskView, updateTaskView } = await import("../src/lib/taskView");
  const Probe = ({ id }: { id: string }) => {
    const view = useTaskView(id);
    return (
      <input
        aria-label="Draft"
        value={view.draft}
        onChange={(e) => updateTaskView(id, { draft: e.target.value })}
      />
    );
  };
  const ui = render(<Probe id="cache-A" />);
  fireEvent.change(screen.getByLabelText("Draft"), {
    target: { value: "Task A follow-up" },
  });
  ui.rerender(<Probe id="cache-B" />);
  expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe("");
  fireEvent.change(screen.getByLabelText("Draft"), {
    target: { value: "Task B only" },
  });
  ui.rerender(<Probe id="cache-A" />);
  expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe(
    "Task A follow-up",
  );
});
it("searches and executes real command palette actions with keyboard navigation", async () => {
  const { CommandPalette } = await import("../src/components/CommandPalette");
  const run = vi.fn(),
    close = vi.fn();
  render(
    <CommandPalette
      close={close}
      actions={[
        { id: "changes", label: "Task: Changes", run },
        { id: "settings", label: "Settings", run: () => {} },
      ]}
    />,
  );
  fireEvent.change(screen.getByLabelText("Search commands"), {
    target: { value: "changes" },
  });
  fireEvent.keyDown(screen.getByLabelText("Search commands"), { key: "Enter" });
  expect(run).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
it("groups tool-call updates into expandable actual command results", async () => {
  const { AgentTimeline } = await import("../src/components/AgentTimeline");
  const timestamp = new Date().toISOString();
  render(
    <AgentTimeline
      runs={[]}
      events={[
        {
          id: 1,
          run_id: "r",
          task_id: "t",
          timestamp,
          kind: "command.started",
          data: JSON.stringify({ call_id: "1", command: "npm test" }),
          raw: "",
          stream: "stdout",
        },
        {
          id: 2,
          run_id: "r",
          task_id: "t",
          timestamp,
          kind: "command.finished",
          data: JSON.stringify({
            call_id: "1",
            command: "npm test",
            stdout: "4 tests passed",
            exit_code: 0,
          }),
          raw: "",
          stream: "stdout",
        },
      ]}
    />,
  );
  expect(screen.getAllByText("Ran")).toHaveLength(1);
  expect(screen.queryByText("Running command")).toBeNull();
  expect(screen.getByText("4 tests passed")).toBeTruthy();
});
