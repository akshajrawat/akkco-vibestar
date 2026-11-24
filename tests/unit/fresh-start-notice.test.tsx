// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { App } from "../../apps/desktop/app/App";
import { useWorkspace } from "../../apps/desktop/hooks/useWorkspace";
import { useProfiles } from "../../apps/desktop/features/vibers/useProfiles";
import { defaultSettings } from "../../apps/core/domain";

vi.mock("../../apps/desktop/hooks/useWorkspace", () => ({
  useWorkspace: vi.fn(),
  useProviders: vi.fn(() => ({ providers: [], loading: false, error: null, refresh: vi.fn() })),
}));

vi.mock("../../apps/desktop/features/vibers/useProfiles", () => ({
  useProfiles: vi.fn(),
}));

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  Object.defineProperty(window, "electronWindow", {
    configurable: true,
    value: {
      manualDragging: false,
      close: vi.fn(),
      minimize: vi.fn(),
      maximize: vi.fn(),
      fullscreen: vi.fn(),
      getState: vi.fn().mockResolvedValue({ maximized: false, fullscreen: false }),
      onStateChanged: vi.fn(() => () => {}),
    },
  });

  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: {
      rpc: vi.fn(),
      subscribe: () => () => {},
      saveDesktopSettings: vi.fn(),
      desktopSettings: async () => ({}),
    },
  });
});

it("renders fresh database notice banner when snapshot contains fresh_start", () => {
  vi.mocked(useProfiles).mockReturnValue({
    profiles: [],
    previews: [],
    error: "",
    refresh: vi.fn(),
  });

  vi.mocked(useWorkspace).mockReturnValue({
    snapshot: {
      root: "/test/root",
      repositories: [],
      settings: defaultSettings,
      fresh_start: {
        detected: true,
        legacy_paths: ["/test/root/state/vibestar.sqlite"],
        message: "Previous data remains preserved at /test/root/state/vibestar.sqlite.",
      },
    },
    error: "",
    setError: vi.fn(),
    refresh: vi.fn(),
    revision: 1,
  });

  render(<App />);

  expect(screen.getByRole("status", { name: "Fresh database notice" })).toBeTruthy();
  expect(screen.getByText("Vibestar started with a fresh database")).toBeTruthy();

  expect(
    screen.getByText("Previous data remains preserved at /test/root/state/vibestar.sqlite."),
  ).toBeTruthy();
});

it("omits fresh database notice banner when snapshot has no fresh_start", () => {
  vi.mocked(useProfiles).mockReturnValue({
    profiles: [],
    previews: [],
    error: "",
    refresh: vi.fn(),
  });

  vi.mocked(useWorkspace).mockReturnValue({
    snapshot: {
      root: "/test/root",
      repositories: [],
      settings: defaultSettings,
      fresh_start: null,
    },
    error: "",
    setError: vi.fn(),
    refresh: vi.fn(),
    revision: 1,
  });

  render(<App />);

  expect(screen.queryByRole("status", { name: "Fresh database notice" })).toBeNull();
  expect(screen.queryByText("Vibestar started with a fresh database")).toBeNull();
});
