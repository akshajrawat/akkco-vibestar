import { useCallback, useEffect, useRef, useState } from "react";
import type { ComputerStatus } from "../../../core/computers/contracts";
import { computerRpc, errorMessage, subscribe } from "../../lib/api";

export const useComputer = (supported: boolean, canAutoStart = false) => {
  const [status, setStatus] = useState<ComputerStatus>();
  const [didStart, setDidStart] = useState(false);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const booted = useRef(false);

  const startComputer = useCallback(async () => {
    if (!supported) {
      return;
    }

    const version = ++sequence.current;
    setDidStart(true);

    setStatus((current) => ({
      status: "starting",
      error: null,
      docker: null,
      has_data: current?.has_data ?? false,
    }));

    try {
      const next = await computerRpc("computer.control", { action: "start" });
      if (mounted.current && version === sequence.current) {
        setStatus(next);
      }
    } catch (error) {
      if (mounted.current && version === sequence.current) {
        const message = errorMessage(error);
        setStatus({ status: "error", docker: null, has_data: false, error: message });
      }
    }
  }, [supported]);

  const boot = useCallback(async () => {
    if (!supported || !canAutoStart || booted.current) {
      return;
    }

    booted.current = true;
    const version = ++sequence.current;
    try {
      const value = await computerRpc("computer.status", {});
      if (!mounted.current || version !== sequence.current) {
        return;
      }

      if (value.status === "stopped") {
        await startComputer();
        return;
      }

      setStatus(value);
    } catch (error) {
      if (mounted.current && version === sequence.current) {
        const message = errorMessage(error);
        setStatus({ status: "error", docker: null, has_data: false, error: message });
      }
    }
  }, [supported, canAutoStart, startComputer]);

  useEffect(() => {
    mounted.current = true;
    if (!supported) {
      booted.current = false;
      sequence.current++;
      setDidStart(false);

      return () => {
        mounted.current = false;
      };
    }

    let active = true;

    const subscription = subscribe((event) => {
      if (!active) {
        return;
      }

      if (event.event === "computer.changed") {
        const next = event.data as ComputerStatus;
        if (next.status !== "starting") {
          sequence.current++;
        }

        setStatus(next);
      } else if (event.event === "core.closed" || event.event === "core.error") {
        sequence.current++;
        booted.current = false;
        setDidStart(false);

        const message = "Reconnect the execution helper.";

        setStatus({
          status: "error",
          docker: null,
          has_data: false,
          error: message,
        });
      } else if (event.event === "runtime.status") {
        const phase = (event.data as { phase?: string })?.phase;
        if (phase === "ready") {
          if (!booted.current) {
            void boot();
          }
        } else if (phase) {
          booted.current = false;
        }
      }
    });

    void subscription
      .then(() => {
        if (active) {
          void boot();
        }
      })
      .catch(() => undefined);

    return () => {
      active = false;
      mounted.current = false;
      void subscription.then((unsubscribe) => unsubscribe()).catch(() => undefined);
    };
  }, [supported, boot]);

  return {
    status: supported ? status : undefined,
    didStart: supported ? didStart : false,
    retry: startComputer,
  };
};
