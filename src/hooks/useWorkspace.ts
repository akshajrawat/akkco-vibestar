import { useCallback, useEffect, useState } from "react";
import { rpc, subscribe, errorMessage } from "../lib/api";
import type { Snapshot, Detail, Detection } from "../lib/types";
export const useWorkspace = () => {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(async () => {
    try {
      setSnapshot(await rpc<Snapshot>("snapshot"));
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const subscription = subscribe((e) => {
      if (e.event === "core.error" || e.event === "core.closed") {
        setError(e.text || "Execution core stopped. Restart the app to recover tasks.");
      } else if (["changed", "agent.event", "usage.changed", "command.output"].includes(e.event)) {
        if (!timer)
          timer = setTimeout(() => {
            timer = undefined;
            void refresh();
            setRevision((v) => v + 1);
          }, 350);
      }
    });
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    void subscription.then((unlisten) => {
      if (disposed) unlisten();
    });
    return () => {
      disposed = true;
      void subscription.then((fn) => fn());
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", focus);
    };
  }, [refresh]);
  return { snapshot, error, setError, refresh, revision };
};
export const useDetail = (id: string | null, revision: number) => {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setDetail(null);
    setError("");
  }, [id]);
  useEffect(() => {
    let alive = true;
    if (id)
      void rpc<Detail>("task.detail", { id })
        .then((d) => {
          if (alive) setDetail(d);
        })
        .catch((e) => {
          if (alive) setError(errorMessage(e));
        });
    return () => {
      alive = false;
    };
  }, [id, revision]);
  return { detail, error };
};
let detectedProviders: Detection[] = [];
let detectedAt = 0;
let detecting: Promise<Detection[]> | undefined;
export const useProviders = () => {
  const [providers, setProviders] = useState<Detection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async (force = true) => {
    setLoading(true);
    try {
      if (!force && Date.now() - detectedAt < 60000) setProviders(detectedProviders);
      else {
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
  }, []);
  useEffect(() => {
    void refresh(false);
  }, [refresh]);
  return { providers, loading, error, refresh };
};
