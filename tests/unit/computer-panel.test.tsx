// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ComputerPanel } from "../../apps/desktop/features/computer/ComputerPanel";
import type { CoreEvent } from "../../apps/core/domain";
import type { ComputerStatus } from "../../apps/core/computers/contracts";
import { mockDialog } from "../helpers/dialog";

vi.mock("../../apps/desktop/features/computer/ComputerDesktop", () => ({
  ComputerDesktop: () => <div>Interactive desktop</div>,
}));

vi.mock("../../apps/desktop/features/computer/ComputerTerminal", () => ({
  ComputerTerminal: () => <div>Interactive terminal</div>,
}));

const rpc = vi.fn();
let receive: (event: CoreEvent) => void;
const props = { supported: true, hide: vi.fn(), refresh: vi.fn(), settings: vi.fn() };

const stopped: ComputerStatus = {
  status: "stopped",
  error: null,
  docker: { ready: true, detail: "" },
  has_data: true,
};

beforeEach(() => {
  mockDialog();

  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: {
      rpc,
      subscribe: (callback: typeof receive) => {
        receive = callback;
        return vi.fn();
      },
    },
  });

  rpc.mockImplementation(async (method: string, { path }: { path?: string }) => {
    if (method === "computer.files") {
      return path
        ? { path, entries: [], text: "shared contents" }
        : { path: "", entries: [{ name: "source.txt", directory: false }], text: null };
    }

    if (method === "computer.terminal.open") {
      return { id: "shell-id" };
    }

    return null;
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("starts and resets the workspace computer after confirmation", async () => {
  render(<ComputerPanel {...props} status={stopped} />);
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(rpc).toHaveBeenCalledWith("computer.control", { action: "start" }));
  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect(screen.getByRole("dialog", { name: "Reset Shared Computer" })).toBeTruthy();
  expect(rpc).not.toHaveBeenCalledWith("computer.control", { action: "reset", confirmed: true });
  fireEvent.click(screen.getByRole("button", { name: "Reset computer" }));

  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("computer.control", { action: "reset", confirmed: true }),
  );
});

it("opens the desktop, shared files and terminal without a Viber selection", async () => {
  render(<ComputerPanel {...props} status={{ ...stopped, status: "ready" }} />);
  expect(screen.getByRole("status", { name: "Computer: Ready" })).toBeTruthy();
  expect(screen.getByText("Interactive desktop")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Files" }));
  fireEvent.click(await screen.findByRole("button", { name: "source.txt" }));
  expect(await screen.findByText("shared contents")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
  fireEvent.click(await screen.findByRole("button", { name: "Open shell" }));
  expect(await screen.findByText("Interactive terminal")).toBeTruthy();
  expect(rpc).toHaveBeenCalledWith("computer.terminal.open", {});
});

it("opens Execution settings when the helper is missing or stale", () => {
  render(<ComputerPanel {...props} supported={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Execution settings" }));
  expect(props.settings).toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
});

it("resynchronizes the shell when the helper comes back while the desktop stays ready", async () => {
  rpc.mockResolvedValueOnce({ id: "previous-shell" });
  render(<ComputerPanel {...props} status={{ ...stopped, status: "ready" }} />);
  fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
  expect(await screen.findByRole("button", { name: "Close shell" })).toBeTruthy();

  await act(async () => receive({ event: "runtime.status", data: { phase: "ready" } }));
  expect(await screen.findByRole("button", { name: "Open shell" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Close shell" })).toBeNull();
});
