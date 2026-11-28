// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { defaultSettings } from "../../apps/core/domain";
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

const rpc = vi.fn();
const sessionId = crypto.randomUUID();
const userId = crypto.randomUUID();
const answerId = crypto.randomUUID();
const createdAt = "2026-11-17T00:00:00.000Z";

const stored = {
  session: {
    id: sessionId,
    profile_id: viberProfile.id,
    selection: { provider: "codex", model: "persisted-model", effort: "low" },
  },
  messages: [
    {
      id: userId,
      role: "user",
      content: "Previous question",
      status: "completed",
      created_at: createdAt,
    },
    {
      id: answerId,
      role: "assistant",
      content: "Previous answer",
      status: "completed",
      created_at: createdAt,
    },
  ],
  runs: [],
  events: [],
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  localStorage.clear();
});

it("allows a local context reset when the saved provider model is unavailable", async () => {
  const id = crypto.randomUUID();

  rpc.mockImplementation(async (method: string) =>
    method === "viber.session.detail"
      ? {
          ...stored,
          session: {
            ...stored.session,
            id,
            selection: { ...stored.session.selection, model: "retired-model" },
          },
        }
      : {},
  );

  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });
  render(<ViberSessionChat sessionId={id} profile={viberProfile} revision={0} />);
  await screen.findByText("Previous answer");

  const draft = screen.getByRole("textbox", { name: `Message ${viberProfile.name}` });
  const send = screen.getByRole<HTMLButtonElement>("button", { name: "Send message" });
  fireEvent.change(draft, { target: { value: "Ordinary prompt" } });
  expect(send.disabled).toBe(true);

  fireEvent.change(draft, { target: { value: " /clear " } });
  expect(send.disabled).toBe(false);
  fireEvent.click(send);

  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "viber.session.send",
      expect.objectContaining({ session_id: id, content: "/clear" }),
    ),
  );

  fireEvent.change(draft, { target: { value: " /watch https://github.com/owner/repo/pull/1 " } });
  expect(send.disabled).toBe(false);
  fireEvent.click(send);

  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "viber.session.send",
      expect.objectContaining({
        session_id: id,
        content: "/watch https://github.com/owner/repo/pull/1",
      }),
    ),
  );
});

it("restores the saved model and retries a send with the picker selection and no history replay", async () => {
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
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

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

  const turn = {
    id: crypto.randomUUID(),
    role: "user",
    content: "Submitted question",
    created_at: createdAt,
  };

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
        created_at: createdAt,
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

  const interruptedId = crypto.randomUUID();

  rpc.mockImplementation(async () => ({
    ...stored,
    messages: [
      ...stored.messages,
      {
        id: interruptedId,
        role: "user",
        content: "Interrupted question",
        created_at: createdAt,
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
  fireEvent.click(screen.getByRole("button", { name: "Continue where you left off." }));
  fireEvent.click(screen.getByRole("button", { name: "I understand, continue" }));

  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "viber.session.send",
      expect.objectContaining({
        content: "Continue where you left off.",
        continue_message_id: interruptedId,
        acknowledge_uncertain: true,
      }),
    ),
  );
});

it("waits for explicit Continue and recovery confirmation after stopping a file-changing turn", async () => {
  const turnId: string = crypto.randomUUID();

  const turn = {
    id: turnId,
    role: "user",
    content: "Edit the fixture workspace",
    created_at: createdAt,
    status: "pending",
  };

  const scope = { session_id: sessionId, profile_id: viberProfile.id };
  let detail = { ...stored, recovery_required: false, messages: [turn] };

  rpc.mockImplementation(async (method: string, input: { request_id: string }) => {
    if (method === "viber.session.cancel") {
      detail = {
        ...detail,
        recovery_required: true,
        messages: [{ ...turn, status: "cancelled" }],
      };
    }

    if (method === "viber.session.send") {
      detail = { ...detail, messages: [...detail.messages, { ...turn, id: input.request_id }] };
    }

    return detail;
  });

  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });
  render(<ViberSessionChat sessionId={sessionId} profile={viberProfile} revision={0} />);

  fireEvent.click(await screen.findByRole("button", { name: "Stop response" }));
  const resume = await screen.findByRole("button", { name: "Continue where you left off." });
  expect(rpc).toHaveBeenCalledWith("viber.session.cancel", scope);
  expect(screen.queryByRole("button", { name: "Stop response" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  const sends = () => rpc.mock.calls.filter(([method]) => method === "viber.session.send");
  expect(sends()).toHaveLength(0);

  fireEvent.click(resume);
  await screen.findByRole("dialog", { name: "Review previous work" });
  expect(sends()).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(sends()).toHaveLength(0);

  fireEvent.click(resume);
  fireEvent.click(screen.getByRole("button", { name: "I understand, continue" }));
  await screen.findByRole("button", { name: "Stop response" });

  expect(sends()).toEqual([
    [
      "viber.session.send",
      expect.objectContaining({
        ...scope,
        content: "Continue where you left off.",
        continue_message_id: turn.id,
        request_id: expect.any(String),
        acknowledge_uncertain: true,
      }),
    ],
  ]);

  expect(sends()[0][1].request_id).not.toBe(turn.id);
});

it("prepares a switched thread before allowing Continue to send", async () => {
  const turn = {
    id: userId,
    role: "user",
    content: "Stopped question",
    status: "cancelled",
    created_at: createdAt,
  };

  let detail = {
    ...stored,
    session: {
      ...stored.session,
      selection: { provider: "antigravity", model: "gemini-3.8-flash-high", effort: "high" },
    },
    recovery_required: false,
    messages: [turn],
  };
  let completePreparation!: () => void;

  const preparing = new Promise<void>((resolve) => {
    completePreparation = resolve;
  });

  rpc.mockImplementation(async (method: string) => {
    if (method === "viber.session.prepareContinuation") {
      await preparing;
      detail = { ...detail, session: stored.session };
    }

    return detail;
  });

  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });
  render(<ViberSessionChat sessionId={sessionId} profile={viberProfile} revision={0} />);
  await screen.findByText(turn.content);
  fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
  fireEvent.click(screen.getByRole("button", { name: "Codex" }));
  fireEvent.click(screen.getByRole("option", { name: "Persisted Model" }));
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Search model" }), { key: "Escape" });

  expect(rpc).toHaveBeenCalledWith("viber.session.prepareContinuation", {
    session_id: sessionId,
    profile_id: viberProfile.id,
    continue_message_id: turn.id,
    selection: stored.session.selection,
  });

  expect(screen.queryByRole("button", { name: "Continue where you left off." })).toBeNull();
  expect(rpc.mock.calls.some(([method]) => method === "viber.session.send")).toBe(false);

  completePreparation();
  fireEvent.click(await screen.findByRole("button", { name: "Continue where you left off." }));

  expect(rpc).toHaveBeenCalledWith("viber.session.send", {
    session_id: sessionId,
    profile_id: viberProfile.id,
    request_id: expect.any(String),
    content: "Continue where you left off.",
    history_ids: [],
    continue_message_id: turn.id,
  });
});

it("sends beyond 50 saved messages using native context", async () => {
  const messages = Array.from({ length: 60 }, (_, index) => ({
    id: crypto.randomUUID(),
    role: "assistant",
    content: `Answer ${index}`,
    created_at: createdAt,
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

  fireEvent.click(screen.getByRole("button", { name: "Send message" }));

  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "viber.session.send",
      expect.objectContaining({
        history_ids: [],
        content: "Continue",
      }),
    ),
  );
});

it("bypasses recovery only with backend evidence", async () => {
  rpc.mockImplementation(async () => ({
    ...stored,
    recovery_required: false,
    messages: [
      {
        id: crypto.randomUUID(),
        role: "user",
        content: "Invalid model request",
        created_at: createdAt,
        status: "failed",
        error: "Model not supported",
      },
    ],
  }));

  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });
  render(<ViberSessionChat sessionId={crypto.randomUUID()} profile={viberProfile} revision={0} />);
  await screen.findByText("Invalid model request");
  expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

  fireEvent.change(screen.getByRole("textbox", { name: `Message ${viberProfile.name}` }), {
    target: { value: "Invalid model request" },
  });

  fireEvent.click(screen.getByRole("button", { name: "Send message" }));

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

it("shows the failure beside its prompt and starts a new request when the retained draft is sent", async () => {
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
              created_at: createdAt,
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

  expect(screen.getAllByText("The response couldn't finish.")).toHaveLength(1);

  const bubble = screen
    .getByText("Retry explicitly", { selector: ".user-message p" })
    .closest(".user-message");

  expect(bubble?.previousElementSibling).toBe(screen.getByText("Failed", { exact: true }));
  expect(bubble?.nextElementSibling?.textContent).toContain("Failed before invocation");
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));

  await waitFor(() =>
    expect(rpc.mock.calls.filter(([method]) => method === "viber.session.send")).toHaveLength(2),
  );

  const sends = rpc.mock.calls.filter(([method]) => method === "viber.session.send");
  expect(sends[0][1].request_id).not.toBe(sends[1][1].request_id);
  expect(sends[1][1].content).toBe(sends[0][1].content);
});

it("retains recovery acknowledgement when resending a lost-response request after remount", async () => {
  const session = crypto.randomUUID();
  let sent = false;

  rpc.mockImplementation(async (method: string) => {
    if (method === "viber.session.send") {
      sent = true;
      throw Error("Connection lost");
    }

    return { ...stored, recovery_required: !sent };
  });

  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });

  const first = render(
    <ViberSessionChat sessionId={session} profile={viberProfile} revision={0} />,
  );

  await screen.findByText("Previous answer");

  fireEvent.change(screen.getByRole("textbox", { name: `Message ${viberProfile.name}` }), {
    target: { value: "One request with retained flags" },
  });

  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  fireEvent.click(screen.getByRole("button", { name: "I understand, continue" }));

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
  expect(sends[0][1].acknowledge_uncertain).toBe(true);
});

it("enforces Viber Workspace sharing permissions after recovery and without re-prompting on lost-response retry", async () => {
  const session = crypto.randomUUID();
  let failSend = true;

  rpc.mockImplementation(async (method: string) => {
    if (method === "viber.session.send") {
      if (failSend) {
        failSend = false;
        throw new Error("Connection lost");
      }

      return {};
    }

    return { ...stored, session: { ...stored.session, id: session }, recovery_required: true };
  });

  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });

  const view = render(
    <ViberSessionChat
      sessionId={session}
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

  await screen.findByText("Previous answer");
  expect(screen.queryByRole("button", { name: /Computer/i })).toBeNull();

  fireEvent.change(screen.getByRole("textbox", { name: `Message ${viberProfile.name}` }), {
    target: { value: "Collaborate" },
  });

  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  fireEvent.click(screen.getByRole("button", { name: "I understand, continue" }));
  expect(screen.getByRole("dialog", { name: "Shared workspace permission" })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Allow for this turn" }));
  await screen.findByText("Connection lost");

  // Lost-response retry preserves both flags without opening either dialog again.
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));

  await waitFor(() =>
    expect(rpc.mock.calls.filter(([method]) => method === "viber.session.send")).toHaveLength(2),
  );

  const sends = rpc.mock.calls.filter(([method]) => method === "viber.session.send");
  expect(sends[0]).toEqual(sends[1]);

  expect(sends[0][1]).toMatchObject({
    acknowledge_uncertain: true,
    shared_computer: true,
  });

  // Full permission sends shared_computer automatically, while /clear stays isolated.
  rpc.mockClear();

  view.rerender(
    <ViberSessionChat
      sessionId={session}
      profile={viberProfile}
      revision={1}
      computerSupported
      settings={{
        ...defaultSettings,
        allow_viber_communication: true,
        viber_workspace_permission: "full-permission",
      }}
    />,
  );

  fireEvent.change(screen.getByRole("textbox", { name: `Message ${viberProfile.name}` }), {
    target: { value: "/clear" },
  });

  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  fireEvent.click(screen.getByRole("button", { name: "I understand, continue" }));
  await waitFor(() => expect(rpc).toHaveBeenCalledWith("viber.session.send", expect.any(Object)));

  expect(
    rpc.mock.calls.find(([method]) => method === "viber.session.send")?.[1].shared_computer,
  ).toBeUndefined();
});
