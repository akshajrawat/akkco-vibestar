import { useCallback, useEffect, useRef, useState } from "react";
import type { ComputerStatus } from "../../../core/computers/contracts";
import { computerRpc, errorMessage, subscribe } from "../../lib/api";

export const useComputer = (supported: boolean, visible: boolean) => {
  const [status, setStatus] = useState<ComputerStatus>();
  const requested = useRef({ sequence: 0 });

  const refresh = useCallback(() => {
    if (!supported) {
      return;
    }

    const version = ++requested.current.sequence;

    void computerRpc("computer.status", {})
      .then((value) => {
        if (version === requested.current.sequence) {
          setStatus(value);
        }
      })
      .catch((error) => {
        if (version === requested.current.sequence) {
          setStatus({ status: "error", docker: null, has_data: false, error: errorMessage(error) });
        }
      });
  }, [supported]);

  useEffect(() => {
    if (!supported) {
      return;
    }

    let alive = true;
    const sequence = requested.current;

    const subscription = subscribe((event) => {
      if (!alive) {
        return;
      }

      if (event.event === "computer.changed") {
        requested.current.sequence++;
        setStatus(event.data as ComputerStatus);
      } else if (event.event === "core.closed" || event.event === "core.error") {
        requested.current.sequence++;

        setStatus({
          status: "error",
          docker: null,
          has_data: false,
          error: "Reconnect the execution helper.",
        });
      } else if (
        event.event === "runtime.status" &&
        (event.data as { phase?: string })?.phase === "ready" &&
        visible
      ) {
        refresh();
      }
    });

    if (visible) {
      void subscription
        .then(() => {
          if (alive) {
            refresh();
          }
        })
        .catch(() => undefined);
    }

    return () => {
      alive = false;
      sequence.sequence++;
      void subscription.then((unsubscribe) => unsubscribe()).catch(() => undefined);
    };
  }, [supported, visible, refresh]);

  return { status: supported ? status : undefined, refresh };
};
