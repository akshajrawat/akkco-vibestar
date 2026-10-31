// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { CoreEvent } from "../../src/lib/types";
import type { TaskTerminalSnapshot } from "../../backend/execution/terminals/task-terminals";

const terminal = vi.hoisted(() => ({ write: vi.fn(), reset: vi.fn(), focus: vi.fn() }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;

    rows = 24;

    write = terminal.write;

    reset = terminal.reset;

    focus = terminal.focus;

    open() {}

    loadAddon() {}

    attachCustomKeyEventHandler() {}

    dispose() {}

    writeln() {}

    onData() {
      return { dispose() {} };
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

import { TaskTerminal } from "../../src/components/shared/TaskTerminal";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}

      disconnect() {}
    },
  );

  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );

  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("shows shell-open failures within the terminal instead of leaving an unexplained closed shell", async () => {
  const onError = vi.fn();

  const rpc = vi.fn(async (method: string) => {
    if (method === "terminal.open")
      throw new Error("The agent owns this workspace. Stop it before opening a terminal.");
    return null;
  });

  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: { rpc, subscribe: () => () => {} },
  });

  render(
    <TaskTerminal
      task={{ id: "terminal-error", worktree_path: "/owned/task" }}
      onError={onError}
    />,
  );

  expect(
    await screen.findByText("The agent owns this workspace. Stop it before opening a terminal."),
  ).toBeTruthy();

  expect(onError).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Start terminal" })).toBeTruthy();
});

it("does not revive a terminal that exits before its open response is attached", async () => {
  let resolve!: (snapshot: TaskTerminalSnapshot) => void;
  let receive!: (event: CoreEvent) => void;

  const pending = new Promise<TaskTerminalSnapshot>((done) => {
    resolve = done;
  });

  const rpc = vi.fn((method: string) =>
    method === "terminal.open" ? pending : Promise.resolve(null),
  );

  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: {
      rpc,
      subscribe: (callback: typeof receive) => {
        receive = callback;
        return () => {};
      },
    },
  });

  render(
    <TaskTerminal task={{ id: "terminal-exit", worktree_path: "/owned/task" }} onError={vi.fn()} />,
  );

  await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith("terminal.open", expect.anything()));

  await act(async () => {
    receive({
      event: "terminal.output",
      task_id: "terminal-exit",
      session_id: "gone",
      text: "old output",
      data: { sequence: 2 },
    });

    receive({ event: "terminal.closed", task_id: "terminal-exit", session_id: "gone" });
    resolve({ session_id: "gone", output: "stale snapshot", sequence: 1 });
  });

  expect(screen.queryByRole("button", { name: "Close shell" })).toBeNull();
  expect(screen.getByText(/Shell closed/)).toBeTruthy();
  expect(terminal.write).not.toHaveBeenCalledWith("stale snapshot");
  expect(terminal.write).not.toHaveBeenCalledWith("old output");
});
