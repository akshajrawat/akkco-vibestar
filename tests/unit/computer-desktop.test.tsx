// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComputerDesktop } from "../../apps/desktop/features/computer/ComputerDesktop";

afterEach(cleanup);

it("admits a later pointer move when an earlier move found the queue full", async () => {
  let unblock!: () => void;

  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });

  const rpc = vi.fn(async (method: string) => {
    if (method === "computer.desktop.frame") {
      return "fixture-frame";
    }

    if (method === "computer.desktop.input") {
      await blocked;
    }

    return null;
  });

  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });
  render(<ComputerDesktop />);

  const desktop = await screen.findByRole("button", {
    name: "Control the Shared Computer desktop",
  });

  vi.spyOn(desktop, "getBoundingClientRect").mockReturnValue({
    width: 1000,
    height: 640,
    left: 0,
    top: 0,
    right: 1000,
    bottom: 640,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });

  for (let index = 0; index < 64; index++) {
    fireEvent.keyDown(desktop, { key: "a" });
  }

  fireEvent.pointerMove(desktop, { buttons: 1, clientX: 30, clientY: 20 });
  await act(async () => unblock());
  expect(rpc.mock.calls.filter(([method]) => method === "computer.desktop.input")).toHaveLength(64);

  fireEvent.pointerMove(desktop, { buttons: 1, clientX: 40, clientY: 20 });

  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("computer.desktop.input", {
      controller_id: expect.any(String),
      input: { type: "pointer", phase: "move", x: 40, y: 20, button: 1 },
    }),
  );
});
