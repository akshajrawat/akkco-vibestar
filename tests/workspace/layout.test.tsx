// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, act, fireEvent, render, screen } from "@testing-library/react";

import { useTaskView, updateTaskView } from "../../src/lib/taskView";
import { SecondaryWorkspace } from "../../src/features/pull-requests/repair/SecondaryWorkspace";
import { Button } from "../../src/components/ui/button";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  window.innerWidth = 1024;
});

const State = ({ id }: { id: string }) => (
  <pre data-testid="state">{JSON.stringify(useTaskView(id))}</pre>
);

it("uses a dismissible focus-contained drawer on narrow windows and restores focus to its trigger", () => {
  window.innerWidth = 900;

  render(
    <>
      <Button
        aria-label="Toggle secondary workspace"
        onClick={() => updateTaskView("layout-drawer", { secondaryOpen: true })}
      >
        Open tools
      </Button>
      <SecondaryWorkspace id="layout-drawer" children={<p>Repair tools</p>} />
    </>,
  );

  const trigger = screen.getByLabelText("Toggle secondary workspace");
  trigger.focus();
  fireEvent.click(trigger);
  const panel = screen.getByRole("dialog", { name: "Secondary workspace" });
  expect(panel.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Secondary workspace" })).toBeNull();
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
