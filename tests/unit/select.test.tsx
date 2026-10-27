// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import { Select } from "../../src/components/ui/Select";

afterEach(cleanup);

const Picker = () => {
  const [value, setValue] = useState("one");
  return (
    <Select
      label="Repository"
      searchable
      value={value}
      onChange={setValue}
      options={[
        { value: "one", label: "organization/one", description: "WSL · main" },
        { value: "disabled", label: "Disabled checkout", disabled: true },
        { value: "two", label: "organization/two", description: "Windows · develop" },
      ]}
    />
  );
};

it("searches, skips disabled options, selects with the keyboard and returns focus", () => {
  render(<Picker />);
  const trigger = screen.getByRole("combobox", { name: "Repository" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const search = screen.getByRole("combobox", { name: "Search repository" });
  expect(document.activeElement).toBe(search);
  fireEvent.keyDown(search, { key: "ArrowDown" });
  fireEvent.keyDown(search, { key: "Enter" });
  expect(trigger.textContent).toContain("organization/two");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(document.activeElement).toBe(trigger);

  fireEvent.click(trigger);

  fireEvent.change(screen.getByRole("combobox", { name: "Search repository" }), {
    target: { value: "one" },
  });

  expect(screen.getAllByRole("option")).toHaveLength(1);
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Search repository" }), { key: "Enter" });
  expect(trigger.textContent).toContain("organization/one");
});

it("dismisses with Escape without selecting and reports empty search results", () => {
  render(<Picker />);
  const trigger = screen.getByRole("combobox", { name: "Repository" });
  fireEvent.click(trigger);
  const search = screen.getByRole("combobox", { name: "Search repository" });
  fireEvent.change(search, { target: { value: "missing" } });
  expect(screen.getByRole("status").textContent).toBe("No matches found");
  fireEvent.keyDown(search, { key: "Escape" });
  expect(trigger.textContent).toContain("organization/one");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
});

it("keeps disabled pickers inert", () => {
  const onChange = vi.fn();
  render(<Select disabled label="Repository" value="" options={[]} onChange={onChange} />);
  fireEvent.click(screen.getByRole("combobox"));
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
});
