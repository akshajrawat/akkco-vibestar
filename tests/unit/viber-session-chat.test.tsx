// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ViberSessionChat } from "../../apps/desktop/features/flows/ViberSessionChat";
import { viberProfile } from "../workspace/flow-fixtures";

vi.mock("../../apps/desktop/features/flows/ViberModelPicker", () => ({
  ViberModelPicker: ({
    execution,
    change,
  }: {
    execution: typeof viberProfile.execution;
    change: (value: typeof viberProfile.execution) => void;
  }) => (
    <button
      onClick={() =>
        change({ ...execution, provider: "antigravity", model: "changed-model", effort: "high" })
      }
    >
      Model {execution.provider} {execution.model} {execution.effort}
    </button>
  ),
}));

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
  expect(screen.getByRole("button", { name: "Model codex persisted-model low" })).toBeTruthy();
  expect(rpc.mock.calls.map(([method]) => method)).toEqual(["viber.session.detail"]);
  fireEvent.click(screen.getByRole("button", { name: "Model codex persisted-model low" }));

  fireEvent.change(screen.getByRole("textbox", { name: `Message ${viberProfile.name}` }), {
    target: { value: "Follow up" },
  });

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
    selection: { provider: "antigravity", model: "changed-model", effort: "high" },
  });

  await waitFor(() =>
    expect(
      (screen.getByRole("textbox", { name: `Message ${viberProfile.name}` }) as HTMLTextAreaElement)
        .value,
    ).toBe(""),
  );
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

  expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(
    true,
  );

  fireEvent.click(screen.getByRole("button", { name: "Stop" }));

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
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();

  expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(
    true,
  );

  fireEvent.click(screen.getByRole("checkbox", { name: /I inspected the previous turn/ }));

  expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(
    false,
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

  fireEvent.click(screen.getByRole("checkbox", { name: /Start a new provider thread/ }));
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
