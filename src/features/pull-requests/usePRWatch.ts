import { useEffect, useRef } from "react";

import { rpc } from "../../lib/api";

/** The core deduplicates startup checks across renderer remounts and window focus. */
export const usePRWatch = (enabled: boolean) => {
  const requested = useRef(false);

  useEffect(() => {
    if (!enabled || requested.current) return;
    requested.current = true;

    void rpc("pr.watch.start", { request_id: crypto.randomUUID(), trigger: "open" }).catch(() => {
      // The explicit Recheck action exposes transport/compatibility errors without retrying.
    });
  }, [enabled]);
};
