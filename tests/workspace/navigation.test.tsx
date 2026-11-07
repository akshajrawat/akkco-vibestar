// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { TaskNavigation } from "../../src/features/tasks/TaskNavigation";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

const repo = {
  id: "repo",
  owner: "fixture",
  name: "repo",
  upstream_url: "https://github.com/fixture/repo.git",
  origin_url: null,
  base_branch: "main",
  path: "/source",
  last_fetched: null,
  created_at: "2026-10-22T00:00:00Z",
};

const task = {
  id: "task",
  repo_id: repo.id,
  issue_number: 1,
  issue_url: "https://github.com/fixture/repo/issues/1",
  claimed_scope: "Work",
  notes: "",
  issue: { title: "Full issue title" },
  branch_name: "task/fixture",
  base_branch: "main",
  base_commit_sha: "base",
  worktree_path: "/owned/worktree",
  created_at: repo.created_at,
  updated_at: repo.created_at,
  status: "awaiting_approval",
  stage: 2,
  error: null,
};

const bridge = () => {
  const rpc = vi.fn<(method: string, input: unknown) => Promise<unknown>>(async () => null);
  const copy = vi.fn(async () => {});

  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: { rpc },
  });

  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: copy },
  });

  return { rpc, copy };
};

it("announces backend review status and opens a keyboard menu without navigating or executing an action", () => {
  bridge();
  const open = vi.fn();
  render(<TaskNavigation repositories={[repo]} tasks={[task]} selected={task.id} open={open} />);

  const row = screen.getByRole("button", {
    name: /Issue #1 · Work.*Review needed/,
  });

  row.focus();
  fireEvent.keyDown(row, { key: "F10", shiftKey: true });
  const menu = screen.getByRole("menu", { name: "Task #1 actions" });
  expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Open" }));
  expect(open).not.toHaveBeenCalled();
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Manage task…" }));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(row);
});

it("uses existing owner-checked editor RPCs and copies exact task references", async () => {
  const { rpc, copy } = bridge();
  render(<TaskNavigation repositories={[repo]} tasks={[task]} selected={null} open={vi.fn()} />);

  fireEvent.contextMenu(screen.getByRole("button", { name: /Issue #1 · Work/ }), {
    clientX: 20,
    clientY: 50,
  });

  fireEvent.click(screen.getByRole("menuitem", { name: "Copy task branch" }));
  await vi.waitFor(() => expect(copy).toHaveBeenCalledWith(task.branch_name));
  fireEvent.click(screen.getByLabelText("Actions for task #1"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Open in VS Code" }));

  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("editors.open", {
      id: task.id,
      kind: "task",
      editor: "code",
    }),
  );
});

it("retains cleanup confirmation and makes no cleanup call when the task menu opens or the dialog is dismissed", () => {
  const { rpc } = bridge();
  render(<TaskNavigation repositories={[repo]} tasks={[task]} selected={null} open={vi.fn()} />);
  fireEvent.click(screen.getByLabelText("Actions for task #1"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Manage task…" }));
  const dialog = screen.getByRole("dialog", { name: "Manage task" });
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(rpc.mock.calls.every(([method]) => method === "task.detail")).toBe(true);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(rpc.mock.calls.every(([method]) => method === "task.detail")).toBe(true);
});

it("disables lifecycle actions while execution is active and exposes archived tasks for explicit restoration", async () => {
  const { rpc } = bridge();

  const ui = render(
    <TaskNavigation
      repositories={[repo]}
      tasks={[{ ...task, status: "implementing" }]}
      selected={null}
      open={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByLabelText("Actions for task #1"));

  expect((screen.getByRole("menuitem", { name: "Archive" }) as HTMLButtonElement).disabled).toBe(
    true,
  );

  expect(
    (
      screen.getByRole("menuitem", {
        name: "Manage task…",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);

  fireEvent.keyDown(document.activeElement!, { key: "Escape" });

  ui.rerender(
    <TaskNavigation
      repositories={[repo]}
      tasks={[{ ...task, archived: true }]}
      selected={null}
      open={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Show archived tasks" }));
  fireEvent.click(screen.getByLabelText("Actions for task #1"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Unarchive" }));

  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("task.archive", {
      id: task.id,
      archived: false,
    }),
  );
});

it.each(["completed", "paused", "failed"])(
  "moves a task from Not started through Working to %s using snapshot state",
  (status) => {
    bridge();
    const props = { repositories: [repo], selected: null, open: vi.fn() };
    const ui = render(<TaskNavigation {...props} tasks={[{ ...task, status: "not_started" }]} />);
    expect(screen.queryByRole("button", { name: /^Working,/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Work.*Not started/ })).toBeTruthy();

    ui.rerender(<TaskNavigation {...props} tasks={[{ ...task, status: "implementing" }]} />);
    const working = screen.getByRole("button", { name: "Working, 1" }).parentElement!;
    expect(within(working).getByRole("button", { name: /Work.*Implementing/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tasks, 0" })).toBeTruthy();

    ui.rerender(<TaskNavigation {...props} tasks={[{ ...task, status }]} />);
    expect(screen.queryByRole("button", { name: /^Working,/ })).toBeNull();
    const tasks = screen.getByRole("button", { name: "Tasks, 1" }).parentElement!;
    const row = within(tasks).getByRole("button", { name: /Issue #1 · Work/ });
    expect(row.getAttribute("aria-label")?.toLowerCase()).toContain(status);
    fireEvent.click(row);
    expect(props.open).toHaveBeenCalledWith(task.id);
  },
);

it("keeps Tasks and Working collapse independent across task selection and sidebar remounts", () => {
  bridge();

  const props = {
    repositories: [repo],
    tasks: [
      { ...task, status: "completed" },
      { ...task, id: "queued", goal: "Queued task", issue_number: null, status: "queued" },
    ],
    selected: task.id,
    open: vi.fn(),
  };

  const ui = render(<TaskNavigation {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Tasks, 1" }));
  expect(screen.queryByRole("button", { name: /Issue #1 · Work/ })).toBeNull();
  expect(screen.getByRole("button", { name: /Queued task.*Queued/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Working, 1" }));
  ui.rerender(<TaskNavigation {...props} selected="queued" />);

  expect(screen.getByRole("button", { name: "Tasks, 1" }).getAttribute("aria-expanded")).toBe(
    "false",
  );

  expect(screen.getByRole("button", { name: "Working, 1" }).getAttribute("aria-expanded")).toBe(
    "false",
  );

  ui.unmount();
  render(<TaskNavigation {...props} />);
  expect(screen.queryByRole("button", { name: /Queued task.*Queued/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Tasks, 1" }));
  expect(screen.getByRole("button", { name: /Issue #1 · Work/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Queued task.*Queued/ })).toBeNull();
});

it("flattens repositories, keeps unknown and managed repositories visible, and counts both queued and executing work", () => {
  bridge();

  render(
    <TaskNavigation
      repositories={[repo]}
      tasks={[
        { ...task, status: "completed" },
        {
          ...task,
          id: "missing",
          repo_id: "missing",
          goal: "Unknown source",
          status: "not_started",
        },
        { ...task, id: "managed", repo_id: null, goal: "Managed task", status: "not_started" },
        { ...task, id: "queued", goal: "Queued task", status: "queued" },
        { ...task, id: "active", goal: "Active task", status: "implementing" },
      ]}
      selected={null}
      open={vi.fn()}
    />,
  );

  expect(screen.queryByRole("button", { name: "fixture/repo" })).toBeNull();

  expect(
    screen.getByRole("button", { name: /Unknown source.*Repository unavailable/ }),
  ).toBeTruthy();

  expect(screen.getByRole("button", { name: /Managed task.*Managed workspace/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Tasks, 3" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Working, 2" })).toBeTruthy();

  expect(
    screen
      .getByRole("button", { name: /Queued task.*Queued/ })
      .querySelector(".execution-indicator"),
  ).toBeNull();
});

it("offers the same keyboard context menu for tasks without a repository", () => {
  bridge();

  render(
    <TaskNavigation
      repositories={[]}
      tasks={[{ ...task, repo_id: null, issue_number: null, goal: "Solo task" }]}
      selected={null}
      open={vi.fn()}
    />,
  );

  const row = screen.getByRole("button", { name: /Solo task.*Managed workspace/ });
  row.focus();
  fireEvent.keyDown(row, { key: "ContextMenu" });
  expect(screen.getByRole("menu", { name: "Solo task actions" })).toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(document.activeElement).toBe(row);
});

it("keeps exactly five named icon destinations, PR attention and the header create action", async () => {
  const { NavigationSidebar } = await import("../../src/app/NavigationSidebar");
  const { defaultSettings } = await import("../../backend/domain");
  const navigate = vi.fn();
  const newTask = vi.fn();
  const snapshot = { tasks: [], repositories: [], settings: defaultSettings, root: "/fixture" };

  const props = {
    width: 180,
    revision: 0,
    snapshot,
    page: "Repositories" as const,
    count: 2,
    taskId: null,
    newTask,
    navigate,
    open: vi.fn(),
    onError: vi.fn(),
    toggleSidebar: vi.fn(),
  };

  const ui = render(<NavigationSidebar {...props} />);
  const dock = screen.getByRole("navigation", { name: "Workspace tools" });

  expect(
    within(dock)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual(["Vibers", "Pull Requests", "Issues", "Usage", "Settings"]);

  expect(within(dock).getByText("2 need attention")).toBeTruthy();

  expect(within(dock).getByRole("button", { name: "Settings" }).getAttribute("aria-current")).toBe(
    "page",
  );

  for (const [name, destination] of [
    ["Vibers", "Vibers"],
    ["Pull Requests", "Scheduled"],
    ["Issues", "Issue Watch"],
    ["Usage", "Usage"],
    ["Settings", "Settings"],
  ]) {
    const button = within(dock).getByRole("button", { name });
    expect(button.title).toBe(name);
    fireEvent.click(button);
    expect(navigate).toHaveBeenLastCalledWith(destination);
  }

  fireEvent.click(screen.getByRole("button", { name: "New task" }));
  expect(newTask).toHaveBeenCalledOnce();
  expect(screen.queryByText("LOCAL")).toBeNull();
  expect(screen.queryByText(/agent slots|Local workspace/)).toBeNull();
  expect(screen.getByText("Vibestar")).toBeTruthy();
  expect(screen.queryByText("Tasks", { exact: true })).toBeNull();
  expect(screen.getByRole("button", { name: "Tasks, 0" }).closest(".sidebar-header")).toBeTruthy();
  const collapse = screen.getByRole("button", { name: "Collapse sidebar" });
  expect(collapse.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(collapse);
  expect(props.toggleSidebar).toHaveBeenCalledOnce();
  ui.rerender(<NavigationSidebar {...props} snapshot={null} />);

  expect((screen.getByRole("button", { name: "New task" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

it("ticks only recorded live execution and stops at the saved end timestamp", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T00:01:00Z"));
  const { rpc } = bridge();
  let status = "implementing";
  let ended: string | null = null;

  rpc.mockImplementation(async () => ({
    task: { ...task, status },
    executing: !ended,
    runs: [
      {
        started_at: "2026-11-06T00:00:00Z",
        ended_at: ended,
        status: ended ? "completed" : "running",
      },
    ],
  }));

  const props = { repositories: [repo], selected: null, open: vi.fn() };
  const ui = render(<TaskNavigation {...props} tasks={[{ ...task, status }]} revision={0} />);
  await act(async () => {});
  expect(screen.getByRole("button", { name: /1m 0s/ })).toBeTruthy();
  act(() => vi.advanceTimersByTime(2000));
  expect(screen.getByRole("button", { name: /1m 2s/ })).toBeTruthy();
  status = "paused";
  ended = "2026-11-06T00:01:02Z";
  ui.rerender(<TaskNavigation {...props} tasks={[{ ...task, status }]} revision={1} />);
  await act(async () => {});
  expect(screen.queryByRole("button", { name: /^Working,/ })).toBeNull();
  act(() => vi.advanceTimersByTime(60000));
  expect(screen.getByRole("button", { name: /1m 2s/ })).toBeTruthy();
  expect(ui.container.querySelector(".execution-indicator")).toBeNull();
  expect(rpc.mock.calls.map(([method]) => method)).toEqual(["task.detail", "task.detail"]);
});

it("recovers missing execution evidence on the next workspace revision without guessing a timer", async () => {
  const { rpc } = bridge();
  rpc.mockRejectedValueOnce(new Error("Core reconnecting"));

  const props = {
    repositories: [repo],
    tasks: [{ ...task, status: "implementing" }],
    selected: null,
    open: vi.fn(),
  };

  const ui = render(<TaskNavigation {...props} revision={0} />);
  await act(async () => {});
  expect(ui.container.querySelector(".sidebar-task-duration")).toBeNull();
  expect(ui.container.querySelector(".execution-indicator")).toBeNull();

  rpc.mockResolvedValue({
    task: props.tasks[0],
    executing: true,
    runs: [
      { started_at: new Date(Date.now() - 12000).toISOString(), ended_at: null, status: "running" },
    ],
  });

  ui.rerender(<TaskNavigation {...props} revision={1} />);
  await act(async () => {});
  expect(screen.getByRole("button", { name: /12s/ })).toBeTruthy();
  expect(ui.container.querySelector(".execution-indicator")).toBeNull();
  expect(rpc).toHaveBeenCalledTimes(2);
});

it("shows repository, creation age, title and the saved branch while retaining accessible issue and status details", () => {
  bridge();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-07T12:00:00Z"));
  const title = "Make the task feed dense and readable while keeping execution evidence accurate";

  const { container } = render(
    <TaskNavigation
      repositories={[repo]}
      tasks={[
        {
          ...task,
          status: "not_started",
          goal: title,
          issue_number: 9,
          created_at: "2026-11-07T10:00:00Z",
        },
      ]}
      selected={null}
      open={vi.fn()}
    />,
  );

  const row = screen.getByRole("button", { name: /Issue #9.*Created 2h ago/ });
  expect(row.title).toContain(title);
  expect(container.querySelector(".sidebar-task-metadata")?.textContent).toBe("repo2h");
  expect(container.querySelector(".sidebar-task-title")?.textContent).toBe(title);
  expect(container.querySelector(".sidebar-task-branch")?.textContent).toBe(task.branch_name);
  expect(container.querySelector(".sidebar-task-footer")).toBeNull();
  expect(container.querySelector(".sidebar-task-status")).toBeNull();
  expect(screen.queryByText("Not started")).toBeNull();
  expect(screen.queryByText("Issue #9")).toBeNull();
  expect(row.getAttribute("aria-label")).toContain("Not started");
  expect(row.title).toBe(title);
  expect(container.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-07T10:00:00Z");
  expect(container.querySelector("time")?.title).toMatch(/^Created /);
  expect(container.querySelector(".sidebar-task-duration")).toBeNull();
});

const searchableSidebar = async () => {
  const { NavigationSidebar } = await import("../../src/app/NavigationSidebar");
  const { defaultSettings } = await import("../../backend/domain");
  const { rpc } = bridge();
  const open = vi.fn();
  const newTask = vi.fn();

  const snapshot = {
    root: "/fixture",
    settings: defaultSettings,
    repositories: [repo, { ...repo, id: "other", owner: "second", name: "OtherRepo" }],
    tasks: [
      { ...task, goal: "Fix header spacing", issue_number: 9, status: "not_started" },
      {
        ...task,
        id: "active",
        repo_id: "other",
        goal: "Repair execution handoff",
        issue_number: 10,
        status: "implementing",
      },
      {
        ...task,
        id: "done",
        repo_id: "other",
        goal: "Update contributor guide",
        issue_number: 11,
        status: "completed",
      },
      {
        ...task,
        id: "archived",
        goal: "Archived header variant",
        issue_number: 12,
        status: "not_started",
        archived: true,
      },
    ],
  };

  const ui = render(
    <NavigationSidebar
      width={238}
      revision={0}
      snapshot={snapshot}
      page="Tasks"
      count={0}
      taskId={task.id}
      newTask={newTask}
      navigate={vi.fn()}
      open={open}
      onError={vi.fn()}
      toggleSidebar={vi.fn()}
    />,
  );

  await act(async () => {});
  return {
    ...ui,
    rpc,
    open,
    newTask,
    search: screen.getByRole("searchbox", { name: "Search tasks" }) as HTMLInputElement,
  };
};

it("filters loaded task titles, repositories, issue numbers and statuses immediately across both groups", async () => {
  const { container, rpc, open, newTask, search } = await searchableSidebar();
  const initialReads = [...rpc.mock.calls];
  expect(screen.queryByText("VIBESTAR")).toBeNull();
  for (const [query, titles, normal, working] of [
    ["  HEADER SPACING  ", ["Fix header spacing"], 1, 0],
    ["SECOND/OTHERREPO", ["Update contributor guide", "Repair execution handoff"], 1, 1],
    ["#10", ["Repair execution handoff"], 0, 1],
    ["issue 9", ["Fix header spacing"], 1, 0],
    ["COMPLETED", ["Update contributor guide"], 1, 0],
    ["implementing", ["Repair execution handoff"], 0, 1],
  ] as const) {
    fireEvent.change(search, { target: { value: query } });

    expect(
      [...container.querySelectorAll(".sidebar-task-title")]
        .map((element) => element.textContent)
        .sort(),
    ).toEqual([...titles].sort());

    expect(screen.getByRole("button", { name: `Tasks, ${normal}` })).toBeTruthy();

    expect(screen.queryByRole("button", { name: `Working, ${working}` }) !== null).toBe(
      working > 0,
    );
  }

  fireEvent.change(search, { target: { value: "no matching work" } });
  expect(screen.getByRole("status").textContent).toBe("No tasks match your search.");
  expect(container.querySelectorAll(".tree-task")).toHaveLength(0);
  expect(open).not.toHaveBeenCalled();
  search.focus();
  fireEvent.keyDown(search, { key: "Escape", isComposing: true });
  expect(search.value).toBe("no matching work");
  fireEvent.keyDown(search, { key: "Escape" });
  expect(search.value).toBe("");
  expect(document.activeElement).toBe(search);
  expect(container.querySelectorAll(".tree-task")).toHaveLength(3);
  expect(screen.queryByRole("status")).toBeNull();
  expect(container.querySelector(".tree-task.selected")?.getAttribute("aria-current")).toBe("page");
  fireEvent.click(screen.getByRole("button", { name: "New task" }));
  expect(newTask).toHaveBeenCalledOnce();
  expect(rpc.mock.calls).toEqual(initialReads);
});

it("preserves independent collapse and explicit archive visibility while searching", async () => {
  const { search } = await searchableSidebar();
  fireEvent.click(screen.getByRole("button", { name: "Tasks, 2" }));
  fireEvent.click(screen.getByRole("button", { name: "Working, 1" }));
  fireEvent.change(search, { target: { value: "archived header" } });
  expect(screen.getByRole("status").textContent).toBe("No tasks match your search.");

  expect(screen.getByRole("button", { name: "Tasks, 0" }).getAttribute("aria-expanded")).toBe(
    "false",
  );

  fireEvent.click(screen.getByRole("button", { name: "Show archived tasks" }));
  expect(screen.queryByRole("status")).toBeNull();

  expect(screen.getByRole("button", { name: "Tasks, 1" }).getAttribute("aria-expanded")).toBe(
    "false",
  );

  fireEvent.click(screen.getByRole("button", { name: "Tasks, 1" }));

  expect(
    screen.getByRole("button", { name: /Issue #12.*Archived header variant.*Archived/ }),
  ).toBeTruthy();

  fireEvent.keyDown(search, { key: "Escape" });

  expect(screen.getByRole("button", { name: "Tasks, 3" }).getAttribute("aria-expanded")).toBe(
    "true",
  );

  expect(screen.getByRole("button", { name: "Working, 1" }).getAttribute("aria-expanded")).toBe(
    "false",
  );

  expect(screen.getByRole("button", { name: "Hide archived tasks" })).toBeTruthy();
});

it.each([
  ["paused", "Paused"],
  ["failed", "Failed"],
  ["completed", "Completed"],
  ["awaiting_approval", "Review needed"],
  ["queued", "Queued"],
])("retains %s for accessibility without a visible status icon or label", (status, label) => {
  bridge();
  const title = "Refine compact task rows";

  const { container } = render(
    <TaskNavigation
      repositories={[repo]}
      tasks={[{ ...task, goal: title, status }]}
      selected={null}
      open={vi.fn()}
    />,
  );

  const row = screen.getByRole("button", { name: /Issue #1.*Refine compact task rows/ });
  const indicator = row.querySelector<HTMLElement>(".sidebar-task-status");
  expect(indicator).toBeNull();
  expect(row.getAttribute("aria-label")).toContain(label);
  expect(row.title).toBe(title);
  expect(screen.queryByText(label)).toBeNull();
  expect(screen.queryByText("Issue #1")).toBeNull();
  expect(container.querySelector(".sidebar-task-footer")).toBeNull();
});

it.each(["", "   "])(
  "omits missing branch metadata rather than substituting the repository base (%j)",
  (branch) => {
    bridge();

    const { container } = render(
      <TaskNavigation
        repositories={[repo]}
        tasks={[{ ...task, branch_name: branch }]}
        selected={null}
        open={vi.fn()}
      />,
    );

    expect(container.querySelector(".sidebar-task-branch")).toBeNull();
    expect(screen.queryByText(repo.base_branch)).toBeNull();
  },
);
