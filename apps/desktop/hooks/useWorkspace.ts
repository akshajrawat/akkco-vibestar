import { useCallback, useEffect, useRef, useState } from "react";

import { rpc, subscribe, errorMessage } from "../lib/api";
import type { Snapshot, Detection } from "../lib/types";

export const useWorkspace = () => {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
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
    } catch (e) {
      if (request !== requested.current) {
        return;
      }

      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const subscription = subscribe((e) => {
      if (e.event === "core.error" || e.event === "core.closed") {
        setError(e.text || "Execution core stopped. Restart the app to recover.");
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

  return { snapshot, error, setError, refresh, revision };
};

let detectedProviders: Detection[] = [];
let detectedAt = 0;
let detecting: Promise<Detection[]> | undefined;
const detectingComputers = new Map<string, Promise<Detection[]>>();

export const useProviders = (profileId?: string, enabled = true) => {
  const [providers, setProviders] = useState<Detection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(
    async (force = true) => {
      setLoading(true);
      try {
        if (profileId) {
          let request = detectingComputers.get(profileId);
          if (!request) {
            request = rpc<Detection[]>("computer.providers", { profile_id: profileId }).finally(
              () => detectingComputers.delete(profileId),
            );

            detectingComputers.set(profileId, request);
          }

          setProviders(await request);
        } else if (!force && Date.now() - detectedAt < 60000) {
          setProviders(detectedProviders);
        } else {
          detecting ||= rpc<Detection[]>("providers.detect")
            .then((result) => {
              detectedProviders = result;
              detectedAt = Date.now();
              return result;
            })
            .finally(() => {
              detecting = undefined;
            });

          setProviders(await detecting);
        }

        setError("");
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [profileId],
  );

  useEffect(() => {
    if (profileId) {
      const subscription = subscribe((event) => {
        if (
          event.event === "computer.providers" &&
          (event.data as { profile_id: string }).profile_id === profileId
        ) {
          setProviders((event.data as { providers: Detection[] }).providers);
        }
      });

      return () => {
        void subscription.then((unsubscribe) => unsubscribe());
      };
    }
  }, [profileId]);

  useEffect(() => {
    if (enabled) {
      void refresh(false);
    }
  }, [enabled, refresh]);

  return { providers, loading, error, refresh };
};
