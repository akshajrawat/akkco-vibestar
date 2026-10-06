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
  expect(screen.getByText("View structured result")).toBeTruthy();
  expect(screen.getByText(/relevantFiles/)).toBeTruthy();
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
it("creates a concrete task preview before running", async () => {
  const rpc = vi.fn().mockResolvedValue({
    issue: { owner: "oppia", repo: "oppia", number: 26831 },
    repository: { base_branch: "develop" },
    branch_name: "akkco/26831-scope",
  });
  Object.defineProperty(window, "vibestar", {
    value: { rpc },
    configurable: true,
  });
  render(<NewTask close={() => {}} created={() => {}} />);
  fireEvent.change(
    screen.getByPlaceholderText("https://github.com/oppia/oppia/issues/26831"),
    { target: { value: "https://github.com/oppia/oppia/issues/26831" } },
  );
  fireEvent.change(
    screen.getByPlaceholderText("check-improvements-tab.spec.ts"),
    { target: { value: "scope" } },
  );
  fireEvent.click(screen.getByText("Preview task"));
  expect(await screen.findByText("upstream/develop")).toBeTruthy();
  expect(rpc).toHaveBeenCalledWith("task.preview", {
    issue_url: "https://github.com/oppia/oppia/issues/26831",
    claimed_scope: "scope",
  });
  expect(screen.getByText("Create & Run")).toBeTruthy();
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
  expect(screen.getAllByText("Command finished")).toHaveLength(1);
  expect(screen.queryByText("Running command")).toBeNull();
  expect(screen.getByText("4 tests passed")).toBeTruthy();
});
