// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { defaultSettings } from "../../apps/core/domain";
import { ViberChat } from "../../apps/desktop/features/vibers/ViberChat";
import { updateTaskView } from "../../apps/desktop/lib/taskView";
import { mockDialog } from "../helpers/dialog";
import { viberProfile } from "../helpers/viber-fixtures";

vi.mock("../../apps/desktop/features/vibers/ViberSessionChat", () => ({
  ViberSessionChat: () => <p>Existing conversation view</p>,
}));

vi.mock("../../apps/desktop/features/vibers/ViberModelPicker", () => ({
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

vi.mock("../../apps/desktop/hooks/useWorkspace", () => ({
  useProviders: () => ({ providers: [] }),
}));

const rpc = vi.fn();

beforeEach(mockDialog);

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  localStorage.clear();
});

it("opens a Viber without execution and uses standalone sessions on explicit send, retaining a failed request for retry", async () => {
  const session = {
    id: crypto.randomUUID(),
    profile_id: viberProfile.id,
    title: "Explain this idea",
    selection: { provider: "codex", model: "session-only", effort: "low" },
  };

  let fail = true;

  rpc.mockImplementation(async (method: string) => {
    if (method === "viber.session.list") {
      return [];
    }

    if (method === "viber.session.create") {
      return session;
    }

    if (method === "viber.session.send" && fail) {
      fail = false;
      throw new Error("Try again");
    }

    return {};
  });

  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });
  render(<ViberChat profile={viberProfile} revision={0} />);

  expect(screen.getByRole("status").textContent).toBe("Opening conversation…");
  expect(screen.queryByRole("textbox")).toBeNull();

  expect(
    (await screen.findByText(viberProfile.name, { selector: "strong" })).parentElement?.textContent,
  ).toBe(`Hello, I’m ${viberProfile.name}. What can I help you with?`);

  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("viber.session.list", { profile_id: viberProfile.id }),
  );

  expect(rpc).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Edit Viber" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Attach repository" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Model fixture-model" }));

  fireEvent.change(screen.getByRole("textbox", { name: `Message ${viberProfile.name}` }), {
    target: { value: "Explain this idea" },
  });

  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Try again");
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Existing conversation view");
  expect(screen.queryByText(viberProfile.name, { selector: "strong" })).toBeNull();
  expect(document.querySelector(".viber-chat-welcome")).toBeNull();
  expect(rpc.mock.calls.filter(([method]) => method === "viber.session.create")).toHaveLength(1);

  expect(rpc).toHaveBeenCalledWith("viber.session.create", {
    request_id: expect.any(String),
    profile_id: viberProfile.id,
    selection: session.selection,
  });

  const sends = rpc.mock.calls.filter(([method]) => method === "viber.session.send");
  expect(sends).toHaveLength(2);
  expect(sends[0]).toEqual(sends[1]);

  expect(sends[0][1]).toMatchObject({
    session_id: session.id,
    profile_id: viberProfile.id,
    content: "Explain this idea",
    selection: { provider: "codex", model: "session-only", effort: "low" },
    history_ids: [],
  });

  expect(
    rpc.mock.calls.some(([method]) =>
      ["flow.start", "profile.save", "task.createGeneral", "flow.workspace", "viber.chat"].includes(
        method,
      ),
    ),
  ).toBe(false);

  expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Chat history" })).toBeNull();
});

it("opens an existing repository-linked conversation without changing its workspace", async () => {
  rpc.mockResolvedValue([{ id: crypto.randomUUID(), repository_id: crypto.randomUUID() }]);
  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });
  render(<ViberChat profile={viberProfile} revision={0} />);
  await screen.findByText("Existing conversation view");
  expect(rpc.mock.calls).toEqual([["viber.session.list", { profile_id: viberProfile.id }]]);
});

it("keeps a saved request ID for an unlinked draft and retains text attachments", async () => {
  const sessionId = crypto.randomUUID();

  rpc.mockImplementation(async (method: string) =>
    method === "viber.session.list" ? [] : { id: sessionId },
  );

  const profile = { ...viberProfile, id: crypto.randomUUID() };
  const draftId = `viber:${profile.id}:new-chat`;
  const content = "Hello";
  const { provider, model, effort } = profile.execution;
  const selection = { provider, model, effort };

  updateTaskView(draftId, {
    draft: content,
    messageRequest: {
      id: sessionId,
      signature: JSON.stringify({ content, profile_id: profile.id, selection, repositoryId: "" }),
    },
  });

  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });
  render(<ViberChat profile={profile} revision={0} />);
  fireEvent.click(await screen.findByRole("button", { name: "Add context" }));
  fireEvent.click(screen.getByRole("button", { name: "Text" }));

  fireEvent.change(screen.getByRole("textbox", { name: "Context text" }), {
    target: { value: "Sample context" },
  });

  fireEvent.click(screen.getByRole("button", { name: "Attach context" }));
  await screen.findByText("Attached text");
  fireEvent.click(screen.getByRole("button", { name: "Remove Attached text" }));
  expect(screen.queryByText("Attached text")).toBeNull();

  const message = screen.getByRole("textbox", { name: `Message ${profile.name}` });
  fireEvent.keyDown(message, { key: "Enter", shiftKey: true });
  fireEvent.keyDown(message, { key: "Enter", isComposing: true });
  expect(rpc.mock.calls.some(([method]) => method === "viber.session.create")).toBe(false);
  fireEvent.keyDown(message, { key: "Enter" });

  await screen.findByText("Existing conversation view");

  expect(rpc).toHaveBeenCalledWith("viber.session.create", {
    request_id: sessionId,
    profile_id: profile.id,
    selection,
  });
});

it("omits the Computer toggle from the composer and applies Viber Workspace sharing permissions", async () => {
  const sessionId = crypto.randomUUID();

  rpc.mockImplementation(async (method: string) =>
    method === "viber.session.list" ? [] : { id: sessionId },
  );

  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });

  const view = render(
    <ViberChat
      profile={viberProfile}
      revision={0}
      computerSupported
      settings={{
        ...defaultSettings,
        allow_viber_communication: true,
        viber_workspace_permission: "always-ask",
      }}
    />,
  );

  expect(screen.queryByRole("button", { name: /Computer/i })).toBeNull();
  const input = await screen.findByRole("textbox", { name: `Message ${viberProfile.name}` });
  fireEvent.change(input, { target: { value: "Share via computer" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(screen.getByRole("dialog", { name: "Shared workspace permission" })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog", { name: "Shared workspace permission" })).toBeNull();
  expect(rpc.mock.calls.some(([method]) => method === "viber.session.send")).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  fireEvent.click(screen.getByRole("button", { name: "Allow for this turn" }));
  await screen.findByText("Existing conversation view");

  expect(rpc).toHaveBeenCalledWith(
    "viber.session.send",
    expect.objectContaining({
      content: "Share via computer",
      shared_computer: true,
    }),
  );

  rpc.mockClear();
  const autoProfile = { ...viberProfile, id: crypto.randomUUID() };

  view.rerender(
    <ViberChat
      key={autoProfile.id}
      profile={autoProfile}
      revision={0}
      computerSupported
      settings={{
        ...defaultSettings,
        allow_viber_communication: true,
        viber_workspace_permission: "full-permission",
      }}
    />,
  );

  fireEvent.change(await screen.findByRole("textbox", { name: `Message ${autoProfile.name}` }), {
    target: { value: "Auto share" },
  });

  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Existing conversation view");

  expect(rpc).toHaveBeenCalledWith(
    "viber.session.send",
    expect.objectContaining({
      content: "Auto share",
      shared_computer: true,
    }),
  );
});
