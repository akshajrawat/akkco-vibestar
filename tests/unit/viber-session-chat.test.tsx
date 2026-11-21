// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ViberSessionChat } from "../../apps/desktop/features/vibers/ViberSessionChat";
import { viberProfile } from "../helpers/viber-fixtures";
import { mockDialog } from "../helpers/dialog";

vi.mock("../../apps/desktop/hooks/useWorkspace", () => ({
  useProviders: () => ({
    providers: [
      {
        provider: "codex",
        models: [{ id: "persisted-model", supportedEfforts: ["low"] }],
      },
      {
        provider: "antigravity",
        models: [
          {
            id: "gemini-3.8-flash-medium",
            label: "Gemini 3.8 Flash (Medium)",
            supportedEfforts: ["medium"],
          },
          {
            id: "gemini-3.8-flash-high",
            label: "Gemini 3.8 Flash (High)",
            supportedEfforts: ["high"],
          },
        ],
      },
    ],
  }),
}));

beforeEach(mockDialog);

vi.mock("../../apps/desktop/features/chat/AgentTimeline", () => ({
  AgentTimeline: ({ messages }: { messages: { id: string; content: string }[] }) => (
    <div>
      {messages.map((message) => (
        <p key={message.id}>{message.content}</p>
      ))}
    </div>
  ),
}));

const rpc = vi.fn();
const sessionId = crypto.randomUUID();
const userId = crypto.randomUUID();
const answerId = crypto.randomUUID();

const stored = {
  session: {
    id: sessionId,
    profile_id: viberProfile.id,
    selection: { provider: "codex", model: "persisted-model", effort: "low" },
  },
  messages: [
    { id: userId, role: "user", content: "Previous question", status: "completed" },
    { id: answerId, role: "assistant", content: "Previous answer", status: "completed" },
  ],
  runs: [],
  events: [],
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  localStorage.clear();
});

it("restores a saved session's model selection and uses native context, with idempotent retry", async () => {
  let fail = true;

  rpc.mockImplementation(async (method: string) => {
    if (method === "viber.session.detail") {
      return stored;
    }

    if (method === "viber.session.send" && fail) {
      fail = false;
      throw new Error("Retry this send");
    }

    return {};
  });

  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });
  render(<ViberSessionChat sessionId={sessionId} profile={viberProfile} revision={0} />);
  await screen.findByText("Previous answer");

  const draft = screen.getByRole("textbox", {
    name: `Message ${viberProfile.name}`,
  }) as HTMLTextAreaElement;

  const picker = screen.getByRole("combobox", { name: "Model" });
  expect(picker.textContent).toBe("Persisted Model Low");
  fireEvent.change(draft, { target: { value: "Follow up" } });
  fireEvent.click(picker);
  fireEvent.click(screen.getByRole("button", { name: "Antigravity" }));
  fireEvent.click(screen.getByRole("option", { name: "Gemini 3.8 Flash" }));
  fireEvent.click(screen.getByRole("button", { name: "High" }));
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Search model" }), { key: "Escape" });

  expect(picker.getAttribute("aria-expanded")).toBe("false");
  expect(draft.value).toBe("Follow up");
  expect(rpc.mock.calls.map(([method]) => method)).toEqual(["viber.session.detail"]);

  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Retry this send");
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));

  await waitFor(() =>
    expect(rpc.mock.calls.filter(([method]) => method === "viber.session.send")).toHaveLength(2),
  );

  const sends = rpc.mock.calls.filter(([method]) => method === "viber.session.send");
  expect(sends[0]).toEqual(sends[1]);

  expect(sends[0][1]).toMatchObject({
    session_id: sessionId,
    profile_id: viberProfile.id,
    content: "Follow up",
    history_ids: [],
    selection: { provider: "antigravity", model: "gemini-3.8-flash-high", effort: "high" },
  });

  await waitFor(() => expect(draft.value).toBe(""));
});

it("keeps the draft when model validation blocks a send", async () => {
  const session = crypto.randomUUID();

  rpc.mockResolvedValue({
    ...stored,
    session: {
      ...stored.session,
      id: session,
      selection: { ...stored.session.selection, effort: "high" },
    },
  });

  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });
  render(<ViberSessionChat sessionId={session} profile={viberProfile} revision={0} />);
  await screen.findByText(/does not support 'high' effort/);

  const draft = screen.getByRole("textbox", {
    name: `Message ${viberProfile.name}`,
  }) as HTMLTextAreaElement;

  fireEvent.change(draft, { target: { value: "Keep this until the model is corrected" } });

  expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(
    true,
  );

  fireEvent.keyDown(draft, { key: "Enter" });

  expect(rpc.mock.calls.map(([method]) => method)).toEqual(["viber.session.detail"]);
  expect(draft.value).toBe("Keep this until the model is corrected");
});

it("keeps an unsent draft when the provider fails an accepted turn", async () => {
  const session = crypto.randomUUID();
  const turn = { id: crypto.randomUUID(), role: "user", content: "Submitted question" };
  const detail = { ...stored, session: { ...stored.session, id: session } };

  rpc
    .mockResolvedValueOnce({ ...detail, messages: [{ ...turn, status: "pending" }] })
    .mockResolvedValueOnce({
      ...detail,
      messages: [{ ...turn, status: "failed", error: "Provider exited unexpectedly" }],
    });

  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });
  const view = render(<ViberSessionChat sessionId={session} profile={viberProfile} revision={0} />);
  await screen.findByText("Working…");

  const draft = screen.getByRole("textbox", {
    name: `Message ${viberProfile.name}`,
  }) as HTMLTextAreaElement;

  fireEvent.change(draft, { target: { value: "A separate unsent question" } });
  view.rerender(<ViberSessionChat sessionId={session} profile={viberProfile} revision={1} />);
  await screen.findByText("Provider exited unexpectedly");

  expect(screen.getByText("Submitted question")).toBeTruthy();
  expect(draft.value).toBe("A separate unsent question");
});

it("disables overlapping turns, shows interrupted errors and stops only the current session", async () => {
  const pending = {
    ...stored,
    messages: [
      ...stored.messages,
      {
        id: crypto.randomUUID(),
        role: "user",
        content: "Running question",
        status: "pending",
        error: null,
      },
    ],
  };

  rpc.mockImplementation(async (method: string) =>
    method === "viber.session.detail" || method === "viber.session.cancel" ? pending : {},
  );

  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });

  const view = render(
    <ViberSessionChat sessionId={sessionId} profile={viberProfile} revision={0} />,
  );

  await screen.findByText("Running question");

  fireEvent.change(screen.getByRole("textbox", { name: `Message ${viberProfile.name}` }), {
    target: { value: "Do not overlap" },
  });

  expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("Working…");
  fireEvent.click(screen.getByRole("button", { name: "Stop response" }));

  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("viber.session.cancel", {
      session_id: sessionId,
      profile_id: viberProfile.id,
    }),
  );

  rpc.mockImplementation(async () => ({
    ...stored,
    messages: [
      ...stored.messages,
      {
        id: crypto.randomUUID(),
        role: "user",
        content: "Interrupted question",
        status: "interrupted",
        error: "Execution interrupted",
      },
    ],
  }));

  view.rerender(<ViberSessionChat sessionId={sessionId} profile={viberProfile} revision={1} />);
  await screen.findByText("Execution interrupted");
  expect(screen.queryByRole("button", { name: "Stop response" })).toBeNull();

  expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  const dialog = await screen.findByRole("dialog", { name: "Review previous work" });
  expect(dialog).toBeTruthy();
  expect(rpc.mock.calls.filter(([method]) => method === "viber.session.send")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  fireEvent.click(screen.getByRole("button", { name: "I understand, continue" }));

  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "viber.session.send",
      expect.objectContaining({
        content: "Interrupted question",
        acknowledge_uncertain: true,
      }),
    ),
  );
});

it("sends beyond 50 saved messages and starts a fresh thread only when explicitly selected", async () => {
  const messages = Array.from({ length: 60 }, (_, index) => ({
    id: crypto.randomUUID(),
    role: "assistant",
    content: `Answer ${index}`,
    status: "completed",
  }));

  rpc.mockImplementation(async (method: string) =>
    method === "viber.session.detail" ? { ...stored, messages } : {},
  );

  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });
  render(<ViberSessionChat sessionId={sessionId} profile={viberProfile} revision={0} />);
  await screen.findByText("Answer 59");

  fireEvent.change(screen.getByRole("textbox", { name: `Message ${viberProfile.name}` }), {
    target: { value: "Continue" },
  });

  fireEvent.click(screen.getByRole("combobox", { name: "Conversation menu" }));
  fireEvent.click(screen.getByRole("option", { name: "Reset AI context" }));
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));

  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "viber.session.send",
      expect.objectContaining({
        history_ids: [],
        content: "Continue",
        new_thread: true,
      }),
    ),
  );
});

it("bypasses recovery only with backend evidence and shows the workspace name without its path", async () => {
  rpc.mockImplementation(async () => ({
    ...stored,
    recovery_required: false,
    workspace: { repository: "owned/repo", path: "/private/workspaces/owned/files" },
    messages: [
      {
        id: crypto.randomUUID(),
        role: "user",
        content: "Invalid model request",
        status: "failed",
        error: "Model not supported",
      },
    ],
  }));

  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });
  render(<ViberSessionChat sessionId={crypto.randomUUID()} profile={viberProfile} revision={0} />);
  await screen.findByText("Workspace · owned/repo");
  expect(screen.queryByText(/private\/workspaces/)).toBeNull();
  expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));

  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "viber.session.send",
      expect.objectContaining({ content: "Invalid model request" }),
    ),
  );

  expect(screen.queryByRole("dialog")).toBeNull();

  expect(
    rpc.mock.calls.find(([method]) => method === "viber.session.send")?.[1].acknowledge_uncertain,
  ).toBeUndefined();
});

it("retains request identity across remounts after a lost transport response", async () => {
  const session = crypto.randomUUID();

  rpc.mockImplementation(async (method: string) => {
    if (method === "viber.session.send") {
      throw Error("Connection lost");
    }

    return stored;
  });

  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });

  const first = render(
    <ViberSessionChat sessionId={session} profile={viberProfile} revision={0} />,
  );

  await screen.findByText("Previous answer");

  const draft = screen.getByRole("textbox", {
    name: `Message ${viberProfile.name}`,
  }) as HTMLTextAreaElement;

  fireEvent.change(draft, { target: { value: "One explicit request" } });

  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Connection lost");
  expect(draft.value).toBe("One explicit request");

  first.unmount();
  render(<ViberSessionChat sessionId={session} profile={viberProfile} revision={0} />);
  await screen.findByText("Previous answer");

  expect(
    (screen.getByRole("textbox", { name: `Message ${viberProfile.name}` }) as HTMLTextAreaElement)
      .value,
  ).toBe("One explicit request");

  fireEvent.click(screen.getByRole("button", { name: "Send message" }));

  await waitFor(() =>
    expect(rpc.mock.calls.filter(([method]) => method === "viber.session.send")).toHaveLength(2),
  );

  const sends = rpc.mock.calls.filter(([method]) => method === "viber.session.send");
  expect(sends[0]).toEqual(sends[1]);
});

it("starts a fresh explicit retry once a lost-response request is known to have failed", async () => {
  const session = crypto.randomUUID();
  let failedRequest: { request_id: string; content: string } | undefined;

  rpc.mockImplementation(async (method: string, input: { request_id: string; content: string }) => {
    if (method === "viber.session.send") {
      if (!failedRequest) {
        failedRequest = input;
        throw Error("Connection lost");
      }

      return {};
    }

    return failedRequest
      ? {
          ...stored,
          recovery_required: false,
          messages: [
            {
              id: failedRequest.request_id,
              role: "user",
              content: failedRequest.content,
              status: "failed",
              error: "Failed before invocation",
            },
          ],
        }
      : stored;
  });

  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });
  const view = render(<ViberSessionChat sessionId={session} profile={viberProfile} revision={0} />);
  await screen.findByText("Previous answer");

  fireEvent.change(screen.getByRole("textbox", { name: `Message ${viberProfile.name}` }), {
    target: { value: "Retry explicitly" },
  });

  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Connection lost");
  view.rerender(<ViberSessionChat sessionId={session} profile={viberProfile} revision={1} />);
  await screen.findByText("Failed before invocation");
  expect(screen.queryByText("Connection lost")).toBeNull();

  expect(
    screen.getAllByText("The response couldn't finish. Review the details and try again."),
  ).toHaveLength(1);

  fireEvent.click(screen.getByRole("button", { name: "Retry" }));

  await waitFor(() =>
    expect(rpc.mock.calls.filter(([method]) => method === "viber.session.send")).toHaveLength(2),
  );

  const sends = rpc.mock.calls.filter(([method]) => method === "viber.session.send");
  expect(sends[0][1].request_id).not.toBe(sends[1][1].request_id);
  expect(sends[1][1].content).toBe(sends[0][1].content);
});

it.each([
  { kind: "context reset", reset: true, acknowledge: false },
  { kind: "confirmed recovery", reset: false, acknowledge: true },
])(
  "retains $kind flags when resending a lost-response request after remount",
  async ({ reset, acknowledge }) => {
    const session = crypto.randomUUID();
    let sent = false;

    rpc.mockImplementation(async (method: string) => {
      if (method === "viber.session.send") {
        sent = true;
        throw Error("Connection lost");
      }

      return { ...stored, recovery_required: !sent && acknowledge };
    });

    Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });

    const first = render(
      <ViberSessionChat sessionId={session} profile={viberProfile} revision={0} />,
    );

    await screen.findByText("Previous answer");
    if (reset) {
      fireEvent.click(screen.getByRole("combobox", { name: "Conversation menu" }));
      fireEvent.click(screen.getByRole("option", { name: "Reset AI context" }));
    }

    fireEvent.change(screen.getByRole("textbox", { name: `Message ${viberProfile.name}` }), {
      target: { value: "One request with retained flags" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    if (acknowledge) {
      fireEvent.click(screen.getByRole("button", { name: "I understand, continue" }));
    }

    await screen.findByText("Connection lost");
    first.unmount();
    render(<ViberSessionChat sessionId={session} profile={viberProfile} revision={0} />);
    await screen.findByText("Previous answer");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(rpc.mock.calls.filter(([method]) => method === "viber.session.send")).toHaveLength(2),
    );

    const sends = rpc.mock.calls.filter(([method]) => method === "viber.session.send");
    expect(sends[0]).toEqual(sends[1]);
    expect(sends[0][1].new_thread).toBe(reset || undefined);
    expect(sends[0][1].acknowledge_uncertain).toBe(acknowledge || undefined);
  },
);
