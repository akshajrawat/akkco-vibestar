// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { Composer } from "../../src/features/chat/Composer";
import { repairContext } from "../../src/features/pull-requests/repair/context";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

it("attaches current worktree files independently of the historical repair diff layer", async () => {
  const rpc = setup(async (_method, input) => {
    const historical = (input as { layer: string }).layer === "original";
    return {
      original: "base",
      modified: historical ? "historical PR content" : "current worktree content",
      unified: historical ? "historical PR diff" : "current repair diff",
      binary: false,
    };
  });

  const options = repairContext({
    id: "repair-context",
    layer: "original",
    selected: "spec.ts",
    files: [
      {
        path: "spec.ts",
        old_path: null,
        status: "M",
        staged: false,
        unstaged: true,
        insertions: 1,
        deletions: 1,
        binary: false,
      },
    ],
  });

  expect(
    await options.find((option) => option.label === "Reference a worktree file")!.load("spec.ts"),
  ).toEqual({
    label: "Worktree file: spec.ts",
    text: "current worktree content",
  });

  expect(
    await options.find((option) => option.label === "Include selected file diff")!.load(""),
  ).toEqual({ label: "Diff: spec.ts · original", text: "historical PR diff" });

  expect(rpc).toHaveBeenCalledWith(
    "repair.file",
    expect.objectContaining({ path: "spec.ts", layer: "repair" }),
  );

  expect(rpc).toHaveBeenCalledWith(
    "repair.file",
    expect.objectContaining({ path: "spec.ts", layer: "original" }),
  );
});

const setup = (handler?: (method: string, params?: unknown) => Promise<unknown>) => {
  const rpc = vi.fn(handler || (async () => null));
  window.innerWidth = 1600;

  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: { rpc },
  });

  return rpc;
};

it("grows long pasted drafts and preserves Enter, Shift+Enter, IME and disabled submission semantics", () => {
  const send = vi.fn();

  const props = {
    id: "composer-keys",
    label: "Message",
    placeholder: "Write",
    sendLabel: "Send",
    onSend: send,
    model: null,
    context: [],
    busy: false,
    hint: "Send explicitly.",
  };

  const ui = render(<Composer {...props} />);
  const input = screen.getByLabelText("Message");

  Object.defineProperty(input, "scrollHeight", {
    value: 600,
    configurable: true,
  });

  fireEvent.change(input, { target: { value: "long paste\n".repeat(50) } });
  expect((input as HTMLTextAreaElement).style.height).toBe("240px");
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  expect(send).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(send).toHaveBeenCalledTimes(1);
  ui.rerender(<Composer {...props} disabled />);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(send).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem("vibestar.draft.composer-keys")).toContain("long paste");
});

it("previews bounded context as inert text, persists chips per conversation and removes them explicitly", async () => {
  const source = {
    label: "Add note",
    input: "Note",
    load: async () => ({
      label: "Unsafe-looking note",
      text: '<img src=x onerror="alert(1)">'.repeat(300),
    }),
  };

  const props = {
    id: "composer-context",
    label: "Message",
    placeholder: "Write",
    sendLabel: "Send",
    onSend: vi.fn(),
    model: null,
    context: [source],
    busy: false,
    hint: "Send explicitly.",
  };

  const ui = render(<Composer {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Add context" }));
  fireEvent.click(screen.getByRole("button", { name: "Add note" }));

  fireEvent.change(screen.getByLabelText("Note"), {
    target: { value: "note" },
  });

  fireEvent.click(screen.getByRole("button", { name: "Attach context" }));
  await screen.findByText("Unsafe-looking note");
  expect(ui.container.querySelector("img")).toBeNull();
  expect(screen.getByText(/Snapshot truncated at 4,000/).textContent?.length).toBeLessThan(4500);
  const saved = JSON.parse(localStorage.getItem("vibestar.layout.composer-context")!);
  expect(saved.draftContext).toHaveLength(1);
  ui.unmount();
  render(<Composer {...props} />);
  expect(screen.getByText("Unsafe-looking note")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove Unsafe-looking note" }));
  expect(screen.queryByLabelText("Attached context")).toBeNull();
});
