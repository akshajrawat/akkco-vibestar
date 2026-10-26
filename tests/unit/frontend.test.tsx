// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { defaultSettings } from "../../backend/domain";
import { StageSettings } from "../../src/features/providers/StageSettings";
import { NewTask } from "../../src/features/tasks/NewTask";
import { parseArgv } from "../../src/features/verification/commands";
import { PlanView } from "../../src/features/workflow/PlanView";
import { tokenUsage } from "../../src/lib/format";

afterEach(cleanup);

it("shows cancelled preparation as a compact row without a yellow box or duplicate Resume", async () => {
  const { RunError } = await import("../../src/features/chat/RunError");

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
  const { RunError } = await import("../../src/features/chat/RunError");
  render(<RunError error="AdeError: antigravity: AdeError: Run cancelled" stage={1} />);
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

  expect(tokenUsage({ ...unreported, input_tokens: 42, output_tokens: 7 })).toBe(
    "input 42 · cached unavailable · output 7 · reasoning unavailable · total unavailable",
  );

  expect(tokenUsage({ ...unreported, total_tokens: 49 })).toContain("total 49");
});

it("sends Enter, preserves Shift+Enter and IME composition, and prevents form navigation", async () => {
  const { TaskWorkspace } = await import("../../src/features/tasks/TaskWorkspace");

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

  const composer = screen.getByLabelText("Task conversation");
  fireEvent.change(composer, { target: { value: "Resume planning" } });
  expect(fireEvent.keyDown(composer, { key: "Enter", shiftKey: true })).toBe(true);
  expect(fireEvent.keyDown(composer, { key: "Enter", isComposing: true })).toBe(true);
  expect(rpc.mock.calls.filter(([method]) => method === "task.chat")).toHaveLength(0);
  expect(fireEvent.keyDown(composer, { key: "Enter" })).toBe(false);

  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "task.chat",
      expect.objectContaining({ content: "Resume planning" }),
    ),
  );

  expect(await screen.findByText("Resume planning")).toBeTruthy();
  expect((composer as HTMLTextAreaElement).value).toBe("");
  expect(fireEvent.submit(ui.container.querySelector("form")!)).toBe(false);
  expect(ui.container.querySelector("form button:not([type])")).toBeNull();
}, 15000);

it("shows an agent's actual structured summary without dumping JSON into the conversation", async () => {
  const { AgentResponse } = await import("../../src/features/chat/AgentResponse");

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

  render(
    <StageSettings
      settings={defaultSettings}
      onChange={changed}
      providers={[
        {
          provider: "codex",
          installed: true,
          connected: true,
          version: "fixture",
          models: [{ id: "requested-plan-model", supportedEfforts: ["high"] }],
          efforts: ["high"],
          capabilities: [],
          error: null,
        },
      ]}
    />,
  );

  const models = screen.getAllByRole("combobox").filter((e) => e.id.endsWith("-models"));
  fireEvent.change(models[1], { target: { value: "requested-plan-model" } });
  const settings = changed.mock.calls[0][0];
  expect(settings.codex_plan.model).toBe("requested-plan-model");
  expect(settings.codex_implementation.model).toBe("");
  expect(screen.getAllByText(/models not loaded/)).toHaveLength(2);
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
    repository: {
      id: "selected-local",
      owner: "oppia",
      name: "oppia",
      path: "/home/aksha/oppia",
      base_branch: "develop",
      source: "imported",
    },
    resolved: {
      repository: {},
      upstream_url: "https://github.com/oppia/oppia.git",
      origin_url: "https://github.com/akshajrawat/oppia.git",
      base_branch: "develop",
    },
  };

  const rpc = vi.fn().mockImplementation((method: string) =>
    Promise.resolve(
      method === "snapshot"
        ? {
            settings: defaultSettings,
            root: "/home/aksha/.akkco-vibestar",
            repositories: [preview.repository],
          }
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
  expect((screen.getByLabelText("Entire issue") as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByText("Create task"));
  await vi.waitFor(() => expect(created).toHaveBeenCalledWith("task"));

  expect(rpc).toHaveBeenCalledWith(
    "task.create",
    expect.objectContaining({
      repository_id: "selected-local",
      scope_mode: "whole_issue",
      claimed_scope: "",
    }),
  );

  fireEvent.click(screen.getByLabelText("Specific part / claimed subtask"));

  fireEvent.change(screen.getByLabelText("Claimed scope"), {
    target: { value: "check-improvements-tab.spec.ts" },
  });

  fireEvent.click(screen.getByText("Create task"));

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

it("validates argv input", () => {
  expect(parseArgv('["git","status"]')).toEqual(["git", "status"]);
  expect(() => parseArgv('"git status"')).toThrow();
});

it("uses typed preload window controls and reflects maximize state", async () => {
  const { TitleBar } = await import("../../src/app/TitleBar");

  const controls = {
    minimize: vi.fn().mockResolvedValue(undefined),
    maximize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockResolvedValue({ maximized: false, fullscreen: false }),
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
  const { DiffFileTree } = await import("../../src/components/diff/DiffFileTree");
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
  const { useTaskView, updateTaskView } = await import("../../src/lib/taskView");

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
  expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe("Task A follow-up");
});

it("searches and executes real command palette actions with keyboard navigation", async () => {
  const { CommandPalette } = await import("../../src/app/CommandPalette");

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
  const { AgentTimeline } = await import("../../src/features/chat/AgentTimeline");
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
  const { RunError } = await import("../../src/features/chat/RunError");
  const { Status } = await import("../../src/components/shared/Status");

  render(
    <>
      <Status status="cancelled" />
      <RunError error="Run cancelled" stage={1} />
    </>,
  );

  expect(screen.getByText("Cancelled").className).toContain("status-chip warning");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss run notice" }));
  expect(screen.queryByRole("region", { name: "Cancelled run" })).toBeNull();
  expect(screen.getByText("Cancelled")).toBeTruthy();
});

it("shows named cleanup blockers, keeps technical details collapsed, and requires explicit retry", async () => {
  const { CleanupError } = await import("../../src/components/shared/CleanupError");

  const blockers = [
    {
      id: "terminal:one",
      kind: "terminal",
      task_id: "one",
      label: "Task #26829 terminal session is open",
      stoppable: true,
    },
  ];

  const call = vi.fn(async (method: string) => (method === "storage.blockers" ? blockers : []));

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
  const { ScheduledPage } = await import("../../src/features/pull-requests/ScheduledPage");
  const { ActionSchema } = await import("../../backend/scheduled/action");

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
  expect(container.querySelector(".pr-row-details")?.hasAttribute("open")).toBe(false);
  expect(container.querySelector(".pr-inbox-row")?.className).toContain("pr-running");
  expect(screen.getByRole("button", { name: /Open PR/ })).toBeTruthy();
});

it("normalizes legacy transport errors and structured errors without discarding their reason", async () => {
  const { errorMessage } = await import("../../src/lib/api");

  expect(
    errorMessage("Error invoking remote method 'core:rpc': Error: AdeError: Run cancelled"),
  ).toBe("Run cancelled");

  expect(
    errorMessage({
      message: "Task terminal is open",
      context: { task_id: "one" },
    }),
  ).toBe("Task terminal is open");
});

it("shows active connections and an All GitHub catalog without legacy filters or advanced URL forms", async () => {
  const { RepositoryPage } = await import("../../src/features/repositories/RepositoryPage");
  const rpc = vi.fn().mockResolvedValue({});

  Object.defineProperty(window, "vibestar", {
    value: { rpc },
    configurable: true,
  });

  render(
    <RepositoryPage
      snapshot={{
        root: "/data",
        settings: defaultSettings,
        repositories: [],
        tasks: [],
        execution_environment: { distro: "Ubuntu" },
        repository_index: {
          repositories: [
            {
              path: "/home/aksha/oppia",
              origin: "https://github.com/me/oppia.git",
              upstream: "https://github.com/oppia/oppia.git",
              identities: ["oppia/oppia"],
              branch: "personal",
              default_branch: "develop",
              environment: "wsl",
              indexed_at: "now",
            },
          ],
          scanning: false,
          last_scan: null,
          duration_ms: null,
          warnings: [],
        },
      }}
      refresh={vi.fn()}
    />,
  );

  expect(screen.getByText("No active repositories")).toBeTruthy();
  expect(screen.getByText("Discovered, not connected", { exact: false })).toBeTruthy();
  for (const label of ["Recent", "Owned", "Forks", "Organizations", "Advanced · add by Git URL"])
    expect(screen.queryByText(label)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  expect((screen.getByLabelText("Path") as HTMLInputElement).value).toBe("/home/aksha/oppia");
  expect(rpc).not.toHaveBeenCalled();
});

it("verifies a manually entered checkout before connecting and invalidates preview on path changes", async () => {
  const { ConnectLocalRepository } =
    await import("../../src/features/repositories/ConnectLocalRepository");

  const verified = {
    verification_id: "verified",
    path: "/home/aksha/oppia",
    environment: "wsl",
    distro: "Ubuntu",
    branch: "my-feature",
    dirty: true,
    remotes: [
      {
        name: "origin",
        identity: "akshajrawat/oppia",
        url: "https://github.com/akshajrawat/oppia.git",
        default_branch: "develop",
      },
      {
        name: "upstream",
        identity: "oppia/oppia",
        url: "https://github.com/oppia/oppia.git",
        default_branch: "develop",
      },
    ],
    branches: ["develop", "my-feature"],
    upstream_remote: "upstream",
    origin_remote: "origin",
    base_branch: "develop",
  };

  const rpc = vi.fn().mockResolvedValue(verified);
  const connected = vi.fn().mockResolvedValue(undefined);

  Object.defineProperty(window, "vibestar", {
    value: { rpc },
    configurable: true,
  });

  render(<ConnectLocalRepository distro="Ubuntu" close={vi.fn()} connected={connected} />);

  fireEvent.change(screen.getByLabelText("Path"), {
    target: { value: "/home/aksha/oppia" },
  });

  expect(screen.queryByRole("button", { name: "Connect repository" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Verify repository" }));
  await screen.findByText("Repository verified");

  expect(rpc).toHaveBeenCalledWith("repository.verifyLocal", {
    environment: "wsl",
    path: "/home/aksha/oppia",
  });

  expect((screen.getByLabelText("Upstream repository") as HTMLSelectElement).value).toBe(
    "upstream",
  );

  expect((screen.getByLabelText("Base branch") as HTMLSelectElement).value).toBe("develop");
  fireEvent.click(screen.getByRole("button", { name: "Connect repository" }));
  await vi.waitFor(() => expect(connected).toHaveBeenCalled());

  expect(rpc).toHaveBeenCalledWith("repository.connectLocal", {
    verification_id: "verified",
    upstream_remote: "upstream",
    origin_remote: "origin",
    base_branch: "develop",
  });

  fireEvent.change(screen.getByLabelText("Path"), {
    target: { value: "/home/aksha/other" },
  });

  expect(screen.queryByRole("button", { name: "Connect repository" })).toBeNull();
});

it("shows only active repositories, visibly matches a pasted issue, and blocks a user's mismatched selection", async () => {
  const oppia = {
    id: "oppia-local",
    owner: "oppia",
    name: "oppia",
    upstream_url: "https://github.com/oppia/oppia.git",
    origin_url: "https://github.com/akshajrawat/oppia.git",
    base_branch: "develop",
    path: "/home/aksha/oppia",
    source: "imported",
    connected: true,
  };

  const react = {
    ...oppia,
    id: "react-local",
    owner: "facebook",
    name: "react",
    path: "/home/aksha/react",
  };

  const disconnected = {
    ...oppia,
    id: "old",
    path: "/old-checkout",
    connected: false,
  };

  const rpc = vi.fn().mockImplementation((method: string) =>
    Promise.resolve(
      method === "snapshot"
        ? {
            root: "/home/aksha/.akkco-vibestar",
            settings: defaultSettings,
            repositories: [react, oppia, disconnected],
          }
        : method === "task.preview"
          ? {
              reference: { owner: "oppia", repo: "oppia", number: 26831 },
              issue: { title: "Oppia issue", body: "Requirements" },
              repository: oppia,
            }
          : [],
    ),
  );

  Object.defineProperty(window, "vibestar", {
    value: { rpc },
    configurable: true,
  });

  render(<NewTask close={vi.fn()} created={vi.fn()} />);
  await screen.findByText("facebook/react · /home/aksha/react");
  expect(screen.queryByRole("option", { name: /old-checkout/ })).toBeNull();

  fireEvent.change(screen.getByLabelText("Issue URL"), {
    target: { value: "https://github.com/oppia/oppia/issues/26831" },
  });

  await screen.findByText("Oppia issue");
  expect((screen.getByLabelText("Repository") as HTMLSelectElement).value).toBe(oppia.id);
  expect(screen.getByText(/Matched from issue URL/)).toBeTruthy();

  expect(
    screen.getByText("/home/aksha/.akkco-vibestar/worktrees/oppia-local/26831-…"),
  ).toBeTruthy();

  fireEvent.change(screen.getByLabelText("Repository"), {
    target: { value: react.id },
  });

  expect(await screen.findByText("Repository mismatch")).toBeTruthy();

  expect(
    (
      screen.getByRole("button", {
        name: /Create task/,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);

  expect(rpc).not.toHaveBeenCalledWith("task.create", expect.anything());
  fireEvent.click(screen.getByRole("button", { name: "Switch to oppia/oppia" }));
  expect((screen.getByLabelText("Repository") as HTMLSelectElement).value).toBe(oppia.id);
});

it("keeps finalization explicit and shows source/worktree metadata without moving the user's checkout", async () => {
  const { TaskWorkspace } = await import("../../src/features/tasks/TaskWorkspace");

  const rpc = vi.fn(async (method: string) =>
    method === "git.inspect"
      ? {
          files: [],
          ignored: [],
          fingerprint: "fixture",
          preset: {
            name: "Local only",
            commit_hooks: "normal",
            push: "none",
            remote: "origin",
            branch: "akkco/26831-task-a",
          },
          history: [],
          active: false,
        }
      : method === "providers.detect"
        ? []
        : method === "task.diff"
          ? {
              files: [{ path: "source.txt" }],
              insertions: 1,
              deletions: 1,
              base: "sha",
            }
          : null,
  );

  Object.defineProperty(window, "vibestar", {
    value: { rpc },
    configurable: true,
  });

  render(
    <TaskWorkspace
      detail={{
        task: {
          id: "finalize-test",
          repo_id: "source",
          issue_number: 26831,
          issue_url: "https://github.com/oppia/oppia/issues/26831",
          claimed_scope: "Task A",
          notes: "",
          issue: { title: "Task" },
          branch_name: "akkco/26831-task-a",
          base_branch: "develop",
          base_commit_sha: "sha",
          worktree_path: "/data/worktrees/source/task",
          created_at: "now",
          updated_at: "now",
          status: "ready_for_review",
          stage: 5,
          error: null,
        },
        runs: [],
        events: [],
        messages: [],
        artifacts: [],
        tests: [],
      }}
      repository={{
        id: "source",
        owner: "oppia",
        name: "oppia",
        path: "/home/aksha/oppia",
        upstream_url: "https://github.com/oppia/oppia.git",
        origin_url: null,
        source: "imported",
        base_branch: "develop",
        last_fetched: null,
        created_at: "now",
      }}
      revision={0}
      onError={vi.fn()}
      back={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Git Finalization" }));
  expect(screen.getByRole("dialog", { name: "Git Finalization" })).toBeTruthy();

  expect(
    screen.getByText(/Select reviewed files, keep your exact message and confirm the destination/),
  ).toBeTruthy();

  expect(rpc).not.toHaveBeenCalledWith("task.complete", expect.anything());
  fireEvent.click(screen.getByRole("button", { name: "Keep local and close" }));
  expect(screen.queryByRole("dialog", { name: "Git Finalization" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Git Finalization" }));
  fireEvent.click(screen.getByRole("button", { name: "Mark task complete" }));

  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("task.complete", { id: "finalize-test" }),
  );

  expect(rpc.mock.calls.some(([method]) => /commit|checkout|remove/.test(method))).toBe(false);
});
