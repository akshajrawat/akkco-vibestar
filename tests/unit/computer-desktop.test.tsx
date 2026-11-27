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

  const control = await screen.findByRole("button", { name: "Control desktop" });
  fireEvent.click(control);
  const keyboard = screen.getByRole("textbox", { name: "Shared Computer keyboard input" });
  const desktop = screen.getByRole("img", { name: "Live Shared Computer desktop" }).parentElement!;

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
    fireEvent.input(keyboard, { target: { value: "a" } });
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

it("sends native text and committed composition once, and returns focus with F6 while preserving guest keys", async () => {
  const rpc = vi.fn(async (method: string) =>
    method === "computer.desktop.frame" ? "fixture-frame" : null,
  );

  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });
  render(<ComputerDesktop />);

  const control = await screen.findByRole("button", { name: "Control desktop" });
  fireEvent.click(control);
  const keyboard = screen.getByRole("textbox", { name: "Shared Computer keyboard input" });
  expect(document.activeElement).toBe(keyboard);

  for (const text of ["a", "é"]) {
    fireEvent.keyDown(keyboard, { key: text });
    fireEvent.input(keyboard, { target: { value: text } });
  }

  fireEvent.compositionStart(keyboard);
  fireEvent.input(keyboard, { isComposing: true, target: { value: "ni" } });
  fireEvent.keyDown(keyboard, { key: "Enter", isComposing: true });
  fireEvent.input(keyboard, { isComposing: true, target: { value: "你" } });
  fireEvent.compositionEnd(keyboard, { data: "你" });
  fireEvent.compositionStart(keyboard);
  fireEvent.input(keyboard, { isComposing: true, target: { value: "cancelled" } });
  fireEvent.compositionEnd(keyboard, { data: "" });

  expect(fireEvent.keyDown(keyboard, { key: "Tab" })).toBe(false);
  expect(fireEvent.keyDown(keyboard, { key: "l", ctrlKey: true })).toBe(false);
  expect(fireEvent.keyDown(keyboard, { key: "F6" })).toBe(false);
  expect(document.activeElement).toBe(control);

  await waitFor(() =>
    expect(
      rpc.mock.calls
        .filter(([method]) => method === "computer.desktop.input")
        .map((call) => (call as unknown as [string, { input: unknown }])[1].input),
    ).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "é" },
      { type: "text", text: "你" },
      { type: "key", keys: "Tab" },
      { type: "key", keys: "ctrl+l" },
    ]),
  );
});
