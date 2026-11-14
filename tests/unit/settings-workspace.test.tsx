// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { defaultSettings } from "../../backend/domain";
import { SettingsPage } from "../../src/features/settings/SettingsPage";
import { ConnectLocalRepository } from "../../src/features/repositories/ConnectLocalRepository";
import { ProfileEditor } from "../../src/features/flows/ProfileEditor";
import { viberProfile } from "../workspace/flow-fixtures";
import { selectValue } from "../helpers/select";
import { mockDialog } from "../helpers/dialog";

vi.mock("../../src/hooks/useWorkspace", () => ({ useProviders: () => ({ providers: [] }) }));

const rpc = vi.fn();
const saveDesktop = vi.fn();
const refresh = vi.fn();
const close = vi.fn();

beforeEach(() => {
  mockDialog();

  rpc.mockImplementation(async (method: string) =>
    method === "editors.list" ? { editors: [] } : method === "profile.list" ? [viberProfile] : {},
  );

  refresh.mockResolvedValue(undefined);
  saveDesktop.mockResolvedValue(undefined);

  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: {
      rpc,
      subscribe: () => () => {},
      saveDesktopSettings: saveDesktop,
      desktopSettings: async () => ({
        config: { distro: "", data_home: "", helper_path: "" },
        distros: [],
        native_windows: false,
      }),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const open = () =>
  render(<SettingsPage settings={defaultSettings} refresh={refresh} close={close} />);

it("filters category groups, clears search with Escape and excludes unsupported categories and Usage", async () => {
  open();
  const search = screen.getByRole("searchbox", { name: "Search settings" });
  fireEvent.change(search, { target: { value: "system" } });
  expect(screen.getByRole("button", { name: "Storage" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Models" })).toBeNull();
  fireEvent.change(search, { target: { value: "unknown category" } });
  expect(screen.getByText("No settings found.")).toBeTruthy();
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  fireEvent(search, event);
  expect(event.defaultPrevented).toBe(true);
  expect(screen.getByRole("button", { name: "General" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Usage" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Appearance" })).toBeNull();
  await screen.findByLabelText("Concurrency");
});

it("saves setting changes automatically across categories and closes directly without confirmation", async () => {
  open();
  await screen.findByLabelText("Concurrency");
  selectValue(screen.getByLabelText("Concurrency"), "4");

  await waitFor(() => {
    expect(rpc).toHaveBeenCalledWith("settings.save", expect.objectContaining({ concurrency: 4 }));
  });

  fireEvent.click(screen.getByRole("button", { name: "Repositories" }));
  fireEvent.click(screen.getByRole("button", { name: "General" }));
  expect(screen.getByLabelText("Concurrency").getAttribute("data-value")).toBe("4");
  fireEvent.click(screen.getByRole("button", { name: "Repositories" }));

  expect(screen.queryByText("Local repository discovery")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Close Settings" }));
  expect(screen.queryByRole("dialog", { name: "Discard unsaved changes?" })).toBeNull();
  expect(close).toHaveBeenCalledOnce();
});

it("tracks desktop changes automatically and displays error if core save fails", async () => {
  open();
  fireEvent.click(screen.getByRole("button", { name: "Execution" }));
  const path = await screen.findByPlaceholderText("Default: ~/.akkco-vibestar");
  fireEvent.change(path, { target: { value: "/new/data" } });
  fireEvent.blur(path);

  await waitFor(() => {
    expect(saveDesktop).toHaveBeenCalledWith(expect.objectContaining({ data_home: "/new/data" }));
  });

  rpc.mockImplementation(async (method: string) => {
    if (method === "settings.save") throw new Error("Core save failed");
    return {};
  });

  fireEvent.click(screen.getByRole("button", { name: "General" }));
  await screen.findByLabelText("Concurrency");
  selectValue(screen.getByLabelText("Concurrency"), "3");
  await screen.findByText("Core save failed");

  fireEvent.click(screen.getByRole("button", { name: "Close Settings" }));
  expect(close).toHaveBeenCalledOnce();
});

it("keeps dropdown portals within the modal and restores focus to the opener", async () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const ui = open();
  await screen.findByLabelText("Concurrency");
  fireEvent.click(screen.getByLabelText("Concurrency"));

  expect(
    screen.getByRole("dialog", { name: "Settings" }).contains(screen.getByRole("listbox")),
  ).toBe(true);

  ui.unmount();
  await waitFor(() => expect(document.activeElement).toBe(opener));
  opener.remove();
});

it("protects unsaved Viber profile edits on Escape and preserves them when continuing", () => {
  render(<ProfileEditor profile={viberProfile} close={close} saved={vi.fn()} />);

  fireEvent.change(screen.getByLabelText("Instructions"), {
    target: { value: "Unsaved instructions" },
  });

  fireEvent.keyDown(screen.getByLabelText("Instructions"), { key: "Escape" });
  expect(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeTruthy();
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));

  expect((screen.getByLabelText("Instructions") as HTMLTextAreaElement).value).toBe(
    "Unsaved instructions",
  );
});

it("protects a repository connection draft without changing its connection RPC", () => {
  render(<ConnectLocalRepository distro="fixture" close={close} connected={refresh} />);
  const path = screen.getByPlaceholderText(/projects/);
  fireEvent.change(path, { target: { value: "/unsaved/repository" } });
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect((path as HTMLInputElement).value).toBe("/unsaved/repository");
  expect(rpc).not.toHaveBeenCalled();
});
