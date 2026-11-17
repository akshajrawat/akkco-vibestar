// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ViberChat } from "../../apps/desktop/features/flows/ViberChat";
import { viberDetail, viberProfile, viberWorkspace } from "../workspace/flow-fixtures";

vi.mock("../../apps/desktop/features/flows/ViberConversation", () => ({
  ViberConversation: () => <p>Existing conversation view</p>,
}));

vi.mock("../../apps/desktop/features/flows/ViberModelPicker", () => ({
  ViberModelPicker: ({
    execution,
    change,
  }: {
    execution: typeof viberProfile.execution;
    change: (value: typeof viberProfile.execution) => void;
  }) => (
    <button onClick={() => change({ ...execution, model: "session-only" })}>
      Model {execution.model}
    </button>
  ),
}));

const rpc = vi.fn();

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  localStorage.clear();
});

it("opens a Viber into chat without execution and reuses the existing APIs on explicit send, retaining a failed request for retry", async () => {
  const detail = viberDetail();
  const workspace = viberWorkspace(detail);
  let fail = true;

  rpc.mockImplementation(async (method: string) => {
    if (method === "providers.detect") return [];
    if (method === "viber.instances") return [];
    if (method === "task.createGeneral") return detail.task;
    if (method === "flow.workspace") return workspace;
    if (method === "task.detail") return detail;
    if (method === "viber.chat" && fail) {
      fail = false;
      throw new Error("Try again");
    }

    return {};
  });

  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });
  const edit = vi.fn();
  render(<ViberChat profile={viberProfile} revision={0} edit={edit} openTask={vi.fn()} />);

  expect(screen.getByRole("heading", { name: "Ready when you are." })).toBeTruthy();

  await waitFor(() => expect(rpc).toHaveBeenCalledWith("viber.instances", {}));
  expect(rpc.mock.calls.filter(([method]) => method !== "providers.detect")).toHaveLength(1);
  expect(document.querySelector(".flow-editor")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit Viber" }));
  expect(edit).toHaveBeenCalledOnce();
  expect(edit).toHaveBeenCalledWith(viberProfile);

  fireEvent.click(screen.getByRole("button", { name: "Model fixture-model" }));

  fireEvent.change(screen.getByRole("textbox", { name: `Message ${viberProfile.name}` }), {
    target: { value: "Explain this idea" },
  });

  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Try again");
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Existing conversation view");
  expect(screen.queryByRole("heading", { name: "Ready when you are." })).toBeNull();
  expect(document.querySelector(".viber-chat-welcome")).toBeNull();
  expect(rpc.mock.calls.filter(([method]) => method === "task.createGeneral")).toHaveLength(1);
  const sends = rpc.mock.calls.filter(([method]) => method === "viber.chat");
  expect(sends).toHaveLength(2);
  expect(sends[0]).toEqual(sends[1]);

  expect(sends[0][1]).toMatchObject({
    task_id: detail.task.id,
    node_id: workspace.revision.definition.nodes[0].id,
    profile_id: viberProfile.id,
    content: "Explain this idea",
    selection: { provider: "codex", model: "session-only", effort: "low" },
    history_ids: [],
  });

  expect(
    rpc.mock.calls.some(([method]) => method === "flow.start" || method === "profile.save"),
  ).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  expect(screen.getByRole("button", { name: "Model fixture-model" })).toBeTruthy();
});
