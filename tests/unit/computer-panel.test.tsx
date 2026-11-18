// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ComputerPanel } from "../../apps/desktop/features/computer/ComputerPanel";
import { mockDialog } from "../helpers/dialog";
import type { CoreEvent } from "../../apps/core/domain";

vi.mock("../../apps/desktop/features/computer/ComputerTerminal", () => ({
  ComputerTerminal: () => <div>Interactive terminal</div>,
}));

const rpc = vi.fn();
let emit: (event: CoreEvent) => void;
const profileId = crypto.randomUUID();
const sessionId = crypto.randomUUID();

beforeEach(() => {
  mockDialog();

  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: {
      rpc,
      subscribe: (callback: typeof emit) => {
        emit = callback;
        return vi.fn();
      },
    },
  });

  rpc.mockImplementation(async (method: string, input: { path?: string }) => {
    if (method === "computer.status") {
      return { profile_id: profileId, status: "ready", error: null, session_id: sessionId };
    }

    if (method === "computer.files") {
      return input.path
        ? { path: input.path, entries: [], text: "real saved contents" }
        : { path: "", entries: [{ name: "source.txt", directory: false }], text: null };
    }

    return null;
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

it("connects lifecycle, terminal and setup controls to scoped IPC and requires destructive confirmation", async () => {
  const hide = vi.fn();

  const view = render(
    <ComputerPanel
      profileId={profileId}
      sessionId={sessionId}
      visible
      hide={hide}
      refreshProviders={vi.fn()}
    />,
  );

  await screen.findByText("ready");
  expect(rpc.mock.calls.map(([method]) => method)).toEqual(["computer.status"]);
  fireEvent.click(screen.getByRole("button", { name: "Start" }));

  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("computer.control", {
      profile_id: profileId,
      session_id: sessionId,
      action: "start",
    }),
  );

  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Reset" }).hasAttribute("disabled")).toBe(false),
  );

  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect(screen.getByRole("dialog", { name: "Confirm computer action" })).toBeTruthy();

  expect(
    rpc.mock.calls.filter(
      ([method, input]) => method === "computer.control" && input.action === "reset",
    ),
  ).toHaveLength(0);

  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("computer.control", {
      profile_id: profileId,
      session_id: sessionId,
      action: "reset",
      confirmed: true,
    }),
  );

  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Open shell" }).hasAttribute("disabled")).toBe(false),
  );

  fireEvent.click(screen.getByRole("button", { name: "Open shell" }));

  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("computer.terminal.open", {
      profile_id: profileId,
      session_id: sessionId,
    }),
  );

  fireEvent.click(screen.getByRole("button", { name: "Hide computer panel" }));
  expect(hide).toHaveBeenCalledOnce();
  view.unmount();
  expect(rpc.mock.calls.some(([method]) => method === "computer.terminal.close")).toBe(false);
});

it("browses and previews workspace files, persists the selected tab, and displays backend errors", async () => {
  const view = render(
    <ComputerPanel
      profileId={profileId}
      sessionId={sessionId}
      visible
      hide={vi.fn()}
      refreshProviders={vi.fn()}
    />,
  );

  await screen.findByText("ready");
  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
  fireEvent.click(await screen.findByRole("button", { name: "source.txt" }));
  expect(await screen.findByText("real saved contents")).toBeTruthy();

  expect(rpc).toHaveBeenCalledWith("computer.files", {
    profile_id: profileId,
    session_id: sessionId,
    path: "source.txt",
  });

  expect(localStorage.getItem("vibestar.computerTab")).toBe("files");
  view.unmount();

  render(
    <ComputerPanel
      profileId={profileId}
      sessionId={sessionId}
      visible
      hide={vi.fn()}
      refreshProviders={vi.fn()}
    />,
  );

  expect(screen.getByRole("tab", { name: "Files" }).getAttribute("aria-selected")).toBe("true");
  await screen.findByText("ready");

  emit({
    event: "computer.changed",
    data: {
      profile_id: profileId,
      status: "error",
      error: "Docker is unavailable",
      session_id: sessionId,
    },
  });

  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Docker is unavailable");
});
