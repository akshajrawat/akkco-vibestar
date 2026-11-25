import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Monitor, RotateCw } from "lucide-react";
import { DesktopSize, type ComputerRpc } from "../../../core/computers/contracts";
import { Button } from "../../components/ui/button";
import { computerRpc, errorMessage } from "../../lib/api";

type Input = ComputerRpc["computer.desktop.input"]["input"]["input"];

const keyNames: Record<string, string> = {
  Enter: "Return",
  Backspace: "BackSpace",
  Escape: "Escape",
  Tab: "Tab",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  PageUp: "Prior",
  PageDown: "Next",
  " ": "space",
};

// Unmounting a tab releases its lease before the next desktop view can acquire it.
let previousRelease = Promise.resolve<unknown>(undefined);

export const ComputerDesktop = () => {
  const [frame, setFrame] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const controller = useRef<string>(null);
  const pending = useRef(Promise.resolve());
  const moving = useRef(false);
  const queued = useRef(0);

  useEffect(() => {
    const id = crypto.randomUUID();
    const scope = { controller_id: id };
    let active = true;
    let schedule: ReturnType<typeof setTimeout>;

    const load = async () => {
      try {
        const next = await computerRpc("computer.desktop.frame", scope);
        if (active) {
          setFrame(next);
          schedule = setTimeout(() => void load(), 160);
        }
      } catch (reason) {
        if (active) {
          setError(errorMessage(reason));
        }
      }
    };

    const connection = previousRelease
      .then(() => {
        if (active) {
          return computerRpc("computer.desktop.acquire", scope);
        }
      })
      .then(() => {
        if (active) {
          controller.current = id;
          return load();
        }
      })
      .catch((reason) => {
        if (active) {
          setError(errorMessage(reason));
        }
      });

    return () => {
      active = false;
      controller.current = null;
      clearTimeout(schedule);

      previousRelease = connection
        .then(() => computerRpc("computer.desktop.release", scope))
        .catch(() => undefined);
    };
  }, [attempt]);

  const send = (input: Input) => {
    const id = controller.current;
    if (id && (queued.current < 64 || (input.type === "pointer" && input.phase === "up"))) {
      queued.current++;

      pending.current = pending.current
        .then(async () => {
          try {
            if (controller.current === id) {
              await computerRpc("computer.desktop.input", { controller_id: id, input });
            }
          } finally {
            queued.current--;
            if (input.type === "pointer" && input.phase === "move") {
              moving.current = false;
            }
          }
        })
        .catch((reason) => {
          if (controller.current === id) {
            setError(errorMessage(reason));
          }
        });
    }
  };

  const keyboard = (event: KeyboardEvent) => {
    if (!event.ctrlKey && !event.metaKey && !event.altKey && /^[ -~]$/.test(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      send({ type: "text", text: event.key });
      return;
    }

    const key =
      keyNames[event.key] ||
      (/^(?:[a-zA-Z0-9]|F(?:[1-9]|1[0-2]))$/.test(event.key) &&
        (event.key.length === 1 ? event.key.toLowerCase() : event.key));

    if (key) {
      event.preventDefault();
      event.stopPropagation();

      const modified = [
        event.ctrlKey || event.metaKey ? "ctrl" : "",
        event.altKey ? "alt" : "",
        event.shiftKey ? "shift" : "",
        key,
      ];

      send({ type: "key", keys: modified.filter(Boolean).join("+") });
    }
  };

  const pointer = (
    event: { currentTarget: HTMLElement; clientX: number; clientY: number },
    phase: "down" | "up" | "click" | "move",
    button: number,
  ) => {
    const area = event.currentTarget.getBoundingClientRect();

    const x = Math.max(
      0,
      Math.min(
        DesktopSize.width - 1,
        Math.floor(((event.clientX - area.left) * DesktopSize.width) / area.width),
      ),
    );

    const y = Math.max(
      0,
      Math.min(
        DesktopSize.height - 1,
        Math.floor(((event.clientY - area.top) * DesktopSize.height) / area.height),
      ),
    );

    send({ type: "pointer", phase, x, y, button });
  };

  const release = (event: PointerEvent<HTMLButtonElement>) =>
    pointer(event, "up", [1, 2, 3][event.button] || 1);

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <div className="rounded-xl border border-border-default p-4">
          <p role="alert" className="mb-3 text-sm">
            {error}
          </p>
          <Button
            variant="secondary"
            onClick={() => {
              setError("");
              setFrame("");
              setAttempt((value) => value + 1);
            }}
          >
            <RotateCw size={14} /> Reconnect desktop
          </Button>
        </div>
      ) : frame ? (
        <button
          type="button"
          className="overflow-hidden rounded-xl ring-1 ring-border-default p-0 bg-black cursor-crosshair select-none"
          aria-label="Control the Shared Computer desktop"
          onKeyDown={keyboard}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => {
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            pointer(event, "down", [1, 2, 3][event.button] || 1);
          }}
          onPointerUp={release}
          onPointerCancel={release}
          onPointerMove={(event) => {
            if (event.buttons && !moving.current) {
              moving.current = true;
              pointer(event, "move", 1);
            }
          }}
          onWheel={(event) => {
            if (event.deltaY) {
              pointer(event, "click", event.deltaY < 0 ? 4 : 5);
            }
          }}
        >
          <img
            draggable={false}
            className="block w-full"
            src={`data:image/jpeg;base64,${frame}`}
            alt="Live Shared Computer desktop"
          />
        </button>
      ) : (
        <div
          className="grid aspect-[25/16] place-content-center justify-items-center gap-2 rounded-xl border border-border-default bg-surface-hover text-ink-muted"
          role="status"
        >
          <Monitor size={22} /> Connecting desktop…
        </div>
      )}
      {frame && !error && (
        <p className="m-0 text-xs text-ink-muted">
          Click the desktop to use its keyboard and mouse.
        </p>
      )}
    </div>
  );
};
