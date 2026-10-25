// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { TaskWorkspace } from "../../src/components/TaskWorkspace";
import { useTaskView, updateTaskView } from "../../src/lib/taskView";
import { workspaceDetail as detail } from "./fixtures";

const terminal = vi.hoisted(() => ({ mounts: 0 }));
vi.mock("../../src/components/TaskTerminal", async () => {
  const { useEffect } = await import("react");
  return {
    TaskTerminal: () => {
      useEffect(() => {
        terminal.mounts++;
      }, []);
      return <div>Live fixture terminal</div>;
    },
  };
});
vi.mock("../../src/lib/useWorkspace", () => ({
  useProviders: () => ({ providers: [], refresh: vi.fn() }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  window.innerWidth = 1024;
});
const bridge = () => {
  window.innerWidth = 1600;
  const rpc = vi.fn(async (method: string) =>
    method === "task.diff"
      ? { files: [], insertions: 0, deletions: 0, base: "base" }
      : null,
  );
  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: { rpc },
  });
  return rpc;
};
const State = ({ id }: { id: string }) => (
  <pre data-testid="state">{JSON.stringify(useTaskView(id))}</pre>
);

it("renders verification repair history without interpreting it as repository preparation argv", () => {
  bridge();
  const value = detail("layout-verification-repair");
  value.activity = [
    {
      id: 1,
      kind: "verification_repair",
      data: JSON.stringify({
        verification: { checks: [] },
        review: null,
        commands: [],
      }),
      timestamp: value.task.updated_at,
    },
  ];
  render(
    <TaskWorkspace
      detail={value}
      revision={0}
      onError={vi.fn()}
      back={vi.fn()}
    />,
  );
  expect(screen.getByText("Repository preparation")).toBeTruthy();
  expect(screen.getByLabelText("Task conversation")).toBeTruthy();
});

it("keeps chat primary while sidebar tools navigate, resize and expand, preserving the draft and model", async () => {
  bridge();
  const id = "layout-primary";
  const ui = render(
    <TaskWorkspace
      detail={detail(id)}
      revision={0}
      onError={vi.fn()}
      back={vi.fn()}
    />,
  );
  expect(screen.queryByRole("tab", { name: "Chat" })).toBeNull();
  expect(screen.queryByRole("tablist", { name: "Task views" })).toBeNull();
  expect(ui.container.querySelector<HTMLElement>(".bottom-dock")?.hidden).toBe(
    true,
  );
  expect(
    screen.getByRole("complementary", { name: "Secondary workspace" }),
  ).toBeTruthy();
  const draft = screen.getByLabelText(
    "Task conversation",
  ) as HTMLTextAreaElement;
  fireEvent.change(draft, { target: { value: "Keep this independent draft" } });
  act(() => updateTaskView(id, { followupModel: "selected-fixture-model" }));
  const separator = screen.getByRole("separator", {
    name: "Resize secondary workspace",
  });
  fireEvent.keyDown(separator, { key: "ArrowLeft" });
  expect(
    JSON.parse(localStorage.getItem(`vibestar.layout.${id}`)!).secondaryWidth,
  ).toBe(396);
  const pipeline = screen.getByRole("tab", { name: "Workflow" });
  pipeline.focus();
  fireEvent.keyDown(pipeline, { key: "ArrowRight" });
  expect(
    screen.getByRole("tab", { name: "Plans" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.getByText("Antigravity original plan")).toBeTruthy();
  expect(draft.isConnected).toBe(true);
  const plans = screen.getByRole("tabpanel", { name: "Plans" });
  plans.scrollTop = 80;
  fireEvent.scroll(plans);
  fireEvent.click(screen.getByRole("tab", { name: "Workflow" }));
  fireEvent.click(screen.getByRole("tab", { name: "Plans" }));
  expect(screen.getByRole("tabpanel", { name: "Plans" }).scrollTop).toBe(80);
  const chat = screen.getByLabelText("Conversation");
  Object.defineProperties(chat, {
    scrollHeight: { configurable: true, value: 1200 },
    clientHeight: { configurable: true, value: 200 },
  });
  chat.scrollTop = 300;
  fireEvent.scroll(chat);
  fireEvent.click(screen.getByLabelText("Expand workspace tool"));
  expect(document.activeElement).toBe(screen.getByLabelText("Return to chat"));
  expect(ui.container.querySelector<HTMLElement>(".chat-main")?.hidden).toBe(
    true,
  );
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(ui.container.querySelector<HTMLElement>(".chat-main")?.hidden).toBe(
    false,
  );
  expect(draft.value).toBe("Keep this independent draft");
  expect(chat.scrollTop).toBe(300);
  expect(
    JSON.parse(localStorage.getItem(`vibestar.layout.${id}`)!).followupModel,
  ).toBe("selected-fixture-model");
  fireEvent.click(screen.getByLabelText("Collapse secondary workspace"));
  expect(screen.queryByRole("complementary")).toBeNull();
  fireEvent.click(screen.getByLabelText("Toggle secondary workspace"));
  expect(
    screen.getByRole("tab", { name: "Plans" }).getAttribute("aria-selected"),
  ).toBe("true");
});

it("preserves the attached terminal across hiding, Problems, maximize and keyboard toggles", async () => {
  bridge();
  terminal.mounts = 0;
  const ui = render(
    <TaskWorkspace
      detail={detail("layout-terminal")}
      revision={0}
      onError={vi.fn()}
      back={vi.fn()}
    />,
  );
  expect(terminal.mounts).toBe(0);
  const input = screen.getByLabelText("Task conversation");
  input.focus();
  fireEvent.keyDown(window, { ctrlKey: true, key: "`" });
  const live = await screen.findByText("Live fixture terminal");
  expect(document.activeElement).toBe(input);
  expect(terminal.mounts).toBe(1);
  const dock = screen.getByRole("region", { name: "Terminal and problems" });
  expect(
    within(dock)
      .getAllByRole("tab")
      .map((tab) => tab.textContent),
  ).toEqual(["Terminal", "Problems"]);
  fireEvent.click(within(dock).getByRole("tab", { name: "Problems" }));
  expect(live.isConnected).toBe(true);
  fireEvent.click(screen.getByLabelText("Maximize utility dock"));
  expect(ui.container.querySelector(".dock-maximized")).toBeTruthy();
  fireEvent.keyDown(screen.getByLabelText("Restore utility dock"), {
    key: "Escape",
  });
  fireEvent.click(screen.getByLabelText("Hide utility dock"));
  expect(document.activeElement).toBe(input);
  fireEvent.keyDown(window, { ctrlKey: true, key: "`" });
  expect(live.isConnected).toBe(true);
  expect(terminal.mounts).toBe(1);
});

it("uses a dismissible focus-contained drawer on narrow windows and restores focus to its trigger", () => {
  bridge();
  window.innerWidth = 900;
  render(
    <TaskWorkspace
      detail={detail("layout-drawer")}
      revision={0}
      onError={vi.fn()}
      back={vi.fn()}
    />,
  );
  const trigger = screen.getByLabelText("Toggle secondary workspace");
  trigger.focus();
  fireEvent.click(trigger);
  const panel = screen.getByRole("dialog", { name: "Secondary workspace" });
  expect(panel.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(
    screen.queryByRole("dialog", { name: "Secondary workspace" }),
  ).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it.each([
  ["Plan", "Terminal", "plans"],
  ["Usage", "Terminal", "usage"],
  ["Chat", "Tests", "tests"],
  ["Chat", "Agent Output", "logs"],
])(
  "migrates legacy %s / %s without losing its draft or output settings",
  (tab, dockTab, section) => {
    const id = `migration-${tab}-${dockTab}`;
    localStorage.setItem(
      `vibestar.layout.${id}`,
      JSON.stringify({
        tab,
        dockTab,
        terminalDock: true,
        outputView: "raw",
        outputStream: "stderr",
        outputFollow: false,
      }),
    );
    localStorage.setItem(`vibestar.draft.${id}`, "Unsent legacy draft");
    render(<State id={id} />);
    const value = JSON.parse(screen.getByTestId("state").textContent!);
    expect(value).toMatchObject({
      draft: "Unsent legacy draft",
      secondarySection: section,
      secondaryOpen: true,
      outputView: "raw",
      outputStream: "stderr",
      outputFollow: false,
    });
    expect(value.terminalDock).toBe(dockTab === "Terminal");
  },
);

it("bounds corrupt preferences, ignores inherited section names and keeps in-memory drafts when storage fails", () => {
  const id = "layout-invalid";
  localStorage.setItem(
    `vibestar.layout.${id}`,
    JSON.stringify({
      tab: "__proto__",
      secondarySection: "constructor",
      secondaryWidth: 99999,
      bottomHeight: -100,
    }),
  );
  render(<State id={id} />);
  expect(JSON.parse(screen.getByTestId("state").textContent!)).toMatchObject({
    secondarySection: "pipeline",
    secondaryWidth: 640,
    bottomHeight: 140,
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  act(() => updateTaskView(id, { draft: "Retain this in memory" }));
  expect(localStorage.getItem(`vibestar.draft.${id}`)).toBeNull();
  expect(JSON.parse(screen.getByTestId("state").textContent!)).toMatchObject({
    draft: "Retain this in memory",
    persistenceError: expect.stringContaining("Local storage is unavailable"),
  });
});
