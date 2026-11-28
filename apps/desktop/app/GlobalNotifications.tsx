import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Toaster } from "react-hot-toast";

import type { Settings } from "../lib/types";
import { notifications } from "../lib/notifications";
import { subscribe } from "../lib/api";
import type { ComputerStatus } from "../../core/computers/contracts";

interface ComputerBootState {
  snapshotReady: boolean;
  migrationPending: boolean;
  supported: boolean;
  status?: ComputerStatus;
  didStart: boolean;
  retry: () => Promise<void> | void;
}

/** One live region follows the active native modal without stealing focus or blocking it. */
export const GlobalNotifications = ({
  preference,
  onRuntimeStatus,
  computer,
}: {
  preference?: Settings["notification_preference"];
  onRuntimeStatus?: (phase: string) => void;
  computer?: ComputerBootState;
}) => {
  const [host] = useState(() => document.createElement("div"));

  const [runtimeState, setRuntimeState] = useState<{
    phase: string;
    text?: string;
    essential?: boolean;
  }>();

  const hadStartupProgress = useRef(false);
  const settledReady = useRef(false);

  useLayoutEffect(() => {
    const place = () => {
      const target = Array.from(document.querySelectorAll("dialog[open]")).at(-1) || document.body;
      if (host.parentElement !== target) {
        target.append(host);
      }
    };

    place();
    const observer = new MutationObserver(place);

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["open"],
    });

    return () => {
      observer.disconnect();
      host.remove();
    };
  }, [host]);

  useEffect(() => {
    if (preference) {
      notifications.setPreference(preference);
    }
  }, [preference]);

  useEffect(() => {
    let observedRuntime = false;
    let disposed = false;

    const handle = (event: import("../lib/types").CoreEvent) => {
      if (disposed) {
        return;
      }

      if (event.event === "runtime.status") {
        observedRuntime = true;
        const state = event.data as { phase: string; essential?: boolean };
        onRuntimeStatus?.(state.phase);
        setRuntimeState({ phase: state.phase, text: event.text, essential: state.essential });
      }
    };

    const subscription = subscribe(handle);

    void window.vibestar
      .desktopSettings()
      .then((info) => {
        if (!observedRuntime && info.runtime_status) {
          handle(info.runtime_status);
        }
      })
      .catch(() => {
        /* Settings owns diagnostics for unavailable desktop metadata. */
      });

    return () => {
      disposed = true;
      void subscription.then((unsubscribe) => unsubscribe()).catch(() => undefined);
    };
  }, [onRuntimeStatus]);

  useEffect(() => {
    if (runtimeState?.phase === "failed") {
      settledReady.current = false;

      notifications.error(runtimeState.text || "Runtime unavailable", {
        id: "runtime",
        essential: true,
        action: { label: "Retry", run: () => window.vibestar.retryRuntime() },
      });

      return;
    }

    if (runtimeState && runtimeState.phase !== "ready") {
      hadStartupProgress.current = true;
      settledReady.current = false;

      notifications.progress(runtimeState.text || "Preparing Vibestar runtime...", {
        id: "runtime",
        essential: computer ? true : runtimeState.essential,
      });

      return;
    }

    if (computer && !computer.snapshotReady) {
      return;
    }

    if (!computer?.supported || computer.migrationPending) {
      if (runtimeState?.phase === "ready" && !settledReady.current) {
        settledReady.current = true;
        notifications.success("Runtime ready", { id: "runtime" });
      }

      return;
    }

    if (computer.didStart) {
      hadStartupProgress.current = true;
    }

    if (computer.status?.status === "starting") {
      hadStartupProgress.current = true;
      settledReady.current = false;

      notifications.progress(computer.status.progress || "Starting Shared Computer...", {
        id: "runtime",
        essential: true,
      });
    } else if (computer.status?.status === "error") {
      settledReady.current = false;

      notifications.error(computer.status.error || "Could not start Shared Computer.", {
        id: "runtime",
        ...(computer.status.reset_pending
          ? {}
          : { action: { label: "Retry", run: computer.retry } }),
      });
    } else if (
      computer.status?.status === "ready" &&
      (hadStartupProgress.current || runtimeState?.phase === "ready") &&
      !settledReady.current
    ) {
      settledReady.current = true;

      notifications.success("Vibestar ready", {
        id: "runtime",
        essential: hadStartupProgress.current,
      });
    }
  }, [computer, runtimeState]);

  return createPortal(
    <Toaster
      position="bottom-right"
      containerStyle={{ bottom: 16, right: 16, left: 16, zIndex: 200 }}
      toastOptions={{
        className: "vibestar-toast",
        style: {
          background: "var(--background-selected)",
          color: "var(--text-primary)",
          border: "1px solid #ffffff29",
          boxShadow: "0 8px 28px var(--shadow)",
          padding: 0,
          maxWidth: "min(360px, calc(100vw - 32px))",
        },
      }}
    />,
    host,
  );
};
