// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useWorkspace } from "../../apps/desktop/hooks/useWorkspace";
import type { CoreEvent } from "../../apps/desktop/lib/types";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("refreshes active session output on scoped utility events and releases its subscription", async () => {
  vi.useFakeTimers();
  const rpc = vi.fn().mockResolvedValue({ tasks: [] });
  const unsubscribe = vi.fn();
  let event: (event: CoreEvent) => void = () => {};

  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: {
      rpc,
      subscribe: (callback: typeof event) => {
        event = callback;
        return unsubscribe;
      },
    },
  });

  const hook = renderHook(() => useWorkspace());
  await act(async () => {});
  expect(rpc).toHaveBeenCalledTimes(1);
  act(() => event({ event: "utility.event", kind: "message" }));
  await act(async () => vi.runOnlyPendingTimers());
  expect(rpc).toHaveBeenCalledTimes(1);
  act(() => event({ event: "utility.event", session_id: "active-session", kind: "message" }));
  await act(async () => vi.runOnlyPendingTimers());
  expect(hook.result.current.revision).toBe(1);
  expect(rpc).toHaveBeenCalledTimes(2);
  hook.unmount();
  await act(async () => {});
  expect(unsubscribe).toHaveBeenCalledOnce();
});
