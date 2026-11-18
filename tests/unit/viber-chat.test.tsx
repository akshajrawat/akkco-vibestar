// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ViberChat } from "../../apps/desktop/features/flows/ViberChat";
import { viberProfile } from "../helpers/viber-fixtures";

vi.mock("../../apps/desktop/features/flows/ViberSessionChat", () => ({
  ViberSessionChat: () => <p>Existing conversation view</p>,
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

vi.mock("../../apps/desktop/hooks/useWorkspace", () => ({
  useProviders: () => ({ providers: [] }),
}));

const rpc = vi.fn();

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

  const repositoryId = crypto.randomUUID();
  let fail = true;

  rpc.mockImplementation(async (method: string) => {
    if (method === "snapshot") {
      return {
        repositories: [
          { id: repositoryId, owner: "owned", name: "repository" },
          { id: "disconnected", connected: false, owner: "hidden", name: "repository" },
        ],
      };
    }

    if (method === "providers.detect") {
      return [];
    }

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
  const edit = vi.fn();
  render(<ViberChat profile={viberProfile} revision={0} edit={edit} />);

  expect(screen.getByRole("heading", { name: "Ready when you are." })).toBeTruthy();

  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("viber.session.list", { profile_id: viberProfile.id }),
  );

  expect(rpc.mock.calls.filter(([method]) => method !== "providers.detect")).toHaveLength(2);
  expect(document.querySelector(".flow-editor")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit Viber" }));
  expect(edit).toHaveBeenCalledOnce();
  expect(edit).toHaveBeenCalledWith(viberProfile);

  fireEvent.click(screen.getByRole("combobox", { name: "Attach repository" }));
  fireEvent.click(screen.getByRole("option", { name: /owned\/repository/ }));
  expect(screen.queryByRole("option", { name: /hidden/ })).toBeNull();

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
  expect(rpc.mock.calls.filter(([method]) => method === "viber.session.create")).toHaveLength(1);

  expect(rpc).toHaveBeenCalledWith(
    "viber.session.create",
    expect.objectContaining({ repository_id: repositoryId }),
  );

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

  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  expect(screen.getByRole("button", { name: "Model fixture-model" })).toBeTruthy();
});

it("defaults to isolated files and keeps repository attachment optional, searchable and removable", async () => {
  const repository = { id: crypto.randomUUID(), owner: "owned", name: "repo" };

  rpc.mockImplementation(async (method: string) =>
    method === "snapshot" ? { repositories: [repository] } : [],
  );

  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });
  render(<ViberChat profile={viberProfile} revision={0} edit={vi.fn()} />);
  expect(screen.queryByRole("combobox", { name: "Repository workspace" })).toBeNull();
  fireEvent.click(screen.getByRole("combobox", { name: "Attach repository" }));
  await screen.findByRole("option", { name: "owned/repo" });

  fireEvent.change(screen.getByRole("combobox", { name: "Search attach repository" }), {
    target: { value: "owned" },
  });

  fireEvent.click(screen.getByRole("option", { name: "owned/repo" }));
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Attach repository" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Remove repository" }));
  expect(screen.getByRole("combobox", { name: "Attach repository" })).toBeTruthy();

  fireEvent.change(screen.getByRole("textbox", { name: `Message ${viberProfile.name}` }), {
    target: { value: "Hello" },
  });

  fireEvent.click(screen.getByRole("button", { name: "Send message" }));

  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "viber.session.create",
      expect.not.objectContaining({ repository_id: expect.anything() }),
    ),
  );
});
