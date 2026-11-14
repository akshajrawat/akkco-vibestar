// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import toast from "react-hot-toast";

import type { CoreEvent } from "../../backend/domain";
import { defaultSettings } from "../../backend/domain";
import type { Snapshot } from "../../src/lib/types";
import { GlobalNotifications } from "../../src/app/GlobalNotifications";
import { useTaskNotifications } from "../../src/app/useTaskNotifications";
import { notifications } from "../../src/lib/notifications";
import { WorkspaceOverlay } from "../../src/components/ui/WorkspaceOverlay";
import { mockDialog } from "../helpers/dialog";

let listener: (event: CoreEvent) => void;
const retry = vi.fn();

beforeEach(() => {
  mockDialog();

  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );

  retry.mockResolvedValue(undefined);

  window.vibestar = {
    subscribe: (callback: (event: CoreEvent) => void) => {
      listener = callback;
      return () => {};
    },
    desktopSettings: async () => ({
      config: { distro: "Ubuntu", data_home: "", helper_path: "" },
      distros: ["Ubuntu"],
      native_windows: true,
    }),
    retryRuntime: retry,
  } as unknown as typeof window.vibestar;
});

afterEach(() => {
  cleanup();
  act(() => toast.remove());
  for (const id of ["optional", "error", "approval", "warning", "runtime", "duplicate", "modal"])
    notifications.dismiss(id);
  notifications.setPreference("necessary");
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("filters optional messages globally while keeping errors, input requests and blocking warnings", () => {
  const ui = render(<GlobalNotifications />);

  act(() => {
    notifications.success("Optional completion", { id: "optional" });
    notifications.error("Operation failed", { id: "error" });
    notifications.information("Approval required", { id: "approval", essential: true });
    notifications.warning("Runtime blocked", { id: "warning", essential: true });
  });

  expect(screen.queryByText("Optional completion")).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("Operation failed");
  expect(screen.getByText("Approval required")).toBeTruthy();
  expect(screen.getByText("Runtime blocked")).toBeTruthy();
  ui.rerender(<GlobalNotifications preference="all" />);
  expect(localStorage.getItem("vibestar.notificationPreference")).toBe("all");

  act(() => {
    notifications.success("Optional completion", { id: "optional" });
  });

  expect(screen.getByText("Optional completion")).toBeTruthy();
  ui.rerender(<GlobalNotifications />);
  expect(localStorage.getItem("vibestar.notificationPreference")).toBe("all");
});

it("deduplicates repeated failures and replaces a persistent progress notification through recovery", async () => {
  render(<GlobalNotifications />);

  act(() => {
    notifications.error("Repeated failure", { id: "duplicate" });
    notifications.error("Repeated failure", { id: "duplicate" });
  });

  expect(screen.getAllByText("Repeated failure")).toHaveLength(1);

  act(() =>
    listener({
      event: "runtime.status",
      text: "Preparing Vibestar runtime...",
      data: { phase: "preparing", essential: true },
    }),
  );

  expect(screen.getByText("Preparing Vibestar runtime...")).toBeTruthy();

  act(() =>
    listener({
      event: "runtime.status",
      text: "Installing dependencies...",
      data: { phase: "dependencies", essential: true },
    }),
  );

  expect(screen.queryByText("Preparing Vibestar runtime...")).toBeNull();
  expect(document.querySelectorAll(".notification-progress")).toHaveLength(1);

  act(() =>
    listener({ event: "runtime.status", text: "Installation failed", data: { phase: "failed" } }),
  );

  expect(document.querySelectorAll(".notification-progress")).toHaveLength(0);
  retry.mockRejectedValueOnce(new Error("Retry failed"));
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Retry failed");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(retry).toHaveBeenCalledTimes(2));
  act(() => listener({ event: "runtime.status", data: { phase: "ready" } }));
  expect(screen.queryByText("Runtime ready")).toBeNull();
});

it("always reports task input requests and filters completion according to the saved preference", () => {
  render(<GlobalNotifications />);

  const task: Snapshot["tasks"][number] = {
    id: "notification-task",
    repo_id: "fixture",
    issue_number: 1,
    issue_url: "https://github.com/fixture/fixture/issues/1",
    claimed_scope: "",
    notes: "",
    branch_name: "fixture",
    base_branch: "main",
    base_commit_sha: "fixture",
    worktree_path: "/fixture",
    created_at: "2026-11-14T00:00:00Z",
    updated_at: "2026-11-14T00:00:00Z",
    stage: 0,
    error: null,
    issue: { title: "Fixture task" },
    status: "running",
  };

  const snapshot: Snapshot = {
    repositories: [],
    tasks: [task],
    root: "/fixture",
    settings: defaultSettings,
  };

  const open = vi.fn();

  const hook = renderHook(({ value }) => useTaskNotifications(value, open), {
    initialProps: { value: snapshot },
  });

  hook.rerender({ value: { ...snapshot, tasks: [{ ...task, status: "awaiting_approval" }] } });
  expect(screen.getByText("Fixture task needs your input")).toBeTruthy();
  hook.rerender({ value: { ...snapshot, tasks: [{ ...task, status: "completed" }] } });
  expect(screen.queryByText("Fixture task completed")).toBeNull();

  act(() => {
    notifications.setPreference("all");
  });

  hook.rerender({ value: snapshot });
  hook.rerender({ value: { ...snapshot, tasks: [{ ...task, status: "completed" }] } });
  expect(screen.getByText("Fixture task completed")).toBeTruthy();
  notifications.dismiss("task:notification-task");
});

it("keeps optional startup progress and success visible with All notifications", () => {
  render(<GlobalNotifications preference="all" />);

  act(() =>
    listener({
      event: "runtime.status",
      text: "Starting WSL (Ubuntu)...",
      data: { phase: "starting" },
    }),
  );

  expect(screen.getByText("Starting WSL (Ubuntu)...")).toBeTruthy();
  act(() => listener({ event: "runtime.status", data: { phase: "ready" } }));
  expect(screen.getByText("Runtime ready")).toBeTruthy();
  expect(screen.queryByText("Starting WSL (Ubuntu)...")).toBeNull();
});

it("places notifications in the active native modal without taking keyboard focus", async () => {
  const action = vi.fn();

  render(
    <>
      <GlobalNotifications />
      <WorkspaceOverlay label="Example dialog" onClose={vi.fn()}>
        <button>Dialog control</button>
      </WorkspaceOverlay>
    </>,
  );

  const control = screen.getByRole("button", { name: "Dialog control" });
  control.focus();

  act(() => {
    notifications.error("Modal failure", {
      id: "modal",
      action: { label: "Try again", run: action },
    });
  });

  await waitFor(() =>
    expect(screen.getByRole("dialog").contains(screen.getByText("Modal failure"))).toBe(true),
  );

  expect(document.activeElement).toBe(control);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(action).toHaveBeenCalledOnce());
});
