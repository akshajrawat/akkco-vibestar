import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { rpc, subscribe, errorMessage } from "../lib/api";
import type { Snapshot, Detection } from "../lib/types";

export const useWorkspace = () => {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [runtimeUnavailable, setRuntimeUnavailable] = useState(false);
  const [revision, setRevision] = useState(0);
  const requested = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++requested.current;
    try {
      const next = await rpc<Snapshot>("snapshot");
      if (request !== requested.current) {
        return;
      }

      setSnapshot(next);
      setError("");
      setRuntimeUnavailable(false);
    } catch (e) {
      if (request !== requested.current) {
        return;
      }

      setError(errorMessage(e));
      setRuntimeUnavailable(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const subscription = subscribe((e) => {
      if (e.event === "core.error" || e.event === "core.closed") {
        setError(e.text || "Execution core stopped. Restart the app to recover.");
        if (e.event === "core.closed") {
          requested.current++;
          setRuntimeUnavailable(true);
        }
      } else if (
        ["changed", "agent.event", "usage.changed", "command.output"].includes(e.event) ||
        (e.event === "utility.event" && !!e.session_id) ||
        (e.event === "runtime.status" && (e.data as { phase?: string })?.phase === "ready")
      ) {
        if (!timer) {
          timer = setTimeout(() => {
            timer = undefined;
            void refresh();
            setRevision((v) => v + 1);
          }, 350);
        }
      }
    });

    const focus = () => void refresh();
    window.addEventListener("focus", focus);

    void subscription.then((unlisten) => {
      if (disposed) {
        unlisten();
      }
    });

    return () => {
      disposed = true;
      void subscription.then((fn) => fn());
      if (timer) {
        clearTimeout(timer);
      }

      window.removeEventListener("focus", focus);
    };
  }, [refresh]);

  return { snapshot, error, runtimeUnavailable, setError, refresh, revision };
};

let detectedProviders: Detection[] = [];
let detectedAt = 0;
let detecting: Promise<void> | undefined;
const providerListeners = new Set<() => void>();

const subscribeToProviders = (listener: () => void) => {
  providerListeners.add(listener);
  return () => {
    providerListeners.delete(listener);
  };
};

const getProviders = () => detectedProviders;

export const useProviders = () => {
  const providers = useSyncExternalStore(subscribeToProviders, getProviders);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async (force = true) => {
    try {
      if (force || Date.now() - detectedAt >= 60000 || detecting) {
        setLoading(true);

        detecting ||= rpc<Detection[]>("providers.detect")
          .then((result) => {
            detectedProviders = result;
            detectedAt = Date.now();
            for (const listener of providerListeners) {
              listener();
            }
          })
          .finally(() => {
            detecting = undefined;
          });

        await detecting;
      }

      setError("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  return { providers, loading, error, refresh };
};
