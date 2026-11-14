import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Toaster } from "react-hot-toast";

import type { Settings } from "../lib/types";
import { notifications } from "../lib/notifications";
import { subscribe } from "../lib/api";

/** One live region follows the active native modal without stealing focus or blocking it. */
export const GlobalNotifications = ({
  preference,
  onRuntimeStatus,
}: {
  preference?: Settings["notification_preference"];
  onRuntimeStatus?: (phase: string) => void;
}) => {
  const [host] = useState(() => document.createElement("div"));

  useLayoutEffect(() => {
    const place = () => {
      const target = Array.from(document.querySelectorAll("dialog[open]")).at(-1) || document.body;
      if (host.parentElement !== target) target.append(host);
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
    if (preference) notifications.setPreference(preference);
  }, [preference]);

  useEffect(() => {
    let observedRuntime = false;
    let disposed = false;

    const handle = (event: import("../lib/types").CoreEvent) => {
      if (disposed) return;
      if (event.event === "runtime.status") {
        observedRuntime = true;
        const state = event.data as { phase: string; essential?: boolean };
        onRuntimeStatus?.(state.phase);
        const options = { id: "runtime", essential: state.essential };
        if (state.phase === "failed")
          notifications.error(event.text || "Runtime unavailable", {
            ...options,
            action: { label: "Retry", run: () => window.vibestar.retryRuntime() },
          });
        else if (state.phase === "ready") notifications.success("Runtime ready", { id: "runtime" });
        else notifications.progress(event.text || "Preparing Vibestar runtime...", options);
      }
    };

    const subscription = subscribe(handle);

    void window.vibestar
      .desktopSettings()
      .then((info) => {
        if (!observedRuntime && info.runtime_status) handle(info.runtime_status);
      })
      .catch(() => {
        /* Settings owns diagnostics for unavailable desktop metadata. */
      });

    return () => {
      disposed = true;
      void subscription.then((unsubscribe) => unsubscribe());
    };
  }, [onRuntimeStatus]);

  return createPortal(
    <Toaster
      position="bottom-right"
      containerStyle={{ bottom: 16, right: 16, left: 16, zIndex: 200 }}
      toastOptions={{
        className: "vibestar-toast",
        style: {
          background: "var(--background-elevated)",
          color: "var(--text-primary)",
          border: "1px solid var(--border-default)",
          padding: 0,
          maxWidth: "min(420px, calc(100vw - 32px))",
        },
      }}
    />,
    host,
  );
};
