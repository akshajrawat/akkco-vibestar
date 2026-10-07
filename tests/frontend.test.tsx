// @vitest-environment jsdom
import { it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { StageSettings } from "../src/components/StageSettings";
import { PlanView } from "../src/components/PlanView";
import { NewTask } from "../src/components/NewTask";
import { parseArgv, eventText, tokenUsage } from "../src/lib/api";
import { defaultSettings } from "../backend/domain";
afterEach(cleanup);
it("shows cancelled preparation as a compact row without a yellow box or duplicate Resume", async () => {
  const { RunError } = await import("../src/components/RunError");
  const { container } = render(
    <RunError error="AdeError: Run cancelled" retry={vi.fn()} logs={vi.fn()} />,
  );
  const row = screen.getByRole("region", { name: "Cancelled run" });
  expect(row.className).toContain("run-error-cancelled");
  expect(container.querySelector(".warning-box")).toBeNull();
  expect(screen.getByText("Repository preparation was stopped.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  expect(container.querySelector("details")?.open).toBe(false);
  expect(screen.getByText("Technical details")).toBeTruthy();
});
it("identifies cancelled planning even when detection was stopped before a run was created", async () => {
  const { RunError } = await import("../src/components/RunError");
  render(
    <RunError
      error="AdeError: antigravity: AdeError: Run cancelled"
      stage={1}
    />,
  );
  expect(screen.getByText("Antigravity planning was stopped.")).toBeTruthy();
  expect(screen.queryByText(/implementation was stopped/)).toBeNull();
});
it("shows independently reported token fields without inventing a total", () => {
  const unreported = {
    input_tokens: null,
    cached_input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    total_tokens: null,
  };
  expect(tokenUsage(unreported)).toContain("provider did not report usage");
  expect(
    tokenUsage({ ...unreported, input_tokens: 42, output_tokens: 7 }),
  ).toBe(
    "input 42 · cached unavailable · output 7 · reasoning unavailable · total unavailable",
  );
  expect(tokenUsage({ ...unreported, total_tokens: 49 })).toContain("total 49");
});
it("sends Enter, preserves Shift+Enter and IME composition, and prevents form navigation", async () => {
  const { TaskWorkspace } = await import("../src/components/TaskWorkspace");
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    value: () => {},
    configurable: true,
  });
  const rpc = vi.fn(async (method: string, params: Record<string, unknown>) =>
    method === "providers.detect"
      ? []
      : {
          message: {
            id: "saved",
            role: "user",
            content: params.content,
            created_at: new Date().toISOString(),
            status: "delivered",
          },
        },
  );
  Object.defineProperty(window, "vibestar", {
    value: { rpc },
    configurable: true,
  });
  const ui = render(
    <TaskWorkspace
      detail={{
        task: {
          id: "keyboard-test",
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
          created_at: "now",
          updated_at: "now",
          status: "cancelled",
          stage: 1,
          error: null,
        },
        runs: [],
        events: [],
        messages: [],
        artifacts: [],
        tests: [],
      }}
      revision={0}
      onError={() => {}}
      back={() => {}}
    />,
  );
  const composer = screen.getByLabelText("Task follow-up");
  fireEvent.change(composer, { target: { value: "Resume planning" } });
  expect(fireEvent.keyDown(composer, { key: "Enter", shiftKey: true })).toBe(
    true,
  );
  expect(fireEvent.keyDown(composer, { key: "Enter", isComposing: true })).toBe(
    true,
  );
  expect(
    rpc.mock.calls.filter(([method]) => method === "task.followup"),
  ).toHaveLength(0);
  expect(fireEvent.keyDown(composer, { key: "Enter" })).toBe(false);
  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "task.followup",
      expect.objectContaining({ content: "Resume planning" }),
    ),
  );
  expect(await screen.findByText("Resume planning")).toBeTruthy();
  expect((composer as HTMLTextAreaElement).value).toBe("");
  expect(fireEvent.submit(ui.container.querySelector("form")!)).toBe(false);
  expect(ui.container.querySelector("form button:not([type])")).toBeNull();
}, 15000);
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
  expect(screen.getAllByText(/discovering…/)).toHaveLength(3);
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
  expect(screen.getAllByText("Ran ·")).toHaveLength(1);
  expect(screen.queryByText("Running command")).toBeNull();
  expect(screen.getByText("4 tests passed")).toBeTruthy();
});

it("dismisses inline cancellations while retaining compact task status", async () => {
  const { RunError } = await import("../src/components/RunError");
  const { Status } = await import("../src/components/Status");
  render(
    <>
      <Status status="cancelled" />
      <RunError error="Run cancelled" stage={1} />
    </>,
  );
  expect(screen.getByText("Cancelled").className).toContain(
    "status-chip warning",
  );
  fireEvent.click(screen.getByRole("button", { name: "Dismiss run notice" }));
  expect(screen.queryByRole("region", { name: "Cancelled run" })).toBeNull();
  expect(screen.getByText("Cancelled")).toBeTruthy();
});

it("shows named cleanup blockers, keeps technical details collapsed, and requires explicit retry", async () => {
  const { CleanupError } = await import("../src/components/CleanupError");
  const blockers = [
    {
      id: "terminal:one",
      kind: "terminal",
      task_id: "one",
      label: "Task #26829 terminal session is open",
      stoppable: true,
    },
  ];
  const call = vi.fn(async (method: string) =>
    method === "storage.blockers" ? blockers : [],
  );
  Object.defineProperty(window, "vibestar", {
    value: { rpc: call },
    configurable: true,
  });
  const retry = vi.fn();
  const { container } = render(
    <CleanupError
      error={{
        message: "Task data cleanup is waiting",
        technical: "raw RPC stack",
      }}
      taskId="one"
      title="Can't delete task data right now"
      retry={retry}
      busy={false}
    />,
  );
  await screen.findByText("Task #26829 terminal session is open");
  expect(container.querySelector("details")?.open).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Stop blockers" }));
  await screen.findByText("Blockers stopped. Try again to finish cleanup.");
  expect(call).toHaveBeenCalledWith("storage.stopBlockers", {
    task_id: "one",
    ids: ["terminal:one"],
  });
  expect(retry).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(retry).toHaveBeenCalledOnce();
});

it("collapses PR reasoning and highlights active analysis above a previous approval", async () => {
  const { ScheduledPage } = await import("../src/components/ScheduledPage");
  const { ActionSchema } = await import("../backend/scheduled/action");
  const job = {
    id: "watch",
    url: "https://github.com/oppia/oppia/pull/27527",
    task_id: null,
    interval_minutes: 60,
    verify_codex: false,
    enabled: true,
    next_run_at: new Date().toISOString(),
    status: "analyzing" as const,
    last_checked_at: null,
    last_snapshot: null,
    pending_snapshot: null,
    changes: [],
    error: null,
    title: "Migrate acceptance tests",
    analysis_method: "utility_ai" as const,
    action: ActionSchema.parse({
      manualActionRequired: false,
      conversationState: "approved",
      severity: "none",
      summary: "Approved",
      reason: "A long explanation kept in details",
      recommendedNextAction: "",
      affectedFiles: [],
    }),
  };
  const { container } = render(
    <ScheduledPage
      snapshot={{
        repositories: [],
        tasks: [],
        settings: defaultSettings,
        root: "/tmp/vibestar",
        scheduled: [job],
        attention: [],
      }}
      refresh={vi.fn()}
      open={vi.fn()}
    />,
  );
  expect(screen.getByText(/ANALYZING DISCUSSION/)).toBeTruthy();
  expect(screen.queryByText("APPROVED")).toBeNull();
  expect(screen.getByText("Assessing the review conversation.")).toBeTruthy();
  expect(container.querySelector(".pr-row-details")?.hasAttribute("open")).toBe(
    false,
  );
  expect(container.querySelector(".pr-inbox-row")?.className).toContain(
    "pr-running",
  );
  expect(screen.getByRole("button", { name: /Open PR/ })).toBeTruthy();
});

it("normalizes legacy transport errors and structured errors without discarding their reason", async () => {
  const { errorMessage } = await import("../src/lib/api");
  expect(
    errorMessage(
      "Error invoking remote method 'core:rpc': Error: AdeError: Run cancelled",
    ),
  ).toBe("Run cancelled");
  expect(
    errorMessage({
      message: "Task terminal is open",
      context: { task_id: "one" },
    }),
  ).toBe("Task terminal is open");
});
