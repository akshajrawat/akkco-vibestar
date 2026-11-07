// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { FlowWorkspace } from "../../src/features/flows/FlowWorkspace";
import { ImportedHistory } from "../../src/features/flows/ImportedHistory";
import { viberDetail, viberProfile, viberWorkspace } from "./flow-fixtures";
import { getTaskView, updateTaskView } from "../../src/lib/taskView";
import { viberConversationKey } from "../../src/features/flows/ViberConversation";

vi.mock("../../src/features/flows/FlowCanvas", () => ({
  FlowCanvas: () => <div>Canvas fixture</div>,
  ViberFace: () => <span aria-hidden="true" />,
}));

vi.mock("../../src/components/shared/TaskTerminal", () => ({
  TaskTerminal: () => <p>Terminal fixture</p>,
}));

afterEach(cleanup);

const open = async (
  chat: (input: Record<string, unknown>) => Promise<unknown>,
  configure?: (
    detail: ReturnType<typeof viberDetail>,
    workspace: ReturnType<typeof viberWorkspace>,
  ) => void,
) => {
  const detail = viberDetail();
  const workspace = viberWorkspace(detail);
  configure?.(detail, workspace);

  const rpc = vi.fn((method: string, input: Record<string, unknown>) =>
    method === "viber.chat"
      ? chat(input)
      : Promise.resolve(
          method === "profile.list"
            ? [viberProfile]
            : method === "providers.detect"
              ? []
              : workspace,
        ),
  );

  Object.defineProperty(window, "vibestar", { value: { rpc }, configurable: true });

  const ui = render(
    <FlowWorkspace detail={detail} revision={0} back={vi.fn()} onError={vi.fn()} />,
  );

  await screen.findByText("Canvas fixture");
  fireEvent.click(screen.getByRole("button", { name: "Chat" }));
  const field = screen.getByLabelText<HTMLTextAreaElement>("Viber conversation");
  return { detail, workspace, rpc, ui, field };
};

it("sends Enter once, preserves Shift+Enter and IME composition, and keeps solo authority explicit", async () => {
  const { field, rpc, ui } = await open(async () => ({}));
  fireEvent.change(field, { target: { value: "Edit the selected files" } });
  expect(fireEvent.keyDown(field, { key: "Enter", shiftKey: true })).toBe(true);
  expect(fireEvent.keyDown(field, { key: "Enter", isComposing: true })).toBe(true);
  expect(rpc.mock.calls.filter(([method]) => method === "viber.chat")).toHaveLength(0);
  expect(fireEvent.keyDown(field, { key: "Enter" })).toBe(false);
  fireEvent.keyDown(field, { key: "Enter" });

  await vi.waitFor(() =>
    expect(rpc.mock.calls.filter(([method]) => method === "viber.chat")).toHaveLength(1),
  );

  expect(rpc).toHaveBeenCalledWith(
    "viber.chat",
    expect.objectContaining({
      content: "Edit the selected files",
      history_ids: [],
      expected_revision: 1,
    }),
  );

  expect(field.value).toBe("");
  expect(ui.container.querySelector("form button:not([type])")).toBeNull();
  expect(screen.getByText(/workspace-write/)).toBeTruthy();
});

it("keeps drafts and history separate for two connected instances of the same Viber", async () => {
  const { detail, workspace, field, rpc } = await open(
    async () => ({}),
    (detail, workspace) => {
      const first = workspace.revision.definition.nodes[0];
      if (first.type !== "agent") throw new Error("Expected fixture agent");
      first.name = "Scout";

      const second = {
        ...first,
        id: randomUUID(),
        name: "Builder",
        inputs: [{ kind: "output" as const, node_id: first.id }],
      };

      workspace.revision.definition.nodes.push(second);

      workspace.revision.definition.edges.push({
        id: randomUUID(),
        source: first.id,
        target: second.id,
      });

      detail.messages = [first, second].map((node) => ({
        id: randomUUID(),
        role: "user",
        content: `${node.name}'s private history`,
        status: "chat_completed",
        purpose: "chat",
        flow_node_id: node.id,
        viber_profile_id: viberProfile.id,
        created_at: new Date().toISOString(),
      }));
    },
  );

  fireEvent.change(field, { target: { value: "Scout draft" } });
  expect(screen.getByText("Scout's private history")).toBeTruthy();
  expect(screen.queryByText("Builder's private history")).toBeNull();
  const second = workspace.revision.definition.nodes[1];
  fireEvent.change(screen.getByLabelText("Chat with Viber"), { target: { value: second.id } });
  const builder = screen.getByLabelText<HTMLTextAreaElement>("Viber conversation");
  expect(builder.value).toBe("");
  fireEvent.change(builder, { target: { value: "Builder draft" } });
  expect(screen.getByText("Builder's private history")).toBeTruthy();
  expect(screen.queryByText("Scout's private history")).toBeNull();
  fireEvent.keyDown(builder, { key: "Enter" });

  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "viber.chat",
      expect.objectContaining({
        node_id: second.id,
        profile_id: viberProfile.id,
        content: "Builder draft",
        history_ids: [detail.messages[1].id],
        inputs: [],
      }),
    ),
  );

  expect(
    getTaskView(
      viberConversationKey(
        detail.task.id,
        workspace.revision.definition.nodes[0].id,
        viberProfile.id,
      ),
    ).draft,
  ).toBe("Scout draft");

  fireEvent.change(screen.getByLabelText("Chat with Viber"), {
    target: { value: workspace.revision.definition.nodes[0].id },
  });

  expect(screen.getByLabelText<HTMLTextAreaElement>("Viber conversation").value).toBe(
    "Scout draft",
  );

  expect(
    rpc.mock.calls.filter(([method]) => method === "flow.save" || method === "flow.start"),
  ).toHaveLength(0);
});

it("keeps legacy local drafts inspectable without assigning or submitting them to a Viber", async () => {
  const { detail, rpc } = await open(
    async () => ({}),
    (detail) => {
      updateTaskView(detail.task.id, {
        draft: "My unsent legacy instruction",
        draftContext: [
          { id: "attachment", label: "Saved context", text: "<img src=x onerror=alert(1)>" },
        ],
      });
    },
  );

  expect(screen.getByLabelText<HTMLTextAreaElement>("Viber conversation").value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "History" }));
  expect(screen.getByText("Unassigned local draft")).toBeTruthy();
  expect(screen.getByText("My unsent legacy instruction")).toBeTruthy();
  expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
  expect(document.querySelector("img")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Chat" }));
  expect(screen.getByLabelText<HTMLTextAreaElement>("Viber conversation").value).toBe("");
  expect(getTaskView(detail.task.id).draft).toBe("My unsent legacy instruction");

  expect(
    rpc.mock.calls.some(([method]) => method === "viber.chat" || method === "flow.start"),
  ).toBe(false);
});

it.each([false, true])(
  "shows a pending message immediately and restores a failed draft without overwriting later typing (%s)",
  async (typeAhead) => {
    let reject!: (error: Error) => void;

    const pending = new Promise((_, fail) => {
      reject = fail;
    });

    const { field } = await open(() => pending);
    fireEvent.change(field, { target: { value: "A pending instruction" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(screen.getByText("A pending instruction")).toBeTruthy();
    expect(field.value).toBe("");
    if (typeAhead) fireEvent.change(field, { target: { value: "My newer draft" } });
    await act(async () => reject(new Error("Fixture transport failure")));
    expect(field.value).toBe(typeAhead ? "My newer draft" : "A pending instruction");
    expect(screen.getByRole("alert").textContent).toContain("Fixture transport failure");
    expect(document.querySelectorAll(".user-message")).toHaveLength(0);
  },
);

it("reconciles a saved echo before the send response without duplicate user messages or lost new typing", async () => {
  let resolve!: (value: unknown) => void;
  let sent: Record<string, unknown> | undefined;

  const pending = new Promise((done) => {
    resolve = done;
  });

  const { detail, field, ui } = await open((input) => {
    sent = input;
    return pending;
  });

  fireEvent.change(field, { target: { value: "Keep the message once" } });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(sent).toBeDefined();
  fireEvent.change(field, { target: { value: "New typing during dispatch" } });

  const echoed = {
    ...detail,
    messages: [
      {
        id: String(sent!.request_id),
        role: "user",
        content: "Keep the message once",
        status: "chat_pending",
        purpose: "chat" as const,
        flow_node_id: String(sent!.node_id),
        viber_profile_id: String(sent!.profile_id),
        created_at: new Date().toISOString(),
      },
    ],
  };

  ui.rerender(<FlowWorkspace detail={echoed} revision={1} back={vi.fn()} onError={vi.fn()} />);
  expect(document.querySelectorAll(".user-message")).toHaveLength(1);
  await act(async () => resolve({}));
  expect(document.querySelectorAll(".user-message")).toHaveLength(1);
  expect(field.value).toBe("New typing during dispatch");
});

it("preserves the attached terminal while shortcuts hide the dock, select Problems and restore focus", async () => {
  const { detail, rpc, field } = await open(async () => ({}));
  field.focus();
  fireEvent.keyDown(window, { key: "`", ctrlKey: true });
  const terminal = await screen.findByText("Terminal fixture");
  const dock = screen.getByRole("region", { name: "Terminal and problems" });
  expect(dock.hidden).toBe(false);
  fireEvent.keyDown(window, { key: "j", ctrlKey: true });
  expect(dock.hidden).toBe(true);
  expect(document.activeElement).toBe(field);
  fireEvent.keyDown(window, { key: "`", ctrlKey: true });
  expect(screen.getByText("Terminal fixture")).toBe(terminal);
  fireEvent.click(screen.getByRole("tab", { name: "Problems" }));
  expect(screen.getByText("No saved run error.")).toBeTruthy();
  expect(screen.getByText("Terminal fixture")).toBe(terminal);
  fireEvent.click(screen.getByRole("button", { name: "Maximize utility dock" }));
  expect(getTaskView(detail.task.id).dockMaximized).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Restore utility dock" }));
  fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
  expect(screen.getByText("Terminal fixture")).toBe(terminal);

  expect(
    rpc.mock.calls.some(([method]) => method === "flow.start" || method === "viber.chat"),
  ).toBe(false);
});

it("opens scoped usage through shared navigation state and retains the selected flow view", async () => {
  const { detail, ui, rpc } = await open(async () => ({}));
  await act(async () => updateTaskView(detail.task.id, { flowSection: "usage" }));
  expect(await screen.findByRole("heading", { name: "Task usage" })).toBeTruthy();
  ui.unmount();
  render(<FlowWorkspace detail={detail} revision={1} back={vi.fn()} onError={vi.fn()} />);
  expect(await screen.findByRole("heading", { name: "Task usage" })).toBeTruthy();

  expect(
    rpc.mock.calls.some(([method]) => method === "flow.start" || method === "viber.chat"),
  ).toBe(false);
});

it("shows original approval decisions as unknown without claiming a completed decision", () => {
  const detail = viberDetail();

  const gate = {
    id: randomUUID(),
    name: "Approve saved plan",
    type: "approval" as const,
    instructions: "",
    inputs: [],
  };

  render(
    <ImportedHistory
      detail={detail}
      history={{
        migration: {
          task_id: detail.task.id,
          source_hash: "a".repeat(64),
          state: "converted",
          original_status: "awaiting_approval",
          original_stage: 1,
          flow_id: detail.task.flow_id!,
          history_revision: 1,
          checkpoint_run_id: randomUUID(),
          boundary_node_id: gate.id,
          final_review_fingerprint: null,
          diagnostic: "Continue explicitly to inspect current inputs.",
          nodes: [{ id: gate.id, stage: 1, type: "approval" }],
        },
        definition: { name: "Historical graph", nodes: [gate], edges: [] },
        nodes: [{ id: gate.id, stage: 1, type: "approval", runs: [] }],
      }}
    />,
  );

  expect(
    screen.getByText("Past approval decision and exact inputs were not recorded."),
  ).toBeTruthy();

  expect(screen.queryByRole("button", { name: /Accept/ })).toBeNull();
  expect(screen.getByText(/Saved state: awaiting_approval/)).toBeTruthy();
});

it("includes only its own completed conversation by default and requires a choice instead of truncating long history", async () => {
  const { field, rpc, detail } = await open(
    async () => ({}),
    (detail, workspace) => {
      const node = workspace.revision.definition.nodes[0];

      detail.messages = Array.from({ length: 51 }, (_, i) => ({
        id: randomUUID(),
        role: i % 2 ? "assistant" : "user",
        content: `Own turn ${i}`,
        status: "chat_completed",
        purpose: "chat",
        flow_node_id: node.id,
        viber_profile_id: viberProfile.id,
        created_at: new Date().toISOString(),
      }));

      detail.messages.push({
        id: randomUUID(),
        role: "user",
        content: "A foreign Viber turn",
        status: "chat_completed",
        purpose: "chat",
        flow_node_id: randomUUID(),
        viber_profile_id: viberProfile.id,
        created_at: new Date().toISOString(),
      });
    },
  );

  fireEvent.change(field, { target: { value: "Continue this conversation" } });
  expect(screen.getByRole("alert").textContent).toContain("exceeds 50");
  fireEvent.keyDown(field, { key: "Enter" });
  expect(rpc.mock.calls.some(([method]) => method === "viber.chat")).toBe(false);
  const context = screen.getByText("Context · 1 sources · 51 messages");
  fireEvent.click(context);
  expect(screen.queryByText("user: A foreign Viber turn")).toBeNull();
  fireEvent.click(screen.getByLabelText("user: Own turn 0"));
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.keyDown(field, { key: "Enter" });

  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "viber.chat",
      expect.objectContaining({
        history_ids: detail.messages.slice(1, 51).map((message) => message.id),
        content: "Continue this conversation",
      }),
    ),
  );
});
