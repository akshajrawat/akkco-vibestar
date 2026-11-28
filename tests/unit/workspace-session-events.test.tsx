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

it("keeps the helper available on snapshot application errors and reconnects after transport errors", async () => {
  const snapshot = { capabilities: { shared_computer: 1 } };

  const rpc = vi
    .fn()
    .mockResolvedValueOnce(snapshot)
    .mockRejectedValueOnce({ kind: "operation_failed", message: "Database error" })
    .mockRejectedValueOnce({ kind: "helper_disconnected", message: "Helper disconnected" })
    .mockResolvedValueOnce(snapshot);

  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: { rpc, subscribe: () => () => {} },
  });

  const hook = renderHook(() => useWorkspace());
  await act(async () => {});

  await act(hook.result.current.refresh);
  expect(hook.result.current.snapshot).toBe(snapshot);
  expect(hook.result.current.error).toBe("Database error");
  expect(hook.result.current.runtimeUnavailable).toBe(false);

  await act(hook.result.current.refresh);
  expect(hook.result.current.runtimeUnavailable).toBe(true);

  await act(hook.result.current.refresh);
  expect(hook.result.current.runtimeUnavailable).toBe(false);
  expect(hook.result.current.error).toBe("");
});
