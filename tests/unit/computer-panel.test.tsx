// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import toast from "react-hot-toast";
import { ComputerPanel } from "../../apps/desktop/features/computer/ComputerPanel";
import { useComputer } from "../../apps/desktop/features/computer/useComputer";
import { GlobalNotifications } from "../../apps/desktop/app/GlobalNotifications";
import { App } from "../../apps/desktop/app/App";
import { TitleBar } from "../../apps/desktop/app/TitleBar";
import { NavigationSidebar } from "../../apps/desktop/app/NavigationSidebar";
import { notifications } from "../../apps/desktop/lib/notifications";
import type { CoreEvent } from "../../apps/core/domain";
import type { ComputerStatus } from "../../apps/core/computers/contracts";
import { mockDialog } from "../helpers/dialog";

vi.mock("../../apps/desktop/features/computer/ComputerDesktop", () => ({
  ComputerDesktop: () => <div>Interactive desktop</div>,
}));

const rpc = vi.fn();
const listeners = new Set<(event: CoreEvent) => void>();

const receive = (event: CoreEvent) => {
  listeners.forEach((listener) => listener(event));
};

const stopped: ComputerStatus = {
  status: "stopped",
  error: null,
  docker: { ready: true, detail: "" },
  has_data: true,
};

beforeEach(() => {
  mockDialog();
  listeners.clear();
  notifications.dismiss("runtime");
  notifications.setPreference("necessary");

  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );

  Object.defineProperty(window, "electronWindow", {
    configurable: true,
    value: {
      manualDragging: false,
      getState: async () => ({ maximized: false, fullscreen: false }),
      onStateChanged: () => () => {},
      minimize: async () => {},
      maximize: async () => {},
      close: async () => {},
      fullscreen: async () => {},
    },
  });

  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: {
      rpc,
      desktopSettings: async () => ({
        config: { distro: "Ubuntu", data_home: "", helper_path: "" },
        distros: ["Ubuntu"],
        native_windows: false,
      }),
      retryRuntime: vi.fn(),
      subscribe: (callback: (event: CoreEvent) => void) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    },
  });
});

afterEach(() => {
  cleanup();
  toast.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("labels the computer status outside the interactive desktop", () => {
  const view = render(<ComputerPanel supported status={{ ...stopped, status: "ready" }} />);
  expect(screen.getByRole("heading", { name: "Shared Computer" })).toBeTruthy();
  const ready = screen.getByRole("status", { name: "Computer: Ready" });
  expect(ready.textContent).toBe("Ready");
  expect(ready.parentElement?.nextElementSibling).toBe(screen.getByText("Interactive desktop"));

  expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Desktop" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Terminal" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Files" })).toBeNull();
  expect(screen.queryByText(/Linux \/ WSL helper/i)).toBeNull();
  expect(screen.queryByText(/Docker Engine/i)).toBeNull();

  view.rerender(<ComputerPanel supported status={stopped} />);
  expect(screen.getByRole("status", { name: "Computer: Stopped" }).textContent).toBe("Stopped");

  view.rerender(
    <ComputerPanel
      supported
      status={{ ...stopped, status: "starting", progress: "Building image" }}
    />,
  );

  expect(screen.getByText("Building image")).toBeTruthy();

  view.rerender(
    <ComputerPanel supported status={{ ...stopped, status: "error", error: "Chromium exited" }} />,
  );

  expect(screen.getByRole("alert").textContent).toBe("Chromium exited");

  view.rerender(<ComputerPanel supported={false} />);
  expect(screen.getByRole("status", { name: "Computer: Unavailable" })).toBeTruthy();
});

it("places the Computer icon button beside Minimize in TitleBar and omits it from NavigationSidebar", async () => {
  const toggleComputer = vi.fn();

  render(
    <>
      <NavigationSidebar
        collapsed={false}
        width={340}
        snapshot={null}
        profiles={[]}
        previews={[]}
        profilesError=""
        createViber={vi.fn()}
        selectViber={vi.fn()}
        openTool={vi.fn()}
        toggleSidebar={vi.fn()}
      />
      <TitleBar computerOpen={false} onToggleComputer={toggleComputer} />
    </>,
  );

  await waitFor(() => expect(screen.getByRole("button", { name: "Computer" })).toBeTruthy());
  const computerButton = screen.getByRole("button", { name: "Computer" });
  const minimizeButton = screen.getByRole("button", { name: "Minimize window" });
  expect(computerButton.textContent).toBe("");
  expect(computerButton.closest("aside")).toBeNull();
  expect(computerButton.nextElementSibling?.contains(minimizeButton)).toBe(true);
  fireEvent.click(computerButton);
  expect(toggleComputer).toHaveBeenCalledOnce();
});

const BootHarness = ({
  supported = true,
  migrationPending = false,
  snapshotReady = true,
}: {
  supported?: boolean;
  migrationPending?: boolean;
  snapshotReady?: boolean;
}) => {
  const computer = useComputer(supported, snapshotReady && !migrationPending);
  return (
    <GlobalNotifications
      preference="necessary"
      computer={{
        snapshotReady,
        migrationPending,
        supported,
        status: computer.status,
        didStart: computer.didStart,
        retry: computer.retry,
      }}
    />
  );
};

it("auto-starts Shared Computer on initial load, merges WSL + computer progress, and retries on failure", async () => {
  let resolveStart!: (status: ComputerStatus) => void;
  let attempt = 0;

  rpc.mockImplementation((method: string) => {
    if (method === "computer.status") {
      return Promise.resolve({
        ...stopped,
        status: "error",
        error: "Docker daemon is stopped",
        docker: { ready: false, detail: "Docker daemon is stopped" },
      });
    }

    if (method === "computer.control") {
      attempt++;
      if (attempt === 1) {
        return Promise.resolve({ ...stopped, status: "error", error: "Docker daemon is stopped" });
      }

      return new Promise<ComputerStatus>((resolve) => {
        resolveStart = resolve;
      });
    }

    return Promise.resolve({});
  });

  const view = render(<BootHarness snapshotReady={false} />);

  await act(async () => {
    receive({
      event: "runtime.status",
      text: "Starting WSL (Ubuntu)...",
      data: { phase: "starting" },
    });
  });

  expect(screen.getByText("Starting WSL (Ubuntu)...")).toBeTruthy();

  await act(async () => {
    receive({ event: "runtime.status", text: "Runtime ready", data: { phase: "ready" } });
    view.rerender(<BootHarness snapshotReady />);
  });

  await waitFor(() => expect(rpc).toHaveBeenCalledWith("computer.control", { action: "start" }));

  expect(await screen.findByText("Docker daemon is stopped")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Starting Shared Computer...")).toBeTruthy();

  await act(async () => {
    resolveStart({ ...stopped, status: "ready" });
  });

  expect(await screen.findByText("Vibestar ready")).toBeTruthy();
});

it("handles Linux auto-start without runtime.status events and defers while migration is pending", async () => {
  rpc.mockImplementation((method: string) => {
    if (method === "computer.status") {
      return Promise.resolve(stopped);
    }

    if (method === "computer.control") {
      return Promise.resolve({ ...stopped, status: "ready" });
    }

    return Promise.resolve({});
  });

  const view = render(<BootHarness migrationPending />);
  expect(rpc).not.toHaveBeenCalled();

  view.rerender(<BootHarness migrationPending={false} />);
  await waitFor(() => expect(rpc).toHaveBeenCalledWith("computer.control", { action: "start" }));
  expect(await screen.findByText("Vibestar ready")).toBeTruthy();
});

it("reports a startup RPC failure after the helper has announced progress", async () => {
  let rejectStart!: (reason: Error) => void;

  rpc.mockImplementation((method: string) => {
    if (method === "computer.status") {
      return Promise.resolve(stopped);
    }

    return new Promise<ComputerStatus>((_resolve, reject) => {
      rejectStart = reject;
    });
  });

  render(<BootHarness />);
  await screen.findByText("Starting Shared Computer...");

  await act(async () => {
    receive({ event: "computer.changed", data: { ...stopped, status: "starting" } });
    rejectStart(new Error("Shared Computer request timed out"));
  });

  expect(await screen.findByText("Shared Computer request timed out")).toBeTruthy();
});

it("leaves an already running desktop alone on Linux", async () => {
  rpc.mockResolvedValue({ ...stopped, status: "ready" });

  await act(async () => {
    render(<BootHarness />);
  });

  expect(rpc.mock.calls).toEqual([["computer.status", {}]]);
  expect(screen.queryByText("Starting Shared Computer...")).toBeNull();
  expect(screen.queryByText("Vibestar ready")).toBeNull();
});

it("keeps sidebar refresh available across WSL and Docker failures", async () => {
  const dockerDown: ComputerStatus = {
    ...stopped,
    status: "error",
    error: "Docker daemon is stopped",
    docker: { ready: false, detail: "Docker daemon is stopped" },
  };

  let helperReady = false;
  let autoStart = true;
  let resolveStart!: (status: ComputerStatus) => void;
  let computerStatus = dockerDown;
  const retryRuntime = vi.mocked(window.vibestar.retryRuntime);

  retryRuntime.mockImplementation(async () => {
    receive({ event: "runtime.status", data: { phase: "starting" } });
    helperReady = true;
    receive({ event: "runtime.status", data: { phase: "ready" } });
  });

  rpc.mockImplementation(async (method: string) => {
    if (method === "snapshot") {
      if (!helperReady) {
        throw { kind: "helper_disconnected", message: "WSL unavailable" };
      }

      return { settings: {}, capabilities: { shared_computer: 1 } };
    }

    if (method === "computer.status") {
      return computerStatus;
    }

    if (method === "computer.control") {
      if (autoStart) {
        autoStart = false;
        return dockerDown;
      }

      return new Promise<ComputerStatus>((resolve) => {
        resolveStart = resolve;
      });
    }

    return [];
  });

  render(<App />);
  const refresh = screen.getByRole("button", { name: "Refresh connection" });

  await waitFor(() =>
    expect(refresh.getAttribute("aria-description")).toBe("Execution helper disconnected"),
  );

  fireEvent.click(refresh);
  await waitFor(() => expect(refresh.getAttribute("aria-description")).toBe("Docker disconnected"));
  expect(retryRuntime).toHaveBeenCalledOnce();

  fireEvent.click(refresh);
  expect(refresh.getAttribute("aria-busy")).toBe("true");
  expect(refresh.querySelector(".sidebar-refresh-dot")).toBeTruthy();
  await act(async () => resolveStart(dockerDown));
  expect(refresh.getAttribute("aria-description")).toBe("Docker disconnected");

  fireEvent.click(refresh);

  await act(async () => {
    computerStatus = { ...stopped, status: "ready" };
    resolveStart(computerStatus);
  });

  expect(refresh.querySelector(".sidebar-refresh-dot")).toBeNull();

  expect(rpc.mock.calls.filter(([method]) => method === "computer.control")).toEqual([
    ["computer.control", { action: "start" }],
    ["computer.control", { action: "start" }],
    ["computer.control", { action: "start" }],
  ]);

  fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  expect(screen.getByRole("button", { name: "Refresh connection" })).toBe(refresh);
  const callsBeforeRefresh = rpc.mock.calls.length;
  await act(async () => fireEvent.click(refresh));
  expect(rpc.mock.calls.slice(callsBeforeRefresh)).toContainEqual(["computer.status", {}]);
  expect(retryRuntime).toHaveBeenCalledOnce();
});

it("confirms a Retry Reset and sends reset instead of starting", async () => {
  const incomplete = {
    ...stopped,
    status: "error" as const,
    error: "Volume removal failed",
    reset_pending: true,
  };

  rpc.mockResolvedValueOnce(incomplete).mockResolvedValueOnce({ ...stopped, has_data: false });

  const PanelHarness = () => {
    const computer = useComputer(true, true);
    return <ComputerPanel supported status={computer.status} reset={computer.reset} />;
  };

  render(<PanelHarness />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry Reset" }));
  expect(rpc.mock.calls).toEqual([["computer.status", {}]]);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Retry Reset" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm Reset" }));
  await screen.findByRole("status", { name: "Computer: Stopped" });

  expect(rpc.mock.calls).toEqual([
    ["computer.status", {}],
    ["computer.control", { action: "reset", confirmed: true }],
  ]);
});
