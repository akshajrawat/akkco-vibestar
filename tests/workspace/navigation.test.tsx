// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { TaskNavigation } from "../../src/components/TaskNavigation";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
  const rpc = vi.fn(async () => null);
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
  render(
    <TaskNavigation
      repositories={[repo]}
      tasks={[task]}
      selected={task.id}
      open={open}
    />,
  );
  const row = screen.getByRole("button", { name: /#1 Work.*Review needed/ });
  row.focus();
  fireEvent.keyDown(row, { key: "F10", shiftKey: true });
  const menu = screen.getByRole("menu", { name: "Task #1 actions" });
  expect(document.activeElement).toBe(
    within(menu).getByRole("menuitem", { name: "Open" }),
  );
  expect(open).not.toHaveBeenCalled();
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  expect(document.activeElement).toBe(
    within(menu).getByRole("menuitem", { name: "Delete task data…" }),
  );
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(row);
});

it("uses existing owner-checked editor RPCs and copies exact task references", async () => {
  const { rpc, copy } = bridge();
  render(
    <TaskNavigation
      repositories={[repo]}
      tasks={[task]}
      selected={null}
      open={vi.fn()}
    />,
  );
  fireEvent.contextMenu(screen.getByRole("button", { name: /#1 Work/ }), {
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
  render(
    <TaskNavigation
      repositories={[repo]}
      tasks={[task]}
      selected={null}
      open={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByLabelText("Actions for task #1"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete task data…" }));
  const dialog = screen.getByRole("dialog", { name: "Delete task data" });
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(rpc).not.toHaveBeenCalled();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(rpc).not.toHaveBeenCalled();
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
  expect(
    (screen.getByRole("menuitem", { name: "Archive" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (
      screen.getByRole("menuitem", {
        name: "Delete task data…",
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
