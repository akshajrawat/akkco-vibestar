// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  act,
} from "@testing-library/react";
import { Composer } from "../../src/components/workspace/Composer";
import { TaskWorkspace } from "../../src/components/TaskWorkspace";
import { updateTaskView } from "../../src/lib/taskView";
import { workspaceDetail } from "./fixtures";
import { defaultSettings } from "../../backend/domain";
import { workspaceContext } from "../../src/components/workspace/context";

vi.mock("../../src/lib/useWorkspace", () => ({
  useProviders: () => ({
    providers: [
      {
        provider: "codex",
        installed: true,
        connected: true,
        accountLabel: "Fixture account",
        models: [
          {
            id: "fixture-model",
            label: "Fixture model",
            supportedEfforts: ["low", "high"],
          },
        ],
        efforts: ["low", "high"],
      },
      {
        provider: "antigravity",
        installed: true,
        connected: false,
        models: [{ id: "review-low", supportedEfforts: ["low"] }],
        efforts: ["low"],
      },
    ],
    refresh: vi.fn(),
  }),
}));
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
      modified: historical
        ? "historical PR content"
        : "current worktree content",
      unified: historical ? "historical PR diff" : "current repair diff",
      binary: false,
    };
  });
  const options = workspaceContext({
    id: "repair-context",
    owner: "repair",
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
    await options
      .find((option) => option.label === "Reference a worktree file")!
      .load("spec.ts"),
  ).toEqual({
    label: "Worktree file: spec.ts",
    text: "current worktree content",
  });
  expect(
    await options
      .find((option) => option.label === "Include selected file diff")!
      .load(""),
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
const setup = (
  handler?: (method: string, params?: unknown) => Promise<unknown>,
) => {
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
  expect(localStorage.getItem("vibestar.draft.composer-keys")).toContain(
    "long paste",
  );
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
  expect(
    screen.getByText(/Snapshot truncated at 4,000/).textContent?.length,
  ).toBeLessThan(4500);
  const saved = JSON.parse(
    localStorage.getItem("vibestar.layout.composer-context")!,
  );
  expect(saved.draftContext).toHaveLength(1);
  ui.unmount();
  render(<Composer {...props} />);
  expect(screen.getByText("Unsafe-looking note")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Remove Unsafe-looking note" }),
  );
  expect(screen.queryByLabelText("Attached context")).toBeNull();
});

it("reuses an idempotent save request after transport failure, keeps its draft and requires an exact approval instruction choice", async () => {
  const detail = workspaceDetail("composer-approval");
  detail.task = {
    ...detail.task,
    worktree_path: "",
    status: "awaiting_approval",
    stage: 3,
    approval_gate: "codex_plan",
  };
  detail.artifacts = [
    {
      id: "artifact-2",
      stage: 2,
      kind: "plan",
      content: "{}",
      created_at: detail.task.created_at,
    },
  ];
  const content = "Use the existing helper";
  let attempts = 0;
  const rpc = setup(
    vi.fn(async (method: string, params?: unknown) => {
      if (method === "task.followup") {
        attempts++;
        if (attempts === 1) throw new Error("Transport interrupted");
        return {
          message: {
            id: "saved-instruction",
            role: "user",
            content,
            status: "draft",
            created_at: detail.task.created_at,
          },
          disposition: "draft",
        };
      }
      return params;
    }),
  );
  const ui = render(
    <TaskWorkspace
      detail={detail}
      revision={0}
      onError={vi.fn()}
      back={vi.fn()}
    />,
  );
  const input = screen.getByLabelText(
    "Task conversation",
  ) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: content } });
  fireEvent.click(screen.getByRole("button", { name: "Save for later" }));
  await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
  await vi.waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Save for later" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save for later" }));
  await screen.findByRole("button", { name: "Instruction saved" });
  const saves = rpc.mock.calls
    .filter(([method]) => method === "task.followup")
    .map(([, params]) => params as { request_id: string; save_only: boolean });
  expect(saves).toHaveLength(2);
  expect(saves[0].request_id).toBe(saves[1].request_id);
  expect(saves.every((save) => save.save_only)).toBe(true);
  expect(input.value).toBe(content);
  fireEvent.change(input, { target: { value: "Independent unsent draft" } });
  const approve = screen.getByRole("button", { name: "Approve → Implement" });
  expect(approve.hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByLabelText("Saved instructions on approval"), {
    target: { value: "include_next_stage" },
  });
  fireEvent.click(approve);
  fireEvent.click(approve);
  await vi.waitFor(() =>
    expect(
      rpc.mock.calls.filter(([method]) => method === "task.approve"),
    ).toHaveLength(1),
  );
  expect(rpc).toHaveBeenCalledWith("task.approve", {
    id: detail.task.id,
    artifact_id: "artifact-2",
    instructions: {
      disposition: "include_next_stage",
      message_ids: ["saved-instruction"],
    },
  });
  expect(input.value).toBe("Independent unsent draft");
  ui.rerender(
    <TaskWorkspace
      detail={{
        ...detail,
        artifacts: [{ ...detail.artifacts[0], id: "new-artifact" }],
      }}
      revision={1}
      onError={vi.fn()}
      back={vi.fn()}
    />,
  );
  expect(
    (
      screen.getByLabelText(
        "Saved instructions on approval",
      ) as HTMLSelectElement
    ).value,
  ).toBe("");
  expect(
    screen.queryByText("Approved · next pipeline stage authorized"),
  ).toBeNull();
});

it("keeps chat models independent and shows unavailable accounts without changing provider silently", async () => {
  setup();
  const detail = workspaceDetail("composer-models");
  detail.task.worktree_path = "";
  detail.task.execution_settings = {
    ...defaultSettings,
    codex_implementation: {
      model: "unavailable-model",
      effort: "high",
      timeout_secs: 30,
    },
  };
  render(
    <TaskWorkspace
      detail={detail}
      revision={0}
      onError={vi.fn()}
      back={vi.fn()}
    />,
  );
  screen.getByRole("button", { name: "Choose chat model" }).focus();
  fireEvent.click(screen.getByRole("button", { name: "Choose chat model" }));
  const picker = screen.getByRole("dialog", {
    name: "Chat model configuration",
  });
  expect(
    within(picker).getByText(/not available from the official CLI/),
  ).toBeTruthy();
  fireEvent.click(within(picker).getByRole("button", { name: "Antigravity" }));
  expect(within(picker).getByText(/Account is disconnected/)).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Choose chat model" }).textContent,
  ).toContain("Antigravity");
  fireEvent.keyDown(picker, { key: "Escape" });
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Choose chat model" }),
  );
  expect(detail.task.execution_settings.codex_implementation.model).toBe(
    "unavailable-model",
  );
  expect(
    JSON.parse(localStorage.getItem(`vibestar.layout.${detail.task.id}`)!)
      .followupProvider,
  ).toBe("antigravity");
});

it("edits an unstarted future stage independently of chat and completed runs", async () => {
  const rpc = setup(vi.fn(async (_method: string, input?: unknown) => input));
  const detail = workspaceDetail("composer-future");
  detail.task = {
    ...detail.task,
    worktree_path: "",
    stage: 3,
    status: "awaiting_approval",
    approval_gate: "codex_plan",
    execution_settings: {
      ...defaultSettings,
      codex_implementation: {
        model: "fixture-model",
        effort: "low",
        timeout_secs: 30,
      },
    },
  };
  act(() =>
    updateTaskView(detail.task.id, {
      secondaryOpen: true,
      secondarySection: "pipeline",
      followupModel: "chat-choice",
    }),
  );
  render(
    <TaskWorkspace
      detail={detail}
      revision={0}
      onError={vi.fn()}
      back={vi.fn()}
    />,
  );
  fireEvent.click(
    screen.getAllByRole("button", { name: "Edit future model" })[0],
  );
  const editor = screen.getByLabelText("Future stage 3 settings");
  fireEvent.change(within(editor).getByLabelText("Reasoning / effort"), {
    target: { value: "high" },
  });
  fireEvent.click(
    within(editor).getByRole("button", { name: "Save future stage" }),
  );
  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("task.configureStage", {
      id: detail.task.id,
      stage: 3,
      config: { model: "fixture-model", effort: "high", timeout_secs: 30 },
    }),
  );
  expect(
    JSON.parse(localStorage.getItem(`vibestar.layout.${detail.task.id}`)!)
      .followupModel,
  ).toBe("chat-choice");
});
