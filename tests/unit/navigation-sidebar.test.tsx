// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { collapsedSidebarWidth, NavigationSidebar } from "../../apps/desktop/app/NavigationSidebar";
import type { AgentProfile } from "../../apps/core/vibers/contracts";
import { testProfileIds, viberProfile } from "../helpers/viber-fixtures";

afterEach(cleanup);

it("keeps Vibers and Settings accessible on the rail and restores the expanded search", () => {
  const profiles: AgentProfile[] = [
    { ...viberProfile, id: testProfileIds.implementer, name: "Builder" },
    { ...viberProfile, id: testProfileIds.reviewer, name: "Reviewer" },
  ];

  const openTool = vi.fn();

  const TestSidebar = () => {
    const [collapsed, setCollapsed] = useState(false);
    const [selected, setSelected] = useState(profiles[0].id);

    return (
      <NavigationSidebar
        collapsed={collapsed}
        width={collapsed ? collapsedSidebarWidth : 310}
        snapshot={null}
        profiles={profiles}
        previews={[]}
        profilesError=""
        createViber={vi.fn()}
        selectViber={(profile) => setSelected(profile.id)}
        selectedViber={selected}
        openTool={openTool}
        toggleSidebar={() => setCollapsed((current) => !current)}
      />
    );
  };

  render(<TestSidebar />);
  const sidebar = screen.getByRole("complementary", { name: "Workspace navigation" });
  const search = screen.getByRole("searchbox", { name: "Search vibers" });
  fireEvent.change(search, { target: { value: "build" } });
  expect(screen.queryByRole("button", { name: "Reviewer" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  expect(sidebar.style.width).toBe(`${collapsedSidebarWidth}px`);

  expect(screen.getByRole("button", { name: "Expand sidebar" }).getAttribute("aria-expanded")).toBe(
    "false",
  );

  const reviewer = screen.getByRole("button", { name: "Chat with Reviewer" });
  fireEvent.click(reviewer);
  expect(reviewer.getAttribute("aria-current")).toBe("page");
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(openTool).toHaveBeenCalledWith("Settings");

  fireEvent.click(screen.getByRole("button", { name: "Search vibers" }));
  const reopenedSearch = screen.getByRole<HTMLInputElement>("searchbox", { name: "Search vibers" });
  expect(sidebar.style.width).toBe("310px");
  expect(document.activeElement).toBe(reopenedSearch);
  expect(reopenedSearch.value).toBe("build");
  fireEvent.keyDown(reopenedSearch, { key: "Escape" });

  expect(screen.getByRole("button", { name: "Reviewer" }).getAttribute("aria-current")).toBe(
    "page",
  );
});
